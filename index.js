// 한국관 서버용 Team Finder 봇 (무조건 새 글 생성형 / 고속 단순 버전)
//
// 설계 방향
// 1) /팀 실행 시 현재 음성채널 기준으로 공개 모집글을 '새로' 생성
// 2) 기존 모집글이 있으면 수정하지 않고 삭제 후 새 글 생성
// 3) 자동 상태 추적 없음
// 4) 버튼은 음성채널 링크 버튼 사용
// 5) 개인 확인 메시지는 즉시 삭제 시도
// 6) 구조를 최대한 단순하게 해서 무료 서버에서도 가볍게 동작하도록 구성
//
// 주의
// - 디스코드 앱 명령 사용 흔적(예: '/팀(을)를 사용함')은 클라이언트 표시라 완전 제거 불가
// - 그 아래 개인 응답 메시지는 삭제 시도
// - 링크 버튼은 채널 링크를 여는 방식이며, 디스코드 클라이언트 환경에 따라 체감 동작이 다를 수 있음
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
  ],
});

// userId -> { guildId, recruitTextChannelId, messageId }
const recruitByUser = new Map();
// guildId -> recruit text channel
const recruitChannelCache = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('팀')
    .setDescription('현재 들어가 있는 음성채널 기준으로 팀 모집글을 새로 생성합니다.')
    .addStringOption(option =>
      option
        .setName('설명')
        .setDescription('모집 설명을 입력하세요.')
        .setRequired(true)
    ),
];

function isMissingAccessError(error) {
  return error?.code === 50001 || error?.rawError?.code === 50001;
}

function buildVoiceChannelLink(guildId, channelId) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

function getVoiceMemberCount(channel) {
  if (!channel?.members) return 0;
  let count = 0;
  for (const [, member] of channel.members) {
    if (!member.user.bot) count += 1;
  }
  return count;
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
      { name: '카테고리', value: voiceChannel.parent?.name ?? '미분류', inline: false },
      { name: '채널명', value: `<#${voiceChannel.id}>`, inline: true },
      { name: '멤버', value: getVoiceCapacityText(voiceChannel), inline: true },
      { name: '설명', value: description, inline: false },
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

  const channel = guild.channels.cache.get(RECRUIT_CHANNEL_ID)
    ?? await guild.channels.fetch(RECRUIT_CHANNEL_ID).catch(() => null);

  if (!channel || !channel.isTextBased()) {
    throw new Error('RECRUIT_CHANNEL_ID가 잘못되었거나 텍스트 채널이 아닙니다.');
  }

  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!botMember) {
    throw new Error('봇 멤버 정보를 불러오지 못했습니다.');
  }

  const perms = channel.permissionsFor(botMember);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) ||
      !perms?.has(PermissionFlagsBits.SendMessages) ||
      !perms?.has(PermissionFlagsBits.EmbedLinks)) {
    throw new Error('모집 채널 권한 부족: ViewChannel / SendMessages / EmbedLinks 권한이 필요합니다.');
  }

  recruitChannelCache.set(guild.id, channel);
  return channel;
}

async function deletePreviousRecruit(userId) {
  const previous = recruitByUser.get(userId);
  if (!previous) return;

  recruitByUser.delete(userId);

  try {
    const guild = client.guilds.cache.get(previous.guildId);
    if (!guild) return;

    const channel = guild.channels.cache.get(previous.recruitTextChannelId)
      ?? await guild.channels.fetch(previous.recruitTextChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const message = await channel.messages.fetch(previous.messageId).catch(() => null);
    if (message) {
      await message.delete().catch(() => null);
    }
  } catch {
    // 기존 글 삭제 실패는 조용히 무시
  }
}

async function createFreshRecruit({ guild, member, voiceChannel, description }) {
  const recruitTextChannel = await getRecruitTextChannel(guild);

  await deletePreviousRecruit(member.id);

  const message = await recruitTextChannel.send({
    embeds: [buildRecruitEmbed({ member, voiceChannel, description })],
    components: [buildRecruitButtons(guild.id, voiceChannel.id)],
  });

  recruitByUser.set(member.id, {
    guildId: guild.id,
    recruitTextChannelId: recruitTextChannel.id,
    messageId: message.id,
  });
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
      return;
    }

    const description = interaction.options.getString('설명', true).trim();

    // 상호작용 만료 방지용 최소 응답 후 바로 삭제
    await interaction.deferReply().catch(() => null);

    await createFreshRecruit({ guild, member, voiceChannel, description });

    await interaction.deleteReply().catch(() => null);
  } catch (error) {
    if (isMissingAccessError(error)) {
      console.error('권한 부족(Missing Access): 모집 채널 권한을 확인해 주세요.', error.message || error);
    } else {
      console.error('Interaction 처리 중 오류:', error.message || error);
    }

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

(async () => {
  try {
    await registerCommands();
    await client.login(TOKEN);
  } catch (error) {
    console.error('초기 실행 오류:', error.message || error);
    process.exit(1);
  }
})();
