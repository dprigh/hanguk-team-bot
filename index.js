// 한국관 서버용 Team Finder 봇 (단발 고지 + 채널 링크 버튼 버전)
//
// 변경 목표
// 1) /팀 명령을 쓰면 현재 음성채널 기준으로 모집글을 1회 등록/갱신
// 2) 이후 모집자가 음성채널을 옮겨도 자동 추적/자동 수정하지 않음
// 3) 버튼은 '즉시 이동' 기능이 아니라, 해당 음성채널 링크로 연결
//    -> 사용자가 채널명 링크를 누를 때와 같은 방식으로 동작
// 4) /팀 사용 시 불필요한 개인 확인 메시지는 최대한 제거
// 5) /팀닫기 제거 유지
// 6) 기존 모집글이 있으면 새로 만들지 않고 같은 메시지를 갱신
// 7) 기존 메시지가 삭제된 상태면 자동으로 새 메시지 재생성
//
// 참고
// - Discord 특성상 링크 버튼은 채널로 이동/열기 동작이며, 실제 음성 자동 접속을 100% 보장하지는 않음
// - 다만 채널명 링크를 누르는 것과 같은 방향의 UX를 버튼으로 줄 수 있음
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

// userId -> recruit 정보
const recruitByUser = new Map();
// guildId -> recruit text channel cache
const textChannelCache = new Map();

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

function getVoiceMemberCount(channel) {
  if (!channel?.members) return 0;
  return channel.members.filter(member => !member.user.bot).size;
}

function getVoiceCapacityText(channel) {
  const current = getVoiceMemberCount(channel);
  const max = channel.userLimit && channel.userLimit > 0 ? channel.userLimit : '∞';
  return `${current}명 / ${max}명`;
}

function buildVoiceChannelLink(guildId, channelId) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
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
  const cached = textChannelCache.get(guild.id);
  if (cached) return cached;

  const recruitTextChannel = await guild.channels.fetch(RECRUIT_CHANNEL_ID).catch(() => null);
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

  textChannelCache.set(guild.id, recruitTextChannel);
  return recruitTextChannel;
}

async function createRecruitMessage(recruitTextChannel, guild, member, voiceChannel, description) {
  const embed = buildRecruitEmbed({ member, voiceChannel, description });
  const buttons = buildRecruitButtons(guild.id, voiceChannel.id);

  return recruitTextChannel.send({
    embeds: [embed],
    components: [buttons],
  });
}

async function safeFetchMessage(channel, messageId) {
  if (!messageId) return null;
  return channel.messages.fetch(messageId).catch(() => null);
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
        return { mode: 'updated', recruit: updated };
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
  return { mode: previous ? 'recreated' : 'created', recruit: nextRecruit };
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
    const description = interaction.options.getString('설명', true).trim();

    if (!guild || !member || !('voice' in member)) return;

    const voiceChannel = member.voice.channel;
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      // 음성채널에 없으면 조용히 종료
      return;
    }

    // 사용 즉시 상단 응답 흔적을 최소화하기 위해 defer 후 바로 삭제 시도
    await interaction.deferReply({ withResponse: false }).catch(() => null);

    await upsertRecruit({ guild, member, voiceChannel, description });

    if (interaction.deferred || interaction.replied) {
      await interaction.deleteReply().catch(() => null);
    }
  } catch (error) {
    if (isMissingAccessError(error)) {
      console.error('권한 부족(Missing Access): 모집 채널 권한을 확인해 주세요.', error.message || error);
    } else {
      console.error('Interaction 처리 중 오류:', error.message || error);
    }

    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.deferReply({ withResponse: false }).catch(() => null);
        await interaction.deleteReply().catch(() => null);
      }
    } catch {
      // 무시
    }
  }
});

// 자동 상태 추적 기능 제거
// 모집자가 음성채널을 옮겨도 임베드는 자동으로 바뀌지 않음
// 다시 /팀 명령을 써야 새 채널 기준으로 갱신됨

(async () => {
  try {
    await registerCommands();
    await client.login(TOKEN);
  } catch (error) {
    console.error('초기 실행 오류:', error.message || error);
    process.exit(1);
  }
})();
