"use strict";

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 우주햄찌

const http = require("http");

const DEFAULT_HEALTH_HOST = "127.0.0.1";
const DEFAULT_HEALTH_PORT = 3032;
const HEALTH_PATH = "/healthz";

function parseHealthPort(value, fallback = DEFAULT_HEALTH_PORT) {
  const text = String(value ?? "").trim();
  if (!text) {
    return fallback;
  }

  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("HEALTH_PORT must be a number between 1 and 65535.");
  }
  return port;
}

function createHealthServer({ isReady }) {
  if (typeof isReady !== "function") {
    throw new TypeError("isReady must be a function.");
  }

  return http.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== HEALTH_PATH) {
      response.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end("Not Found\n");
      return;
    }

    let ready = false;
    try {
      ready = isReady() === true;
    } catch {
      ready = false;
    }

    const body = JSON.stringify({ status: ready ? "ok" : "unavailable" });
    response.writeHead(ready ? 200 : 503, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  });
}

function closeHealthServer(server) {
  if (!server?.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  DEFAULT_HEALTH_HOST,
  DEFAULT_HEALTH_PORT,
  HEALTH_PATH,
  closeHealthServer,
  createHealthServer,
  parseHealthPort,
};
