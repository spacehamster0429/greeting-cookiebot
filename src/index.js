"use strict";

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 우주햄찌

const fs = require("fs");
const path = require("path");

const Database = require("better-sqlite3");
const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");
const dotenv = require("dotenv");

const BASE_DIR = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(BASE_DIR, ".env"), quiet: true });

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = parseOwnerId(process.env.OWNER_ID);
const DB_PATH = resolveDbPath(process.env.COOKIEBOT_DB_PATH);

const MAX_TEMPLATE_LENGTH = 1500;
const DISCORD_MESSAGE_LIMIT = 2000;

const DEFAULT_JOIN_MESSAGE =
  "{member}님, {guild}에 오신 것을 환영합니다! 현재 {member_count}명이 함께하고 있어요.";
const DEFAULT_LEAVE_MESSAGE = "{username}님이 서버에서 나갔습니다. 좋은 인연으로 다시 만나요.";
const GENERIC_ERROR_MESSAGE = "오류가 발생했어요. 서버 관리자 혹은 봇 관리자에게 문의해주세요.";

const PLACEHOLDER_DESCRIPTIONS = [
  ["{member}", "입장/퇴장한 유저 멘션"],
  ["{username}", "유저 계정 이름"],
  ["{displayname}", "서버에서 보이는 닉네임"],
  ["{guild}", "서버 이름"],
  ["{channel}", "인사 메시지를 보내는 채널"],
  ["{member_count}", "현재 서버 인원 수"],
  ["{account_created}", "유저 계정 생성일"],
  ["{account_age_days}", "계정 생성 후 지난 일수"],
];

const PLACEHOLDER_HELP = PLACEHOLDER_DESCRIPTIONS
  .map(([name, description]) => `- ${name}: ${description}`)
  .join("\n");

const CONFIG_COLUMNS = new Set([
  "join_channel_id",
  "leave_channel_id",
  "join_message",
  "leave_message",
  "join_enabled",
  "leave_enabled",
]);

const LEGACY_AI_TABLES = ["ai_settings", "messages", "call_count", "users", "deleted_users"];

function timestamp() {
  return new Date().toISOString();
}

function log(level, message, meta = undefined) {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[${timestamp()}] [${level.toUpperCase()}] cookiebot: ${message}${suffix}`);
}

function logError(message, error, meta = undefined) {
  log("error", message, meta);
  if (error && error.stack) {
    console.error(error.stack);
  } else if (error) {
    console.error(error);
  }
}

function parseOwnerId(value) {
  if (!value) {
    return "0";
  }
  if (!/^\d+$/.test(value)) {
    log("warn", "OWNER_ID 값이 숫자가 아니어서 봇 관리자 알림 DM이 비활성화됩니다.");
    return "0";
  }
  return value;
}

function resolveDbPath(value) {
  if (!value) {
    return path.join(BASE_DIR, "cookiebot.db");
  }
  const expanded = value.startsWith("~") ? path.join(process.env.HOME || BASE_DIR, value.slice(1)) : value;
  return path.isAbsolute(expanded) ? expanded : path.join(BASE_DIR, expanded);
}

function ensureDirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

ensureDirFor(DB_PATH);
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

function restrictDbFilePermissions() {
  for (const filePath of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      log("warn", `DB 파일 권한 제한 실패: ${path.basename(filePath)}`);
    }
  }
}

restrictDbFilePermissions();

function getTableColumns(tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function addColumnIfMissing(tableName, columnName, ddl) {
  if (!getTableColumns(tableName).has(columnName)) {
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${ddl}`).run();
  }
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS configs (
      guild_id TEXT PRIMARY KEY,
      join_channel_id TEXT,
      leave_channel_id TEXT,
      join_message TEXT,
      leave_message TEXT,
      join_enabled INTEGER NOT NULL DEFAULT 1,
      leave_enabled INTEGER NOT NULL DEFAULT 1
    )
  `);

  addColumnIfMissing("configs", "join_enabled", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("configs", "leave_enabled", "INTEGER NOT NULL DEFAULT 1");

  for (const tableName of LEGACY_AI_TABLES) {
    db.prepare(`DROP TABLE IF EXISTS ${tableName}`).run();
  }
  restrictDbFilePermissions();
}

function isServerRegistered(guildId) {
  if (!guildId) {
    return false;
  }
  return Boolean(db.prepare("SELECT guild_id FROM configs WHERE guild_id = ?").get(String(guildId)));
}

function getRegisteredServerCount() {
  const row = db.prepare("SELECT COUNT(*) AS count FROM configs").get();
  return Number(row?.count || 0);
}

function createServerConfig(guildId, { joinChannelId = null, leaveChannelId = null } = {}) {
  db.prepare(`
    INSERT OR IGNORE INTO configs (
      guild_id,
      join_channel_id,
      leave_channel_id,
      join_message,
      leave_message,
      join_enabled,
      leave_enabled
    )
    VALUES (?, ?, ?, ?, ?, 1, 1)
  `).run(
    String(guildId),
    joinChannelId ? String(joinChannelId) : null,
    leaveChannelId ? String(leaveChannelId) : null,
    DEFAULT_JOIN_MESSAGE,
    DEFAULT_LEAVE_MESSAGE,
  );
}

function getConfig(guildId) {
  const row = db.prepare(`
    SELECT join_channel_id, leave_channel_id, join_message, leave_message, join_enabled, leave_enabled
    FROM configs
    WHERE guild_id = ?
  `).get(String(guildId));

  if (!row) {
    return null;
  }

  return {
    join_channel_id: row.join_channel_id ?? null,
    leave_channel_id: row.leave_channel_id ?? null,
    join_message: row.join_message || DEFAULT_JOIN_MESSAGE,
    leave_message: row.leave_message || DEFAULT_LEAVE_MESSAGE,
    join_enabled: row.join_enabled ?? 1,
    leave_enabled: row.leave_enabled ?? 1,
  };
}

function updateConfig(guildId, fields) {
  const keys = Object.keys(fields);
  for (const key of keys) {
    if (!CONFIG_COLUMNS.has(key)) {
      throw new Error(`Invalid config field: ${key}`);
    }
  }
  if (keys.length === 0) {
    return;
  }

  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  const values = keys.map((key) => {
    const value = fields[key];
    return key.endsWith("_channel_id") && value !== null && value !== undefined ? String(value) : value;
  });
  db.prepare(`UPDATE configs SET ${assignments} WHERE guild_id = ?`).run(...values, String(guildId));
}

function deleteGuildData(guildId) {
  db.prepare("DELETE FROM configs WHERE guild_id = ?").run(String(guildId));
}

function isAdmin(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));
}

function channelLabel(channelId) {
  return channelId ? `<#${channelId}>` : "미설정";
}

function enabledLabel(value) {
  return value ? "켜짐" : "꺼짐";
}

function neutralizeMassMentions(text) {
  return text.replaceAll("@everyone", "@ everyone").replaceAll("@here", "@ here");
}

function truncateDiscordMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
  if (text.length <= limit) {
    return text;
  }
  const suffix = "\n... (메시지가 길어 잘렸습니다)";
  return `${text.slice(0, limit - suffix.length).trimEnd()}${suffix}`;
}

function formatAccountAge(member) {
  const createdAt = member.user.createdAt;
  const days = Math.max(Math.floor((Date.now() - createdAt.getTime()) / 86_400_000), 0);
  return String(days);
}

function formatDiscordDate(date) {
  return `<t:${Math.floor(date.getTime() / 1000)}:D>`;
}

function formatTemplate(template, member, channel, guild) {
  const values = {
    "{member}": `<@${member.id}>`,
    "{username}": member.user.username,
    "{displayname}": member.displayName || member.user.username,
    "{guild}": guild.name,
    "{channel}": channel ? `<#${channel.id}>` : "미설정",
    "{member_count}": String(guild.memberCount || 0),
    "{account_created}": formatDiscordDate(member.user.createdAt),
    "{account_age_days}": formatAccountAge(member),
  };

  let content = template || DEFAULT_JOIN_MESSAGE;
  for (const [placeholder, value] of Object.entries(values)) {
    content = content.replaceAll(placeholder, value);
  }
  return truncateDiscordMessage(neutralizeMassMentions(content));
}

function getConfiguredChannel(guild, channelId) {
  if (!channelId) {
    return null;
  }

  const parsedId = String(channelId);
  if (!/^\d+$/.test(parsedId)) {
    log("warn", "잘못된 채널 ID가 설정되어 있습니다.", { guild: guild.id, channelId });
    return null;
  }

  const channel = guild.channels.cache.get(parsedId) || client.channels.cache.get(parsedId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    return null;
  }
  if (channel.guild.id !== guild.id) {
    log("warn", "다른 서버 채널 ID가 설정되어 무시합니다.", { guild: guild.id, channel: parsedId });
    return null;
  }
  return channel;
}

function botCanSend(channel) {
  const me = channel.guild.members.me;
  if (!me) {
    return false;
  }
  const permissions = channel.permissionsFor(me);
  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel)
      && permissions?.has(PermissionFlagsBits.SendMessages),
  );
}

function pickDefaultGreetingChannels(guild) {
  const channels = [...guild.channels.cache.values()]
    .filter((channel) => channel.type === ChannelType.GuildText)
    .sort((a, b) => (a.rawPosition - b.rawPosition) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    .filter((channel) => botCanSend(channel));

  if (channels.length === 0) {
    return [null, null];
  }
  return [channels[0], channels[1] || channels[0]];
}

function describeDefaultChannels(joinChannel, leaveChannel) {
  const joinLabel = joinChannel ? `<#${joinChannel.id}>` : "자동 설정 실패";
  const leaveLabel = leaveChannel ? `<#${leaveChannel.id}>` : "자동 설정 실패";
  return `입장 인사 채널: ${joinLabel}\n퇴장 인사 채널: ${leaveLabel}`;
}

function ensureGreetingDefaultsForGuild(guild) {
  const config = getConfig(guild.id);
  if (!config) {
    return null;
  }

  const [defaultJoinChannel, defaultLeaveChannel] = pickDefaultGreetingChannels(guild);
  const updates = {
    join_message: config.join_message || DEFAULT_JOIN_MESSAGE,
    leave_message: config.leave_message || DEFAULT_LEAVE_MESSAGE,
    join_enabled: config.join_enabled ?? 1,
    leave_enabled: config.leave_enabled ?? 1,
  };

  if (!getConfiguredChannel(guild, config.join_channel_id) && defaultJoinChannel) {
    updates.join_channel_id = defaultJoinChannel.id;
  }
  if (!getConfiguredChannel(guild, config.leave_channel_id) && defaultLeaveChannel) {
    updates.leave_channel_id = defaultLeaveChannel.id;
  }

  updateConfig(guild.id, updates);
  const refreshed = getConfig(guild.id);
  log("info", "인사 기본 설정 확인 완료.", {
    guild: guild.id,
    join_enabled: refreshed.join_enabled,
    join_channel: refreshed.join_channel_id,
    leave_enabled: refreshed.leave_enabled,
    leave_channel: refreshed.leave_channel_id,
  });
  return refreshed;
}

function validateTemplate(template) {
  if (!template.trim()) {
    return "메시지는 비워둘 수 없습니다.";
  }
  if (template.length > MAX_TEMPLATE_LENGTH) {
    return `메시지는 ${MAX_TEMPLATE_LENGTH}자 이하로 설정해주세요.`;
  }
  return null;
}

function buildConfigEmbed(guild, config) {
  return new EmbedBuilder()
    .setTitle("쿠키봇 인사 설정")
    .setDescription("서버 입장/퇴장 인사 설정입니다.")
    .setColor(0x1976D2)
    .addFields(
      {
        name: "입장 인사",
        value: [
          `상태: ${enabledLabel(config.join_enabled)}`,
          `채널: ${channelLabel(config.join_channel_id)}`,
          `메시지: ${config.join_message || DEFAULT_JOIN_MESSAGE}`,
        ].join("\n"),
      },
      {
        name: "퇴장 인사",
        value: [
          `상태: ${enabledLabel(config.leave_enabled)}`,
          `채널: ${channelLabel(config.leave_channel_id)}`,
          `메시지: ${config.leave_message || DEFAULT_LEAVE_MESSAGE}`,
        ].join("\n"),
      },
      {
        name: "플레이스홀더",
        value: PLACEHOLDER_HELP,
      },
    )
    .setFooter({ text: `서버 ID: ${guild.id}` });
}

function makeCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false);
}

function makeAdminCommand(name, description) {
  return makeCommand(name, description)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

const commands = [
  makeAdminCommand("입장로그채널설정", "입장 인사 채널을 설정합니다.")
    .addChannelOption((option) => option
      .setName("ch")
      .setDescription("입장 인사를 보낼 채널")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true)),

  makeAdminCommand("퇴장로그채널설정", "퇴장 인사 채널을 설정합니다.")
    .addChannelOption((option) => option
      .setName("ch")
      .setDescription("퇴장 인사를 보낼 채널")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true)),

  makeAdminCommand("입장메시지설정", "입장 인사 메시지를 설정합니다.")
    .addStringOption((option) => option
      .setName("msg")
      .setDescription("인사 문구. /도움말에서 플레이스홀더 확인")
      .setRequired(true)),

  makeAdminCommand("퇴장메시지설정", "퇴장 인사 메시지를 설정합니다.")
    .addStringOption((option) => option
      .setName("msg")
      .setDescription("인사 문구. /도움말에서 플레이스홀더 확인")
      .setRequired(true)),

  makeAdminCommand("인사기능설정", "입장/퇴장 인사 기능을 켜거나 끕니다.")
    .addStringOption((option) => option
      .setName("종류")
      .setDescription("설정할 인사 종류")
      .addChoices(
        { name: "입장 인사", value: "join" },
        { name: "퇴장 인사", value: "leave" },
      )
      .setRequired(true))
    .addStringOption((option) => option
      .setName("상태")
      .setDescription("활성화 여부")
      .addChoices(
        { name: "켜기", value: "on" },
        { name: "끄기", value: "off" },
      )
      .setRequired(true)),

  makeCommand("인사설정보기", "현재 인사 설정을 확인합니다."),

  makeAdminCommand("인사채널자동설정", "상단 텍스트 채널로 입장/퇴장 인사 채널을 자동 설정합니다."),

  makeCommand("인사미리보기", "현재 인사 메시지를 미리 봅니다.")
    .addStringOption((option) => option
      .setName("종류")
      .setDescription("미리 볼 인사 종류")
      .addChoices(
        { name: "입장 인사", value: "join" },
        { name: "퇴장 인사", value: "leave" },
      )
      .setRequired(true)),

  makeAdminCommand("인사테스트", "설정된 채널로 테스트 인사 메시지를 보냅니다.")
    .addStringOption((option) => option
      .setName("종류")
      .setDescription("테스트할 인사 종류")
      .addChoices(
        { name: "입장 인사", value: "join" },
        { name: "퇴장 인사", value: "leave" },
      )
      .setRequired(true)),

  makeAdminCommand("인사메시지초기화", "인사 메시지를 기본값으로 되돌립니다.")
    .addStringOption((option) => option
      .setName("종류")
      .setDescription("초기화할 인사 종류")
      .addChoices(
        { name: "입장 인사", value: "join" },
        { name: "퇴장 인사", value: "leave" },
        { name: "둘 다", value: "all" },
      )
      .setRequired(true)),

  makeCommand("도움말", "도움말/명령어 안내").setDMPermission(true),

  new SlashCommandBuilder()
    .setName("핑")
    .setDescription("봇의 응답 시간을 확인합니다."),

  makeAdminCommand("서버등록", "서버 인사 기능을 활성화합니다. 관리자만 가능합니다."),

  makeAdminCommand("서버등록해제", "서버 인사 설정을 삭제합니다. 관리자만 가능합니다."),
];

const commandPayload = commands.map((command) => command.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  allowedMentions: {
    parse: [],
  },
});

function noMentions() {
  return { parse: [] };
}

function allowMemberMention(member) {
  return {
    parse: [],
    users: [member.id],
  };
}

async function replySafe(interaction, payload) {
  const body = {
    allowedMentions: noMentions(),
    ...payload,
  };

  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(body);
  }
  return interaction.reply(body);
}

async function sendInteractionMessage(interaction, content, ephemeral = true) {
  return replySafe(interaction, {
    content,
    flags: ephemeral ? MessageFlags.Ephemeral : undefined,
  });
}

async function sendGenericErrorMessage(interaction) {
  try {
    await replySafe(interaction, {
      content: GENERIC_ERROR_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    log("warn", "사용자용 일반 오류 메시지 전송 실패.", {
      command: interaction.commandName,
      guild: interaction.guildId,
      user: interaction.user?.id,
    });
  }
}

async function ensureGuild(interaction) {
  if (!interaction.guild) {
    await sendInteractionMessage(interaction, "서버 안에서만 사용할 수 있습니다.");
    return false;
  }
  return true;
}

async function ensureRegisteredServer(interaction) {
  if (!(await ensureGuild(interaction))) {
    return false;
  }
  if (!isServerRegistered(interaction.guild.id)) {
    await sendInteractionMessage(interaction, "서버 등록 후 사용 가능합니다. /서버등록");
    return false;
  }
  return true;
}

async function ensureAdmin(interaction) {
  if (!isAdmin(interaction.member)) {
    await sendInteractionMessage(interaction, "관리자만 가능합니다.");
    return false;
  }
  return true;
}

async function ensureAdminRegistered(interaction) {
  return (await ensureRegisteredServer(interaction)) && (await ensureAdmin(interaction));
}

async function sendGreeting(kind, member, { force = false } = {}) {
  const config = getConfig(member.guild.id);
  if (!config) {
    log("info", "인사 메시지 건너뜀: 서버 미등록", {
      guild: member.guild.id,
      kind,
      member: member.id,
    });
    return false;
  }

  const fields = kind === "join"
    ? {
      enabledKey: "join_enabled",
      channelKey: "join_channel_id",
      messageKey: "join_message",
      fallback: DEFAULT_JOIN_MESSAGE,
    }
    : {
      enabledKey: "leave_enabled",
      channelKey: "leave_channel_id",
      messageKey: "leave_message",
      fallback: DEFAULT_LEAVE_MESSAGE,
    };

  if (!force && !config[fields.enabledKey]) {
    log("info", "인사 메시지 건너뜀: 기능 꺼짐", {
      guild: member.guild.id,
      kind,
      member: member.id,
    });
    return false;
  }

  const channel = getConfiguredChannel(member.guild, config[fields.channelKey]);
  if (!channel) {
    log("warn", "인사 메시지 전송 실패: 채널 미설정/삭제됨", {
      guild: member.guild.id,
      kind,
      member: member.id,
      configured_channel: config[fields.channelKey],
    });
    return false;
  }

  if (!botCanSend(channel)) {
    log("warn", "인사 메시지 전송 실패: 채널 권한 부족", {
      guild: member.guild.id,
      kind,
      member: member.id,
      channel: channel.id,
    });
    return false;
  }

  const content = formatTemplate(config[fields.messageKey] || fields.fallback, member, channel, member.guild);
  try {
    await channel.send({
      content,
      allowedMentions: allowMemberMention(member),
    });
  } catch (error) {
    logError("인사 메시지 전송 실패: Discord API 오류", error, {
      guild: member.guild.id,
      kind,
      member: member.id,
      channel: channel.id,
    });
    return false;
  }

  log("info", "인사 메시지 전송 완료.", {
    guild: member.guild.id,
    kind,
    member: member.id,
    channel: channel.id,
  });
  return true;
}

async function handleSetJoinChannel(interaction) {
  if (!(await ensureAdminRegistered(interaction))) {
    return;
  }
  const channel = interaction.options.getChannel("ch", true);
  if (!botCanSend(channel)) {
    await sendInteractionMessage(interaction, "해당 채널에 메시지를 보낼 권한이 없습니다.");
    return;
  }

  updateConfig(interaction.guild.id, { join_channel_id: channel.id });
  await replySafe(interaction, {
    content: `입장 인사 채널이 <#${channel.id}>로 설정되었습니다.`,
  });
}

async function handleSetLeaveChannel(interaction) {
  if (!(await ensureAdminRegistered(interaction))) {
    return;
  }
  const channel = interaction.options.getChannel("ch", true);
  if (!botCanSend(channel)) {
    await sendInteractionMessage(interaction, "해당 채널에 메시지를 보낼 권한이 없습니다.");
    return;
  }

  updateConfig(interaction.guild.id, { leave_channel_id: channel.id });
  await replySafe(interaction, {
    content: `퇴장 인사 채널이 <#${channel.id}>로 설정되었습니다.`,
  });
}

async function handleSetJoinMessage(interaction) {
  if (!(await ensureAdminRegistered(interaction))) {
    return;
  }
  const message = interaction.options.getString("msg", true);
  const error = validateTemplate(message);
  if (error) {
    await sendInteractionMessage(interaction, error);
    return;
  }

  updateConfig(interaction.guild.id, { join_message: message });
  const config = getConfig(interaction.guild.id);
  const channel = getConfiguredChannel(interaction.guild, config.join_channel_id);
  const preview = formatTemplate(message, interaction.member, channel, interaction.guild);
  await replySafe(interaction, {
    content: `입장 인사 메시지를 저장했습니다.\n\n미리보기:\n${preview}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetLeaveMessage(interaction) {
  if (!(await ensureAdminRegistered(interaction))) {
    return;
  }
  const message = interaction.options.getString("msg", true);
  const error = validateTemplate(message);
  if (error) {
    await sendInteractionMessage(interaction, error);
    return;
  }

  updateConfig(interaction.guild.id, { leave_message: message });
  const config = getConfig(interaction.guild.id);
  const channel = getConfiguredChannel(interaction.guild, config.leave_channel_id);
  const preview = formatTemplate(message, interaction.member, channel, interaction.guild);
  await replySafe(interaction, {
    content: `퇴장 인사 메시지를 저장했습니다.\n\n미리보기:\n${preview}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleToggleGreeting(interaction) {
  if (!(await ensureAdminRegistered(interaction))) {
    return;
  }

  const kind = interaction.options.getString("종류", true);
  const enabled = interaction.options.getString("상태", true) === "on" ? 1 : 0;
  if (kind === "join") {
    updateConfig(interaction.guild.id, { join_enabled: enabled });
    await sendInteractionMessage(interaction, `입장 인사 기능이 ${enabledLabel(enabled)} 상태로 변경되었습니다.`, false);
  } else {
    updateConfig(interaction.guild.id, { leave_enabled: enabled });
    await sendInteractionMessage(interaction, `퇴장 인사 기능이 ${enabledLabel(enabled)} 상태로 변경되었습니다.`, false);
  }
}

async function handleShowGreetingConfig(interaction) {
  if (!(await ensureRegisteredServer(interaction))) {
    return;
  }
  await replySafe(interaction, {
    embeds: [buildConfigEmbed(interaction.guild, getConfig(interaction.guild.id))],
  });
}

async function handleAutoSetGreetingChannels(interaction) {
  if (!(await ensureAdminRegistered(interaction))) {
    return;
  }

  const [joinChannel, leaveChannel] = pickDefaultGreetingChannels(interaction.guild);
  if (!joinChannel || !leaveChannel) {
    await sendInteractionMessage(interaction, "봇이 메시지를 보낼 수 있는 텍스트 채널을 찾지 못했습니다.");
    return;
  }

  updateConfig(interaction.guild.id, {
    join_channel_id: joinChannel.id,
    leave_channel_id: leaveChannel.id,
  });
  await replySafe(interaction, {
    content: `인사 채널을 자동 설정했습니다.\n${describeDefaultChannels(joinChannel, leaveChannel)}`,
  });
}

async function handlePreviewGreeting(interaction) {
  if (!(await ensureRegisteredServer(interaction))) {
    return;
  }

  const kind = interaction.options.getString("종류", true);
  const config = getConfig(interaction.guild.id);
  const channel = kind === "join"
    ? getConfiguredChannel(interaction.guild, config.join_channel_id)
    : getConfiguredChannel(interaction.guild, config.leave_channel_id);
  const template = kind === "join" ? config.join_message : config.leave_message;
  const label = kind === "join" ? "입장 인사" : "퇴장 인사";
  const preview = formatTemplate(template, interaction.member, channel, interaction.guild);

  await replySafe(interaction, {
    content: `${label} 미리보기:\n${preview}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTestGreeting(interaction) {
  if (!(await ensureAdminRegistered(interaction))) {
    return;
  }

  await interaction.deferReply();
  const sent = await sendGreeting(interaction.options.getString("종류", true), interaction.member, { force: true });
  await interaction.followUp({
    content: sent
      ? "테스트 인사 메시지를 설정된 채널로 보냈습니다."
      : "테스트 전송에 실패했습니다. 채널 설정과 봇 권한을 확인해주세요.",
  });
}

async function handleResetGreetingMessage(interaction) {
  if (!(await ensureAdminRegistered(interaction))) {
    return;
  }

  const kind = interaction.options.getString("종류", true);
  if (kind === "join") {
    updateConfig(interaction.guild.id, { join_message: DEFAULT_JOIN_MESSAGE });
    await sendInteractionMessage(interaction, "입장 인사 메시지를 기본값으로 초기화했습니다.", false);
  } else if (kind === "leave") {
    updateConfig(interaction.guild.id, { leave_message: DEFAULT_LEAVE_MESSAGE });
    await sendInteractionMessage(interaction, "퇴장 인사 메시지를 기본값으로 초기화했습니다.", false);
  } else {
    updateConfig(interaction.guild.id, {
      join_message: DEFAULT_JOIN_MESSAGE,
      leave_message: DEFAULT_LEAVE_MESSAGE,
    });
    await sendInteractionMessage(interaction, "입장/퇴장 인사 메시지를 기본값으로 초기화했습니다.", false);
  }
}

async function handleHelp(interaction) {
  const admin = isAdmin(interaction.member);
  const text = admin
    ? [
      "**쿠키봇 관리자용 도움말**",
      "",
      "[서버 등록]",
      "- /서버등록 : 서버 인사 기능 활성화",
      "- /서버등록해제 : 서버 설정 삭제",
      "",
      "[인사 채널/메시지]",
      "- /입장로그채널설정 [채널] : 입장 인사 채널 지정",
      "- /퇴장로그채널설정 [채널] : 퇴장 인사 채널 지정",
      "- /입장메시지설정 [메시지] : 입장 인사 문구 지정",
      "- /퇴장메시지설정 [메시지] : 퇴장 인사 문구 지정",
      "- /인사기능설정 [종류] [상태] : 입장/퇴장 인사 켜기 또는 끄기",
      "- /인사설정보기 : 현재 설정 확인",
      "- /인사채널자동설정 : 상단 텍스트 채널로 입장/퇴장 채널 자동 지정",
      "- /인사미리보기 [종류] : 내 계정 기준으로 메시지 미리보기",
      "- /인사테스트 [종류] : 설정된 채널로 테스트 전송",
      "- /인사메시지초기화 [종류] : 기본 문구로 복원",
      "",
      "[플레이스홀더]",
      PLACEHOLDER_HELP,
      "",
      "[기타]",
      "- /핑 : 봇 응답속도 확인",
      "- /도움말 : 전체 명령어 안내",
    ].join("\n")
    : [
      "**쿠키봇 도움말**",
      "- /핑 : 봇 응답속도 확인",
      "- /도움말 : 명령어 안내",
      "서버 인사 설정은 관리자만 변경할 수 있습니다.",
    ].join("\n");

  await replySafe(interaction, {
    content: text,
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePing(interaction) {
  await replySafe(interaction, {
    content: `퐁! \`${Math.round(client.ws.ping)}ms\``,
  });
}

function registrationEmbed() {
  return new EmbedBuilder()
    .setTitle("쿠키봇 서버 등록 안내")
    .setDescription([
      "쿠키봇 인사 기능을 사용하기 위해 서버 설정을 저장합니다.",
      "",
      "- 저장 항목: 서버 ID, 입장/퇴장 채널 ID, 입장/퇴장 메시지 설정",
      "- 등록하면 입장/퇴장 인사는 기본으로 켜지고 기본 문구가 저장됩니다.",
      "- 채널은 봇이 메시지를 보낼 수 있는 상단 텍스트 채널 1번/2번으로 자동 지정됩니다.",
      "- 언제든 /서버등록해제 명령어로 서버 설정을 삭제할 수 있습니다.",
      "",
      "위 내용에 동의하십니까?",
    ].join("\n"))
    .setColor(0x1976D2);
}

function unregisterEmbed() {
  return new EmbedBuilder()
    .setTitle("정말로 서버등록을 해제하시겠습니까?")
    .setDescription("서버 인사 설정이 즉시 삭제되며 복구할 수 없습니다. 계속하려면 수락을 눌러주세요.")
    .setColor(0xFFC107);
}

function makeButtonRow(acceptLabel, rejectLabel, action, guildId, userId, expiresAt) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${action}:accept:${guildId}:${userId}:${expiresAt}`)
      .setLabel(acceptLabel)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${action}:reject:${guildId}:${userId}:${expiresAt}`)
      .setLabel(rejectLabel)
      .setStyle(ButtonStyle.Danger),
  );
}

async function handleServerRegister(interaction) {
  if (!(await ensureGuild(interaction)) || !(await ensureAdmin(interaction))) {
    return;
  }
  if (isServerRegistered(interaction.guild.id)) {
    await sendInteractionMessage(interaction, "이미 등록된 서버입니다.");
    return;
  }

  const expiresAt = Date.now() + 120_000;
  await interaction.reply({
    embeds: [registrationEmbed()],
    components: [makeButtonRow("동의", "취소", "server_register", interaction.guild.id, interaction.user.id, expiresAt)],
  });
}

async function handleServerUnregister(interaction) {
  if (!(await ensureGuild(interaction)) || !(await ensureAdmin(interaction))) {
    return;
  }
  if (!isServerRegistered(interaction.guild.id)) {
    await sendInteractionMessage(interaction, "등록된 서버가 아닙니다.");
    return;
  }

  const expiresAt = Date.now() + 60_000;
  await interaction.reply({
    embeds: [unregisterEmbed()],
    components: [makeButtonRow("수락", "거부", "server_unregister", interaction.guild.id, interaction.user.id, expiresAt)],
  });
}

async function handleServerRegisterButton(interaction, buttonAction, guildId) {
  if (buttonAction === "reject") {
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("서버 등록 취소")
          .setDescription("서버 등록 요청이 취소되었습니다.")
          .setColor(0xE53935),
      ],
      components: [],
    });
    return;
  }

  const [joinChannel, leaveChannel] = pickDefaultGreetingChannels(interaction.guild);
  createServerConfig(guildId, {
    joinChannelId: joinChannel?.id,
    leaveChannelId: leaveChannel?.id,
  });
  const description = [
    "기본값으로 입장/퇴장 인사를 켜고 기본 문구를 저장했습니다.",
    describeDefaultChannels(joinChannel, leaveChannel),
    "",
    "필요하면 /입장로그채널설정, /퇴장로그채널설정, /입장메시지설정, /퇴장메시지설정으로 바로 바꿀 수 있습니다.",
  ].join("\n");

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setTitle("서버 등록 완료")
        .setDescription(description)
        .setColor(0x43A047),
    ],
    components: [],
  });
  log("info", "서버 등록 완료.", {
    guild: guildId,
    join_channel: joinChannel?.id || null,
    leave_channel: leaveChannel?.id || null,
  });
  try {
    await updatePresence();
  } catch (error) {
    logError("상태 메시지 갱신 실패", error, { guild: guildId });
  }
}

async function handleServerUnregisterButton(interaction, buttonAction, guildId) {
  if (buttonAction === "reject") {
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("서버등록 해제 취소")
          .setDescription("서버등록 해제 요청이 취소되었습니다.")
          .setColor(0xE53935),
      ],
      components: [],
    });
    return;
  }

  deleteGuildData(guildId);
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setTitle("서버등록 해제 완료")
        .setDescription("서버 인사 설정이 삭제되었습니다.")
        .setColor(0x43A047),
    ],
    components: [],
  });
  try {
    await updatePresence();
  } catch (error) {
    logError("상태 메시지 갱신 실패", error, { guild: guildId });
  }
}

async function handleButtonInteraction(interaction) {
  const [action, buttonAction, guildId, userId, expiresAtRaw] = interaction.customId.split(":");
  if (!["server_register", "server_unregister"].includes(action)) {
    return;
  }

  if (interaction.user.id !== userId) {
    await interaction.reply({
      content: "등록 명령어 사용자만 누를 수 있습니다.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: noMentions(),
    });
    return;
  }

  if (!interaction.guild || interaction.guild.id !== guildId) {
    await interaction.reply({
      content: GENERIC_ERROR_MESSAGE,
      flags: MessageFlags.Ephemeral,
      allowedMentions: noMentions(),
    });
    return;
  }

  if (Date.now() > Number(expiresAtRaw || 0)) {
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle(action === "server_register" ? "서버 등록 요청 시간 초과" : "서버 해제 요청 시간 초과")
          .setDescription(
            action === "server_register"
              ? "2분 내로 선택하지 않아 등록 요청이 자동 취소되었습니다."
              : "1분 내로 선택하지 않아 서버 해제 요청이 자동 취소되었습니다.",
          )
          .setColor(0x757575),
      ],
      components: [],
    });
    return;
  }

  if (action === "server_register") {
    await handleServerRegisterButton(interaction, buttonAction, guildId);
  } else {
    await handleServerUnregisterButton(interaction, buttonAction, guildId);
  }
}

const commandHandlers = {
  입장로그채널설정: handleSetJoinChannel,
  퇴장로그채널설정: handleSetLeaveChannel,
  입장메시지설정: handleSetJoinMessage,
  퇴장메시지설정: handleSetLeaveMessage,
  인사기능설정: handleToggleGreeting,
  인사설정보기: handleShowGreetingConfig,
  인사채널자동설정: handleAutoSetGreetingChannels,
  인사미리보기: handlePreviewGreeting,
  인사테스트: handleTestGreeting,
  인사메시지초기화: handleResetGreetingMessage,
  도움말: handleHelp,
  핑: handlePing,
  서버등록: handleServerRegister,
  서버등록해제: handleServerUnregister,
};

async function updatePresence() {
  const registeredServerCount = getRegisteredServerCount();

  await client.user.setPresence({
    activities: [
      {
        name: "Custom Status",
        state: `/도움말 | ${registeredServerCount}개 서버에서 인사 담당중`,
        type: ActivityType.Custom,
      },
    ],
  });
}

async function sendShutdownDm() {
  if (!OWNER_ID || OWNER_ID === "0") {
    return;
  }
  try {
    const owner = await client.users.fetch(OWNER_ID);
    await owner.send("쿠키봇이 종료되었습니다.");
  } catch (error) {
    log("debug", "종료 DM 전송 실패.");
  }
}

let readySynced = false;
let readyNotified = false;
let readyDefaultsChecked = false;

client.once(Events.ClientReady, async () => {
  log("info", `Logged in as ${client.user.tag}`);
  await updatePresence();

  if (!readyDefaultsChecked) {
    for (const guild of client.guilds.cache.values()) {
      try {
        ensureGreetingDefaultsForGuild(guild);
      } catch (error) {
        logError("인사 기본 설정 자동 보정 실패", error, { guild: guild.id });
      }
    }
    readyDefaultsChecked = true;
  }

  if (!readySynced) {
    try {
      await client.application.commands.set(commandPayload);
      readySynced = true;
      log("info", "Slash commands synced.");
    } catch (error) {
      logError("명령어 동기화 중 오류가 발생했습니다.", error);
    }
  }

  if (OWNER_ID !== "0" && !readyNotified) {
    try {
      const owner = await client.users.fetch(OWNER_ID);
      await owner.send("쿠키봇이 성공적으로 시작되었습니다.");
      readyNotified = true;
    } catch (error) {
      log("debug", "시작 DM 전송 실패.");
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    try {
      await handleButtonInteraction(interaction);
    } catch (error) {
      logError("버튼 처리 실패", error, {
        custom_id: interaction.customId,
        guild: interaction.guildId,
        user: interaction.user?.id,
      });
      await sendGenericErrorMessage(interaction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const handler = commandHandlers[interaction.commandName];
  if (!handler) {
    return;
  }

  try {
    await handler(interaction);
  } catch (error) {
    logError("슬래시 명령어 처리 실패", error, {
      command: interaction.commandName,
      guild: interaction.guildId,
      user: interaction.user?.id,
    });
    await sendGenericErrorMessage(interaction);
  }
});

client.on("guildMemberAdd", async (member) => {
  log("info", "입장 이벤트 수신.", {
    guild: member.guild.id,
    member: member.id,
    bot: member.user.bot,
  });
  await sendGreeting("join", member);
});

client.on("guildMemberRemove", async (member) => {
  log("info", "퇴장 이벤트 수신.", {
    guild: member.guild.id,
    member: member.id,
    bot: member.user.bot,
  });
  if (client.user && member.id === client.user.id) {
    return;
  }
  await sendGreeting("leave", member);
});

client.on("guildCreate", async () => {
  await updatePresence();
});

client.on("guildDelete", async (guild) => {
  deleteGuildData(guild.id);
  log("info", "길드에서 제거되어 설정을 삭제했습니다.", { guild: guild.id });
  await updatePresence();
});

client.on("error", (error) => {
  logError("디스코드 클라이언트 오류", error);
});

process.on("unhandledRejection", (error) => {
  logError("처리되지 않은 Promise 오류", error);
});

process.on("uncaughtException", (error) => {
  logError("처리되지 않은 예외", error);
});

async function shutdown(signal) {
  log("info", "종료 신호를 받았습니다.", { signal });
  await sendShutdownDm();
  await client.destroy();
  db.close();
  process.exit(0);
}

process.once("SIGINT", () => {
  shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});

function main() {
  if (!DISCORD_TOKEN) {
    throw new Error("DISCORD_TOKEN 환경변수가 설정되지 않았습니다.");
  }

  initDb();
  client.login(DISCORD_TOKEN);
}

if (require.main === module) {
  main();
}

module.exports = {
  commandPayload,
  commands,
  initDb,
};
