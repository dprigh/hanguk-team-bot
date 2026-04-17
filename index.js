// 한국관 서버용 Team Finder 봇 (최종 정리 버전)
//
// 목표
// 1) /팀 실행 시 공개 모집 임베드만 남기고, 개인 확인 메시지는 즉시 삭제
// 2) 버튼 클릭 후 '이동했습니다' 같은 개인 안내 메시지 제거
// 3) 버튼은 음성채널 링크 버튼으로 제공
// 4) 자동 상태 추적 제거: /팀 1회 실행 기준으로만 고지
// 5) 기존 모집글이 있으면 같은 메시지를 갱신, 없으면 새로 생성
// 6) 구조 단순화로 최대한 빠르게 동작
//
// 주의
// - 슬래시 명령 사용 흔적(예: '/팀을 사용함' 표기)은 디스코드 클라이언트 표시라 완전 제거 불가
// - 하지만 그 아래 개인 확인 메시지 내용은 삭제 가능
// - 링크 버튼은 채널 링크를 여는 방식이며, 실제 음성 자동 접속을 100% 보장하지 않음
//
// 필수 권한
// - View Channels
// - Send Messages
// - Embed Links
// - Read Message History
// - Use Application Commands
//
// .env 예시
// DISCORD_TOKEN=여기에_봇_토큰
// CLIENT_ID=여기에_앱_CLIENT_ID
// GUILD_ID=여기에_서버_ID
// RECRUIT_CHANNEL_ID=여기에_팀모집_텍스트채널_ID

require('dotenv').config();
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const RECRUIT_CHANNEL_ID = process.env.RECRUIT_CHANNEL_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !RECRUIT_CHANNEL_ID) {
  console.error('환경변수 누락: DISCORD_TOKEN, CLIENT_ID, GUILD_ID, RECRUIT_CHANNEL_ID를 모두 입력하세요.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// userId -> recruit info
const recruitByUser = new Map();
// guildId -> recruit channel cache
const recruitChannelCache = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('팀')
    .setDescription('현재 들어가 있는 음성채널 기준으로 팀 모집글을 생성하거나 갱신합니다.')
    .addStringOption(option =>
      option
        .setName('설명')
        .setDescription('모집 설명을 입력하세요.')
        .setRequired(true)
    ),
];

function isUnknownMessageError(error) {
  return error?.code === 10008 || error?.rawError?.code === 10008;
}

function isMissingAccessError(error) {
  return error?.code === 50001 || error?.rawError?.code === 50001;
}

function buildVoiceChannelLink(guildId, channelId) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

function getVoiceMemberCount(channel) {
  if (!channel?.members) return 0;
  return channel.members.filter(member => !member.user.bot).size;
}

function getVoiceCapacityText(channel) {
  const current = getVoiceMemberCount(channel);
  const max = channel.userLimit && channel.userLimit > 0 ? channel.userLimit : '∞';
  return `${current}명 / ${max}명`;
}

function buildRecruitEmbed({ member, voiceChannel, description }) {
  return new EmbedBuilder()
    .setColor(0x8e44ad)
    .setAuthor({
      name: 'Team Finder',
      iconURL: member.displayAvatarURL(),
    })
    .setTitle('팀원 모집')
    .setDescription(`${member} 님이 팀원 모집 중입니다.`)
    .addFields(
      {
        name: '카테고리',
        value: voiceChannel.parent ? voiceChannel.parent.name : '미분류',
        inline: false,
      },
      {
        name: '채널명',
        value: `<#${voiceChannel.id}>`,
        inline: true,
      },
      {
        name: '멤버',
        value: getVoiceCapacityText(voiceChannel),
        inline: true,
      },
      {
        name: '설명',
        value: description,
        inline: false,
      }
    )
    .setFooter({ text: '한국관 Team Finder' })
    .setTimestamp();
}

function buildRecruitButtons(guildId, channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('바로 입장')
      .setStyle(ButtonStyle.Link)
      .setURL(buildVoiceChannelLink(guildId, channelId))
  );
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  console.log('슬래시 명령 등록 중...');
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands.map(cmd => cmd.toJSON()) }
  );
  console.log('슬래시 명령 등록 완료');
}

async function getRecruitTextChannel(guild) {
  const cached = recruitChannelCache.get(guild.id);
  if (cached) return cached;

  const recruitTextChannel = guild.channels.cache.get(RECRUIT_CHANNEL_ID)
    ?? await guild.channels.fetch(RECRUIT_CHANNEL_ID).catch(() => null);

  if (!recruitTextChannel || !recruitTextChannel.isTextBased()) {
    throw new Error('RECRUIT_CHANNEL_ID가 잘못되었거나 텍스트 채널이 아닙니다.');
  }

  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!botMember) {
    throw new Error('봇 멤버 정보를 불러오지 못했습니다.');
  }

  const perms = recruitTextChannel.permissionsFor(botMember);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) ||
      !perms?.has(PermissionFlagsBits.SendMessages) ||
      !perms?.has(PermissionFlagsBits.EmbedLinks)) {
    throw new Error('모집 채널 권한 부족: ViewChannel / SendMessages / EmbedLinks 권한이 필요합니다.');
  }

  recruitChannelCache.set(guild.id, recruitTextChannel);
  return recruitTextChannel;
}

async function safeFetchMessage(channel, messageId) {
  if (!messageId) return null;
  return channel.messages.fetch(messageId).catch(() => null);
}

async function createRecruitMessage(recruitTextChannel, guild, member, voiceChannel, description) {
  return recruitTextChannel.send({
    embeds: [buildRecruitEmbed({ member, voiceChannel, description })],
    components: [buildRecruitButtons(guild.id, voiceChannel.id)],
  });
}

async function upsertRecruit({ guild, member, voiceChannel, description }) {
  const recruitTextChannel = await getRecruitTextChannel(guild);
  const previous = recruitByUser.get(member.id);

  if (previous) {
    const oldMessage = await safeFetchMessage(recruitTextChannel, previous.messageId);
    if (oldMessage) {
      try {
        await oldMessage.edit({
          embeds: [buildRecruitEmbed({ member, voiceChannel, description })],
          components: [buildRecruitButtons(guild.id, voiceChannel.id)],
        });

        const updated = {
          ...previous,
          guildId: guild.id,
          recruitTextChannelId: recruitTextChannel.id,
          messageId: oldMessage.id,
          voiceChannelId: voiceChannel.id,
          description,
          updatedAt: Date.now(),
        };
        recruitByUser.set(member.id, updated);
        return updated;
      } catch (error) {
        if (!isUnknownMessageError(error)) throw error;
      }
    }
  }

  const newMessage = await createRecruitMessage(recruitTextChannel, guild, member, voiceChannel, description);
  const nextRecruit = {
    guildId: guild.id,
    recruitTextChannelId: recruitTextChannel.id,
    messageId: newMessage.id,
    voiceChannelId: voiceChannel.id,
    description,
    createdAt: previous?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  recruitByUser.set(member.id, nextRecruit);
  return nextRecruit;
}

client.once(Events.ClientReady, readyClient => {
  console.log(`로그인 완료: ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== '팀') return;

    const guild = interaction.guild;
    const member = interaction.member;
    if (!guild || !member || !('voice' in member)) return;

    const voiceChannel = member.voice.channel;
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      // 음성채널에 없으면 별도 안내 없이 조용히 종료
      return;
    }

    const description = interaction.options.getString('설명', true).trim();

    // 디스코드 상호작용 시간 제한 회피용 최소 응답
    await interaction.deferReply().catch(() => null);

    await upsertRecruit({ guild, member, voiceChannel, description });

    // 개인 확인 메시지 제거
    await interaction.deleteReply().catch(() => null);
  } catch (error) {
    if (isMissingAccessError(error)) {
      console.error('권한 부족(Missing Access): 모집 채널 권한을 확인해 주세요.', error.message || error);
    } else {
      console.error('Interaction 처리 중 오류:', error.message || error);
    }

    // 오류 시에도 개인 메시지를 남기지 않음
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferReply().catch(() => null);
      }
      await interaction.deleteReply().catch(() => null);
    } catch {
      // 무시
    }
  }
});

// 자동 상태 추적 제거: /팀 1회 실행 기준으로만 유지

(async () => {
  try {
    await registerCommands();
    await client.login(TOKEN);
  } catch (error) {
    console.error('초기 실행 오류:', error.message || error);
    process.exit(1);
  }
})();
