// 한국관 서버용 Team Finder 봇 (수정 버전)
// 변경 사항
// 1) /팀닫기 제거
// 2) 기존 모집글이 있어도, 현재 들어가 있는 음성채널 기준으로 즉시 덮어쓰기 가능
// 3) 모집 카드의 버튼은 URL 링크 대신 상호작용 버튼으로 변경
// 4) 버튼을 누른 사용자가 이미 다른 음성채널에 들어가 있다면, 봇이 대상 음성채널로 즉시 이동시킴
// 5) 버튼을 누른 사용자가 음성채널에 아예 들어가 있지 않다면, Discord 정책/클라이언트 동작상
//    봇이 사용자를 '자동 접속'시키는 것은 불가하므로 안내 메시지를 표시
//
// 필요 권한
// - View Channels
// - Send Messages
// - Embed Links
// - Read Message History
// - Use Application Commands
// - Move Members   <-- 즉시 이동 기능에 필요
// - Connect        <-- 대상 음성채널로 멤버를 이동시키려면 봇도 대상 채널 연결 권한이 필요
//
// .env 예시
// DISCORD_TOKEN=여기에_봇_토큰
// CLIENT_ID=여기에_앱_CLIENT_ID
// GUILD_ID=여기에_서버_ID
// RECRUIT_CHANNEL_ID=여기에_팀모집_텍스트채널_ID

console.log("ENV CHECK", {
  hasToken: !!process.env.DISCORD_TOKEN,
  hasClientId: !!process.env.CLIENT_ID,
  hasGuildId: !!process.env.GUILD_ID,
  hasRecruitChannelId: !!process.env.RECRUIT_CHANNEL_ID,
});

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
  console.error('환경변수 누락: .env 파일에 DISCORD_TOKEN, CLIENT_ID, GUILD_ID, RECRUIT_CHANNEL_ID를 모두 입력하세요.');
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
// messageId -> userId
const userByMessage = new Map();

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

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    console.log('슬래시 명령 등록 중...');
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands.map(cmd => cmd.toJSON()) }
    );
    console.log('슬래시 명령 등록 완료');
  } catch (error) {
    console.error('슬래시 명령 등록 실패:', error);
    process.exit(1);
  }
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
      .setLabel('바로 입장')
      .setStyle(ButtonStyle.Success)
  );
}

async function upsertRecruit({ guild, member, voiceChannel, description }) {
  const recruitTextChannel = await guild.channels.fetch(RECRUIT_CHANNEL_ID).catch(() => null);
  if (!recruitTextChannel || !recruitTextChannel.isTextBased()) {
    throw new Error('모집 채널 설정이 잘못되었습니다. RECRUIT_CHANNEL_ID를 확인해 주세요.');
  }

  const previous = recruitByUser.get(member.id);
  const embed = buildRecruitEmbed({ member, voiceChannel, description });
  const buttons = buildRecruitButtons(member.id, voiceChannel.id);

  if (previous) {
    const oldMessage = await recruitTextChannel.messages.fetch(previous.messageId).catch(() => null);

    if (oldMessage) {
      await oldMessage.edit({
        embeds: [embed],
        components: [buttons],
      });

      recruitByUser.set(member.id, {
        guildId: guild.id,
        recruitTextChannelId: recruitTextChannel.id,
        messageId: oldMessage.id,
        voiceChannelId: voiceChannel.id,
        description,
        createdAt: previous.createdAt || Date.now(),
        updatedAt: Date.now(),
      });

      userByMessage.set(oldMessage.id, member.id);
      return { mode: 'updated', messageId: oldMessage.id, recruitTextChannelId: recruitTextChannel.id };
    }
  }

  const newMessage = await recruitTextChannel.send({
    embeds: [embed],
    components: [buttons],
  });

  recruitByUser.set(member.id, {
    guildId: guild.id,
    recruitTextChannelId: recruitTextChannel.id,
    messageId: newMessage.id,
    voiceChannelId: voiceChannel.id,
    description,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  userByMessage.set(newMessage.id, member.id);
  return { mode: 'created', messageId: newMessage.id, recruitTextChannelId: recruitTextChannel.id };
}

async function deleteRecruitByUserId(userId, reason = '모집 종료') {
  const recruit = recruitByUser.get(userId);
  if (!recruit) return false;

  try {
    const guild = await client.guilds.fetch(recruit.guildId);
    const channel = await guild.channels.fetch(recruit.recruitTextChannelId);

    if (channel && channel.isTextBased()) {
      const message = await channel.messages.fetch(recruit.messageId).catch(() => null);
      if (message) {
        await message.delete().catch(() => null);
      }
    }
  } catch {
    // 조회 실패 무시
  }

  userByMessage.delete(recruit.messageId);
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

  const ownerStillInside = voiceChannel.members.has(userId);
  if (!ownerStillInside) {
    await deleteRecruitByUserId(userId, '모집자가 채널 이탈');
    return;
  }

  const recruitTextChannel = await guild.channels.fetch(recruit.recruitTextChannelId).catch(() => null);
  if (!recruitTextChannel || !recruitTextChannel.isTextBased()) return;

  const message = await recruitTextChannel.messages.fetch(recruit.messageId).catch(() => null);
  if (!message) {
    await deleteRecruitByUserId(userId, '모집 메시지 없음');
    return;
  }

  const embed = buildRecruitEmbed({
    member,
    voiceChannel,
    description: recruit.description,
  });

  const buttons = buildRecruitButtons(userId, voiceChannel.id);

  await message.edit({
    embeds: [embed],
    components: [buttons],
  }).catch(console.error);
}

client.once(Events.ClientReady, async readyClient => {
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
            ephemeral: true,
          });
          return;
        }

        const voiceChannel = member.voice.channel;
        if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
          await interaction.reply({
            content: '먼저 음성채널에 입장한 뒤 `/팀` 명령어를 사용해 주세요.',
            ephemeral: true,
          });
          return;
        }

        const result = await upsertRecruit({ guild, member, voiceChannel, description });

        await interaction.reply({
          content:
            result.mode === 'created'
              ? `모집글을 등록했습니다.
- 모집 채널: <#${result.recruitTextChannelId}>
- 연결 음성채널: <#${voiceChannel.id}>`
              : `기존 모집글을 현재 음성채널 기준으로 갱신했습니다.
- 모집 채널: <#${result.recruitTextChannelId}>
- 연결 음성채널: <#${voiceChannel.id}>`,
          ephemeral: true,
        });
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('join_voice:')) {
        const [, ownerId, channelId] = interaction.customId.split(':');
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({ content: '서버에서만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (!targetChannel || targetChannel.type !== ChannelType.GuildVoice) {
          await interaction.reply({ content: '대상 음성채널을 찾을 수 없습니다.', ephemeral: true });
          return;
        }

        const botMember = await guild.members.fetchMe();
        const botPerms = targetChannel.permissionsFor(botMember);
        if (!botPerms?.has(PermissionFlagsBits.MoveMembers) || !botPerms?.has(PermissionFlagsBits.Connect)) {
          await interaction.reply({
            content: '봇에 `Move Members`와 `Connect` 권한이 필요합니다.',
            ephemeral: true,
          });
          return;
        }

        const clicker = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!clicker) {
          await interaction.reply({ content: '사용자 정보를 불러오지 못했습니다.', ephemeral: true });
          return;
        }

        if (!clicker.voice?.channel) {
          await interaction.reply({
            content: '현재 어떤 음성채널에도 들어가 있지 않아서 즉시 이동은 불가능합니다. 먼저 아무 음성채널에 한 번 들어온 뒤 버튼을 눌러 주세요.',
            ephemeral: true,
          });
          return;
        }

        const memberPerms = targetChannel.permissionsFor(clicker);
        if (!memberPerms?.has(PermissionFlagsBits.Connect)) {
          await interaction.reply({
            content: '해당 음성채널에 입장할 권한이 없습니다.',
            ephemeral: true,
          });
          return;
        }

        await clicker.voice.setChannel(targetChannel).catch(async error => {
          console.error('즉시 이동 실패:', error);
          await interaction.reply({
            content: '즉시 이동 중 오류가 발생했습니다. 봇 권한과 채널 권한을 확인해 주세요.',
            ephemeral: true,
          }).catch(() => null);
        });

        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: `<@${interaction.user.id}> 님을 <#${targetChannel.id}> 로 이동했습니다.`,
            ephemeral: true,
          });
        }
        return;
      }
    }
  } catch (error) {
    console.error('Interaction 처리 중 오류:', error);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '처리 중 오류가 발생했습니다.',
        ephemeral: true,
      }).catch(() => null);
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const changedUserId = newState.id;

    // 모집자 본인 상태 변화
    if (recruitByUser.has(changedUserId)) {
      const recruit = recruitByUser.get(changedUserId);

      // 다른 음성채널로 옮겼다면 모집글의 대상 채널도 자동으로 갱신
      if (newState.channelId && newState.channelId !== recruit.voiceChannelId) {
        recruit.voiceChannelId = newState.channelId;
        recruit.updatedAt = Date.now();
        recruitByUser.set(changedUserId, recruit);
      }

      await updateRecruitMessage(changedUserId);
    }

    // 해당 채널 인원 변동 반영
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
  await registerCommands();
  await client.login(TOKEN);
})();
