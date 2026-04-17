// 한국관 서버용 Team Finder 봇 (속도 최적화 + 안내 메시지 최소화 버전)
//
// 목표
// 1) /팀 사용 시 개인에게만 보이는 확인 메시지(ephemeral) 제거
// 2) 불필요한 fetch 최소화
// 3) 메시지 수정/재생성 로직 단순화
// 4) VoiceStateUpdate 디바운스 적용으로 과도한 API 호출 방지
// 5) 기존 모집글이 없으면 자동 재생성
// 6) 버튼 클릭 시:
//    - 이미 음성채널에 있는 사람은 즉시 이동
//    - 음성채널 미접속자는 자동 접속 불가 (Discord 한계)
//      -> 별도 메시지 없이 조용히 무시하지 않고, 최소한의 짧은 안내만 표시
//
// 필수 권한
// - View Channels
// - Send Messages
// - Embed Links
// - Read Message History
// - Use Application Commands
// - Connect
// - Move Members
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
// userId -> debounce timeout
const updateTimers = new Map();
// 단순 채널 캐시
const textChannelCache = new Map(); // guildId -> channel

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

function buildRecruitButtons(ownerId, channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_voice:${ownerId}:${channelId}`)
      .setLabel('바로 참가')
      .setStyle(ButtonStyle.Success)
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

async function createRecruitMessage(recruitTextChannel, member, voiceChannel, description) {
  const embed = buildRecruitEmbed({ member, voiceChannel, description });
  const buttons = buildRecruitButtons(member.id, voiceChannel.id);

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
          components: [buildRecruitButtons(member.id, voiceChannel.id)],
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

  const newMessage = await createRecruitMessage(recruitTextChannel, member, voiceChannel, description);
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

async function deleteRecruitByUserId(userId, reason = '모집 종료') {
  const recruit = recruitByUser.get(userId);
  if (!recruit) return false;

  recruitByUser.delete(userId);
  const timer = updateTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    updateTimers.delete(userId);
  }

  try {
    const guild = client.guilds.cache.get(recruit.guildId) ?? await client.guilds.fetch(recruit.guildId);
    const channel = guild.channels.cache.get(recruit.recruitTextChannelId) ?? await guild.channels.fetch(recruit.recruitTextChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const message = await safeFetchMessage(channel, recruit.messageId);
      if (message) await message.delete().catch(() => null);
    }
  } catch {
    // 조용히 무시
  }

  console.log(`[모집 삭제] user=${userId}, reason=${reason}`);
  return true;
}

async function updateRecruitMessage(userId) {
  const recruit = recruitByUser.get(userId);
  if (!recruit) return;

  const guild = client.guilds.cache.get(recruit.guildId) ?? await client.guilds.fetch(recruit.guildId).catch(() => null);
  if (!guild) return;

  const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    await deleteRecruitByUserId(userId, '멤버 조회 실패');
    return;
  }

  const voiceChannel = guild.channels.cache.get(recruit.voiceChannelId) ?? await guild.channels.fetch(recruit.voiceChannelId).catch(() => null);
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await deleteRecruitByUserId(userId, '음성채널 없음');
    return;
  }

  if (!voiceChannel.members.has(userId)) {
    await deleteRecruitByUserId(userId, '모집자가 채널 이탈');
    return;
  }

  const recruitTextChannel = await getRecruitTextChannel(guild).catch(error => {
    console.error('모집 채널 조회 오류:', error.message);
    return null;
  });
  if (!recruitTextChannel) return;

  const message = await safeFetchMessage(recruitTextChannel, recruit.messageId);
  if (!message) {
    const newMessage = await createRecruitMessage(recruitTextChannel, member, voiceChannel, recruit.description).catch(error => {
      console.error('모집 메시지 재생성 실패:', error.message || error);
      return null;
    });

    if (!newMessage) return;
    recruit.messageId = newMessage.id;
    recruit.updatedAt = Date.now();
    recruitByUser.set(userId, recruit);
    return;
  }

  try {
    await message.edit({
      embeds: [buildRecruitEmbed({ member, voiceChannel, description: recruit.description })],
      components: [buildRecruitButtons(userId, voiceChannel.id)],
    });
  } catch (error) {
    if (isUnknownMessageError(error)) {
      const newMessage = await createRecruitMessage(recruitTextChannel, member, voiceChannel, recruit.description).catch(() => null);
      if (newMessage) {
        recruit.messageId = newMessage.id;
        recruit.updatedAt = Date.now();
        recruitByUser.set(userId, recruit);
      }
      return;
    }
    console.error('모집 메시지 수정 실패:', error.message || error);
  }
}

function scheduleRecruitUpdate(userId, delay = 700) {
  const prevTimer = updateTimers.get(userId);
  if (prevTimer) clearTimeout(prevTimer);

  const timer = setTimeout(async () => {
    updateTimers.delete(userId);
    await updateRecruitMessage(userId).catch(error => {
      console.error('디바운스 업데이트 실패:', error.message || error);
    });
  }, delay);

  updateTimers.set(userId, timer);
}

client.once(Events.ClientReady, readyClient => {
  console.log(`로그인 완료: ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === '팀') {
        const guild = interaction.guild;
        const member = interaction.member;
        const description = interaction.options.getString('설명', true).trim();

        if (!guild || !member || !('voice' in member)) return;

        const voiceChannel = member.voice.channel;
        if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
          // 개인 메시지조차 생략하여 최대한 조용하게 처리
          return;
        }

        // 사용자가 기다리는 체감 시간을 줄이기 위해 먼저 defer
        await interaction.deferReply({ withResponse: false }).catch(() => null);

        await upsertRecruit({ guild, member, voiceChannel, description });

        // 최종 개인 확인 메시지도 없애기 위해 deleteReply 시도
        if (interaction.deferred || interaction.replied) {
          await interaction.deleteReply().catch(() => null);
        }
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('join_voice:')) {
        const [, , channelId] = interaction.customId.split(':');
        const guild = interaction.guild;
        if (!guild) return;

        const targetChannel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
        if (!targetChannel || targetChannel.type !== ChannelType.GuildVoice) return;

        const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
        const botPerms = targetChannel.permissionsFor(botMember);
        if (!botPerms?.has(PermissionFlagsBits.MoveMembers) || !botPerms?.has(PermissionFlagsBits.Connect)) {
          return;
        }

        const clicker = guild.members.cache.get(interaction.user.id) ?? await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!clicker) return;

        const memberPerms = targetChannel.permissionsFor(clicker);
        if (!memberPerms?.has(PermissionFlagsBits.Connect)) return;

        // 음성채널 미접속자는 Discord 한계상 즉시 접속 불가
        if (!clicker.voice?.channel) {
          // 최소 안내만 남기고 끝냄
          await interaction.reply({
            content: `직접 입장해 주세요: <#${targetChannel.id}>`,
            withResponse: false,
          }).catch(() => null);
          return;
        }

        await clicker.voice.setChannel(targetChannel).catch(() => null);

        // 이동 성공 후 굳이 개인 메시지를 남기지 않음
        if (!interaction.replied && !interaction.deferred) {
          await interaction.deferUpdate().catch(() => null);
        }
        return;
      }
    }
  } catch (error) {
    if (isMissingAccessError(error)) {
      console.error('권한 부족(Missing Access): 채널 권한을 확인해 주세요.', error.message || error);
    } else {
      console.error('Interaction 처리 중 오류:', error.message || error);
    }

    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.deferUpdate().catch(() => null);
      }
    } catch {
      // 무시
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const changedUserId = newState.id;

    if (recruitByUser.has(changedUserId)) {
      const recruit = recruitByUser.get(changedUserId);

      if (newState.channelId && newState.channelId !== recruit.voiceChannelId) {
        recruit.voiceChannelId = newState.channelId;
        recruit.updatedAt = Date.now();
        recruitByUser.set(changedUserId, recruit);
      }

      scheduleRecruitUpdate(changedUserId);
    }

    const relatedChannelIds = new Set();
    if (oldState.channelId) relatedChannelIds.add(oldState.channelId);
    if (newState.channelId) relatedChannelIds.add(newState.channelId);

    for (const [userId, recruit] of recruitByUser.entries()) {
      if (relatedChannelIds.has(recruit.voiceChannelId)) {
        scheduleRecruitUpdate(userId);
      }
    }
  } catch (error) {
    console.error('VoiceStateUpdate 처리 오류:', error.message || error);
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
