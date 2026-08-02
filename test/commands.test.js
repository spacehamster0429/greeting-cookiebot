"use strict";

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 우주햄찌

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const config = {
  join_channel_id: null,
  leave_channel_id: null,
  join_message: "환영합니다, {member}님!",
  leave_message: "{username}님이 나갔습니다.",
  join_enabled: 1,
  leave_enabled: 1,
};

class StubDatabase {
  pragma() {}

  prepare(sql) {
    return {
      get() {
        if (sql.includes("SELECT guild_id")) {
          return { guild_id: "123456789" };
        }
        if (sql.includes("SELECT join_channel_id")) {
          return config;
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
  }
}

const originalLoad = Module._load;
Module._load = function loadWithStub(request, parent, isMain) {
  if (request === "better-sqlite3") {
    return StubDatabase;
  }
  return originalLoad.call(this, request, parent, isMain);
};

let commandHandlers;
let commandPayload;
try {
  ({ commandHandlers, commandPayload } = require("../src/index"));
} finally {
  Module._load = originalLoad;
}

const { MessageFlags, PermissionFlagsBits } = require("discord.js");

function getCommand(name) {
  const command = commandPayload.find((item) => item.name === name);
  assert.ok(command, `${name} 명령어가 등록되어야 합니다.`);
  return command;
}

function createInteraction({ admin = false } = {}) {
  let response;
  const user = {
    id: "987654321",
    username: "tester",
    createdAt: new Date("2020-01-01T00:00:00Z"),
  };

  return {
    guild: {
      id: "123456789",
      name: "테스트 서버",
      memberCount: 1,
      channels: { cache: new Map() },
    },
    guildId: "123456789",
    member: {
      id: user.id,
      user,
      displayName: "테스터",
      permissions: { has: () => admin },
    },
    user,
    options: { getString: () => "join" },
    replied: false,
    deferred: false,
    async reply(payload) {
      response = payload;
      this.replied = true;
      return payload;
    },
    getResponse() {
      return response;
    },
  };
}

test("인사설정보기는 일반 사용자 명령어로 유지한다", () => {
  const command = getCommand("인사설정보기");

  assert.equal(command.default_member_permissions, undefined);
  assert.equal(command.description, "현재 입장/퇴장 인사 설정을 확인합니다.");
});

test("인사미리보기는 관리자 권한으로 등록한다", () => {
  const command = getCommand("인사미리보기");

  assert.equal(
    command.default_member_permissions,
    PermissionFlagsBits.Administrator.toString(),
  );
  assert.equal(command.description, "현재 인사 메시지를 미리 봅니다.");
});

test("인사설정보기는 호출자에게만 응답한다", async () => {
  const interaction = createInteraction();

  await commandHandlers.인사설정보기(interaction);

  assert.equal(interaction.getResponse().flags, MessageFlags.Ephemeral);
  assert.equal(interaction.getResponse().embeds.length, 1);
});

test("인사미리보기는 실행 시에도 비관리자를 차단한다", async () => {
  const interaction = createInteraction();

  await commandHandlers.인사미리보기(interaction);

  assert.equal(interaction.getResponse().content, "관리자만 가능합니다.");
  assert.equal(interaction.getResponse().flags, MessageFlags.Ephemeral);
});

test("도움말은 설정 보기와 미리보기 권한을 안내한다", async () => {
  const memberInteraction = createInteraction();
  const adminInteraction = createInteraction({ admin: true });

  await commandHandlers.도움말(memberInteraction);
  await commandHandlers.도움말(adminInteraction);

  assert.match(memberInteraction.getResponse().content, /\/인사설정보기 : 현재 입장\/퇴장 인사 설정 확인/);
  assert.match(memberInteraction.getResponse().content, /서버 인사 설정은 관리자만 변경/);
  assert.match(adminInteraction.getResponse().content, /\/인사미리보기 \[종류\] : 내 계정 기준으로 메시지 미리보기/);
  assert.doesNotMatch(adminInteraction.getResponse().content, /관리자 전용/);
});
