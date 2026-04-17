// 한국관 서버용 Team Finder 봇 (초경량 / 무조건 새 글 생성 전용)
//
// 동작 원칙
// 1) /팀 실행 시 현재 음성채널 기준으로 모집글을 '항상 새로 생성'
// 2) 이전 모집글 삭제 안 함
// 3) 자동 추적 없음
// 4) 버튼 클릭 처리 없음 (링크 버튼만 사용)
// 5) 개인 안내 메시지 생성 안 함
//
// 중요
// - 이전 글은 남아 있으므로 채널에 모집글이 누적될 수 있음
// - '/팀을 사용함' 같은 디스코드 앱 명령 흔적은 클라이언트 표시라 제거 불가
// - 그 외 개인 확인 메시지는 삭제 시도
//
// .env
// DISCORD_TOKEN=...
// CLIENT_ID=...
// GUILD_ID=...
// RECRUIT_CHANNEL_ID=...

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

// guildId -> recruit text channel cache
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

async function createFreshRecruit({ guild, member, voiceChannel, description }) {
  const recruitTextChannel = await getRecruitTextChannel(guild);

  await recruitTextChannel.send({
    embeds: [buildRecruitEmbed({ member, voiceChannel, description })],
    components: [buildRecruitButtons(guild.id, voiceChannel.id)],
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
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) return;

    const description = interaction.options.getString('설명', true).trim();

    await interaction.deferReply().catch(() => null);
    await createFreshRecruit({ guild, member, voiceChannel, description });
    await interaction.deleteReply().catch(() => null);
  } catch (error) {
    console.error('Interaction 처리 중 오류:', error?.message || error);
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
    console.error('초기 실행 오류:', error?.message || error);
    process.exit(1);
  }
})();
