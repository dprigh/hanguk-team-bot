// 한국관 서버용 Team Finder 봇 (안정화 버전)
//
// 핵심 변경 사항
// 1) /팀닫기 제거
// 2) /팀 재입력 시 기존 모집글이 있더라도 현재 음성채널 기준으로 즉시 갱신
// 3) 기존 모집 메시지가 삭제되었거나 찾을 수 없으면 자동으로 새 메시지를 다시 생성
// 4) 권한 부족(Missing Access)과 메시지 없음(Unknown Message) 상황을 보다 안전하게 처리
// 5) ephemeral 경고 제거: flags 사용
// 6) 버튼 동작:
//    - 이미 어떤 음성채널에 들어가 있는 사용자는 즉시 대상 채널로 이동
//    - 음성채널에 전혀 접속하지 않은 사용자는 Discord 정책/동작상 봇이 '즉시 접속'시킬 수 없음
//      -> 대신 대상 채널 멘션을 안내
//
// 꼭 필요한 봇 권한
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
  MessageFlags,
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

const commands = [
  new SlashCommandBuilder()
    .setName('팀')
    .setDescription('현재 들어가 있는 음성채널 기준으로 팀 모집글을 생성하거나 갱신합니다.')
    .addStringOption(option =>
      option
        .setName('설명')
        .setDescription('모집 설명을 입력하세요. 예: 크랩 로테 배린이들 구인합니다')
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
  if (!channel || !channel.members) return 0;
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
  const recruitTextChannel = await guild.channels.fetch(RECRUIT_CHANNEL_ID).catch(() => null);
  if (!recruitTextChannel || !recruitTextChannel.isTextBased()) {
    throw new Error('RECRUIT_CHANNEL_ID가 잘못되었거나 텍스트 채널이 아닙니다.');
  }

  const botMember = await guild.members.fetchMe().catch(() => null);
  if (!botMember) {
    throw new Error('봇 멤버 정보를 불러오지 못했습니다.');
  }

  const perms = recruitTextChannel.permissionsFor(botMember);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) ||
      !perms?.has(PermissionFlagsBits.SendMessages) ||
      !perms?.has(PermissionFlagsBits.EmbedLinks)) {
    throw new Error('모집 채널 권한 부족: ViewChannel / SendMessages / EmbedLinks 권한이 필요합니다.');
  }

  return recruitTextChannel;
}

async function createRecruitMessage(recruitTextChannel, member, voiceChannel, description) {
  const embed = buildRecruitEmbed({ member, voiceChannel, description });
  const buttons = buildRecruitButtons(member.id, voiceChannel.id);

  const newMessage = await recruitTextChannel.send({
    embeds: [embed],
    components: [buttons],
  });

  return newMessage;
}

async function upsertRecruit({ guild, member, voiceChannel, description }) {
  const recruitTextChannel = await getRecruitTextChannel(guild);
  const previous = recruitByUser.get(member.id);

  // 기존 글이 있으면 우선 수정 시도
  if (previous) {
    const embed = buildRecruitEmbed({ member, voiceChannel, description });
    const buttons = buildRecruitButtons(member.id, voiceChannel.id);

    const oldMessage = await recruitTextChannel.messages.fetch(previous.messageId).catch(() => null);

    if (oldMessage) {
      try {
        await oldMessage.edit({
          embeds: [embed],
          components: [buttons],
        });

        recruitByUser.set(member.id, {
          ...previous,
          guildId: guild.id,
          recruitTextChannelId: recruitTextChannel.id,
          messageId: oldMessage.id,
          voiceChannelId: voiceChannel.id,
          description,
          updatedAt: Date.now(),
        });

        return { mode: 'updated', messageId: oldMessage.id, recruitTextChannelId: recruitTextChannel.id };
      } catch (error) {
        if (!isUnknownMessageError(error)) {
          throw error;
        }
        // 메시지가 사라졌으면 아래에서 새로 생성
      }
    }
  }

  // 기존 메시지가 없거나 삭제되었으면 새로 생성
  const newMessage = await createRecruitMessage(recruitTextChannel, member, voiceChannel, description);

  recruitByUser.set(member.id, {
    guildId: guild.id,
    recruitTextChannelId: recruitTextChannel.id,
    messageId: newMessage.id,
    voiceChannelId: voiceChannel.id,
    description,
    createdAt: previous?.createdAt || Date.now(),
    updatedAt: Date.now(),
  });

  return { mode: previous ? 'recreated' : 'created', messageId: newMessage.id, recruitTextChannelId: recruitTextChannel.id };
}

async function deleteRecruitByUserId(userId, reason = '모집 종료') {
  const recruit = recruitByUser.get(userId);
  if (!recruit) return false;

  try {
    const guild = await client.guilds.fetch(recruit.guildId);
    const channel = await guild.channels.fetch(recruit.recruitTextChannelId).catch(() => null);

    if (channel && channel.isTextBased()) {
      const message = await channel.messages.fetch(recruit.messageId).catch(() => null);
      if (message) {
        await message.delete().catch(() => null);
      }
    }
  } catch {
    // 무시
  }

  recruitByUser.delete(userId);
  console.log(`[모집 삭제] user=${userId}, reason=${reason}`);
  return true;
}

async function updateRecruitMessage(userId) {
  const recruit = recruitByUser.get(userId);
  if (!recruit) return;

  const guild = await client.guilds.fetch(recruit.guildId).catch(() => null);
  if (!guild) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    await deleteRecruitByUserId(userId, '멤버 조회 실패');
    return;
  }

  const voiceChannel = await guild.channels.fetch(recruit.voiceChannelId).catch(() => null);
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await deleteRecruitByUserId(userId, '음성채널 없음');
    return;
  }

  // 모집자가 채널을 떠났으면 자동 종료
  if (!voiceChannel.members.has(userId)) {
    await deleteRecruitByUserId(userId, '모집자가 채널 이탈');
    return;
  }

  const recruitTextChannel = await getRecruitTextChannel(guild).catch(error => {
    console.error('모집 채널 권한/조회 오류:', error.message);
    return null;
  });
  if (!recruitTextChannel) return;

  const message = await recruitTextChannel.messages.fetch(recruit.messageId).catch(() => null);
  if (!message) {
    // 메시지가 사라졌으면 자동 재생성
    const newMessage = await createRecruitMessage(recruitTextChannel, member, voiceChannel, recruit.description).catch(error => {
      console.error('모집 메시지 재생성 실패:', error);
      return null;
    });

    if (!newMessage) return;

    recruit.messageId = newMessage.id;
    recruit.updatedAt = Date.now();
    recruitByUser.set(userId, recruit);
    return;
  }

  const embed = buildRecruitEmbed({ member, voiceChannel, description: recruit.description });
  const buttons = buildRecruitButtons(userId, voiceChannel.id);

  try {
    await message.edit({
      embeds: [embed],
      components: [buttons],
    });
  } catch (error) {
    if (isUnknownMessageError(error)) {
      const newMessage = await createRecruitMessage(recruitTextChannel, member, voiceChannel, recruit.description).catch(err => {
        console.error('Unknown Message 이후 재생성 실패:', err);
        return null;
      });

      if (newMessage) {
        recruit.messageId = newMessage.id;
        recruit.updatedAt = Date.now();
        recruitByUser.set(userId, recruit);
      }
      return;
    }

    console.error('모집 메시지 수정 실패:', error);
  }
}

client.once(Events.ClientReady, readyClient => {
  console.log(`로그인 완료: ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === '팀') {
        const description = interaction.options.getString('설명', true).trim();
        const guild = interaction.guild;
        const member = interaction.member;

        if (!guild || !member || !('voice' in member)) {
          await interaction.reply({
            content: '서버 내부에서만 사용할 수 있습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const voiceChannel = member.voice.channel;
        if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
          await interaction.reply({
            content: '먼저 음성채널에 입장한 뒤 `/팀` 명령어를 사용해 주세요.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const result = await upsertRecruit({ guild, member, voiceChannel, description });

        let replyText = `모집 채널: <#${result.recruitTextChannelId}>
연결 음성채널: <#${voiceChannel.id}>`;
        if (result.mode === 'created') replyText = `모집글을 등록했습니다.
${replyText}`;
        if (result.mode === 'updated') replyText = `기존 모집글을 갱신했습니다.
${replyText}`;
        if (result.mode === 'recreated') replyText = `기존 모집글이 없어 새로 다시 만들었습니다.
${replyText}`;

        await interaction.reply({
          content: replyText,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('join_voice:')) {
        const [, ownerId, channelId] = interaction.customId.split(':');
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: '서버에서만 사용할 수 있습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (!targetChannel || targetChannel.type !== ChannelType.GuildVoice) {
          await interaction.reply({
            content: '대상 음성채널을 찾을 수 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const botMember = await guild.members.fetchMe().catch(() => null);
        const botPerms = targetChannel.permissionsFor(botMember);
        if (!botPerms?.has(PermissionFlagsBits.MoveMembers) || !botPerms?.has(PermissionFlagsBits.Connect)) {
          await interaction.reply({
            content: '봇에 `Move Members`와 `Connect` 권한이 필요합니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const clicker = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!clicker) {
          await interaction.reply({
            content: '사용자 정보를 불러오지 못했습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const memberPerms = targetChannel.permissionsFor(clicker);
        if (!memberPerms?.has(PermissionFlagsBits.Connect)) {
          await interaction.reply({
            content: '해당 음성채널에 입장할 권한이 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Discord 제약상 음성채널에 아예 미접속인 사용자를 봇이 '즉시 접속'시키는 것은 불가
        if (!clicker.voice?.channel) {
          await interaction.reply({
            content: `현재 어떤 음성채널에도 들어가 있지 않아 즉시 이동은 불가능합니다.
대상 채널로 직접 들어가 주세요: <#${targetChannel.id}>`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await clicker.voice.setChannel(targetChannel);
        await interaction.reply({
          content: `<@${interaction.user.id}> 님을 <#${targetChannel.id}> 로 이동했습니다.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
  } catch (error) {
    if (isMissingAccessError(error)) {
      console.error('권한 부족(Missing Access): 모집 채널 또는 대상 채널 권한을 확인해 주세요.', error);
    } else {
      console.error('Interaction 처리 중 오류:', error);
    }

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '처리 중 오류가 발생했습니다. 봇 권한과 모집 채널 설정을 확인해 주세요.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const changedUserId = newState.id;

    // 모집자 본인의 채널 이동을 자동 추적
    if (recruitByUser.has(changedUserId)) {
      const recruit = recruitByUser.get(changedUserId);

      if (newState.channelId && newState.channelId !== recruit.voiceChannelId) {
        recruit.voiceChannelId = newState.channelId;
        recruit.updatedAt = Date.now();
        recruitByUser.set(changedUserId, recruit);
      }

      await updateRecruitMessage(changedUserId);
    }

    // 관련 채널 인원 수 갱신
    const relatedChannelIds = new Set();
    if (oldState.channelId) relatedChannelIds.add(oldState.channelId);
    if (newState.channelId) relatedChannelIds.add(newState.channelId);

    for (const [userId, recruit] of recruitByUser.entries()) {
      if (relatedChannelIds.has(recruit.voiceChannelId)) {
        await updateRecruitMessage(userId);
      }
    }
  } catch (error) {
    console.error('VoiceStateUpdate 처리 오류:', error);
  }
});

(async () => {
  try {
    await registerCommands();
    await client.login(TOKEN);
  } catch (error) {
    console.error('초기 실행 오류:', error);
    process.exit(1);
  }
})();
