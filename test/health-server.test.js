"use strict";

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 우주햄찌

const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");

const {
  closeHealthServer,
  createHealthServer,
  parseHealthPort,
} = require("../src/health-server");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("health endpoint reflects application readiness", async (t) => {
  let ready = false;
  const server = createHealthServer({ isReady: () => ready });
  t.after(() => closeHealthServer(server));
  const port = await listen(server);

  const unavailable = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: "unavailable" });

  ready = true;
  const healthy = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { status: "ok" });
});

test("health server rejects unrelated paths", async (t) => {
  const server = createHealthServer({ isReady: () => true });
  t.after(() => closeHealthServer(server));
  const port = await listen(server);

  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 404);
});

test("readiness errors produce an unavailable response", async (t) => {
  const server = createHealthServer({
    isReady: () => {
      throw new Error("database unavailable");
    },
  });
  t.after(() => closeHealthServer(server));
  const port = await listen(server);

  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 503);
});

test("health port validation rejects invalid values", () => {
  assert.equal(parseHealthPort("3032"), 3032);
  assert.equal(parseHealthPort(""), 3032);
  assert.throws(() => parseHealthPort("0"), /between 1 and 65535/);
  assert.throws(() => parseHealthPort("not-a-port"), /between 1 and 65535/);
});
