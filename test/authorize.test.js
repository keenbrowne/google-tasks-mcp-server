import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { OAuth2Client } from "google-auth-library";

test("OAuth listens on loopback and exchanges only a callback with matching state and PKCE", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "google-tasks-oauth-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    syncBuiltinESMExports();
  });
  process.env.GOOGLE_TASKS_CLIENT_SECRET = path.join(dir, "client.json");
  process.env.GOOGLE_TASKS_TOKEN_PATH = path.join(dir, "token.json");
  process.env.GOOGLE_TASKS_OAUTH_PORT = "53682";
  fs.writeFileSync(process.env.GOOGLE_TASKS_CLIENT_SECRET, JSON.stringify({
    installed: { client_id: "test-client", client_secret: "test-secret" },
  }));

  let callback;
  const server = new EventEmitter();
  server.listen = t.mock.fn((port, host, onListening) => onListening());
  server.close = t.mock.fn();
  t.mock.method(http, "createServer", (handler) => {
    callback = handler;
    return server;
  });

  let openBrowser;
  const waitForBrowser = () => new Promise((resolve) => { openBrowser = resolve; });
  t.mock.method(childProcess, "execFile", (_command, args) => openBrowser(new URL(args.at(-1))));
  syncBuiltinESMExports();

  let tokenSaved;
  const saved = new Promise((resolve) => { tokenSaved = resolve; });
  const getToken = t.mock.method(OAuth2Client.prototype, "getToken", async () => {
    setImmediate(tokenSaved);
    return { tokens: { refresh_token: "test-refresh-token" } };
  });

  const browserOpened = waitForBrowser();
  await import("../dist/authorize.js");
  const consentUrl = await browserOpened;
  const { arguments: [port, host] } = server.listen.mock.calls[0];
  assert.equal(port, 53682);
  assert.equal(host, "127.0.0.1");
  assert.equal(consentUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:53682/oauth2callback");
  const state = consentUrl.searchParams.get("state");
  assert.ok(state);
  assert.equal(consentUrl.searchParams.get("code_challenge_method"), "S256");

  function sendCallback(query) {
    let status;
    callback({ method: "GET", url: `/oauth2callback?${query}` }, {
      writeHead(code) { status = code; return this; },
      end() {},
    });
    return status;
  }

  assert.equal(sendCallback("code=test-code"), 400);
  assert.equal(sendCallback("code=test-code&state=wrong"), 400);
  assert.equal(server.close.mock.callCount(), 0);
  assert.equal(getToken.mock.callCount(), 0);

  assert.equal(sendCallback(`code=test-code&state=${state}`), 200);
  await saved;
  assert.equal(server.close.mock.callCount(), 1);
  assert.equal(getToken.mock.callCount(), 1);
  const [{ code, codeVerifier }] = getToken.mock.calls[0].arguments;
  assert.equal(code, "test-code");
  assert.equal(
    createHash("sha256").update(codeVerifier).digest("base64url"),
    consentUrl.searchParams.get("code_challenge")
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.GOOGLE_TASKS_TOKEN_PATH, "utf8")), {
    refresh_token: "test-refresh-token",
  });

  await t.test("missing refresh token fails and preserves the existing cache", async (t) => {
    getToken.mock.mockImplementation(async () => ({
      tokens: { access_token: "access-token-only" },
    }));
    let finish;
    const exited = new Promise((resolve) => { finish = resolve; });
    const error = t.mock.method(console, "error", () => {});
    const log = t.mock.method(console, "log", () => {});
    t.mock.method(process, "exit", finish);

    const secondBrowserOpened = waitForBrowser();
    await import("../dist/authorize.js?reauthorize");
    const secondState = (await secondBrowserOpened).searchParams.get("state");
    const previousCache = fs.readFileSync(process.env.GOOGLE_TASKS_TOKEN_PATH, "utf8");
    assert.equal(sendCallback(`code=test-code&state=${secondState}`), 200);
    assert.equal(await exited, 1);
    assert.match(error.mock.calls[0].arguments.join(" "), /no refresh token/);
    assert.ok(log.mock.calls.every(({ arguments: args }) => !args[0].includes("Authorization complete")));
    assert.equal(fs.readFileSync(process.env.GOOGLE_TASKS_TOKEN_PATH, "utf8"), previousCache);
  });
});
