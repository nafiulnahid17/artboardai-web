import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { handleWorkerRequest } from "./worker.mjs";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const accessCode = "pilot-123456789";
const sessionSecret = "test-session-secret-which-is-longer-than-32-bytes";
const engineToken = "engine-test-token-never-exposed-to-browser";

function makeEnvironment(overrides = {}) {
  const limitCalls = [];
  const env = {
    ARTBOARD_WEB_ACCESS_CODE: accessCode,
    ARTBOARD_WEB_SESSION_SECRET: sessionSecret,
    ARTBOARD_ENGINE_TOKEN: engineToken,
    ARTBOARD_ENGINE_URL: "https://engine.test",
    ASSETS: {
      async fetch() {
        return new Response('<div id="root"></div>', {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
    LOGIN_LIMITER: {
      async limit(options) {
        limitCalls.push(options);
        return { success: true };
      },
    },
    ...overrides,
  };
  return { env, limitCalls };
}

function request(path, init = {}) {
  return new Request(`https://artboard.test${path}`, init);
}

test("serves SPA assets with security headers and reports configured health", async () => {
  const { env } = makeEnvironment();
  const asset = await handleWorkerRequest(request("/"), env);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /id="root"/);
  assert.equal(asset.headers.get("X-Frame-Options"), "DENY");
  assert.match(asset.headers.get("Content-Security-Policy") ?? "", /default-src 'self'/);

  const health = await handleWorkerRequest(request("/api/healthz"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", app: "Artboard Ai" });
});

test("requires the shared code, signs a session, proxies with the bearer token, and logs out", async () => {
  const { env, limitCalls } = makeEnvironment();
  let engineCallCount = 0;
  let engineAuthorization = "";
  let engineUrl = "";
  const engineFetch = async (upstreamRequest) => {
    engineCallCount += 1;
    engineAuthorization = upstreamRequest.headers.get("Authorization") ?? "";
    engineUrl = upstreamRequest.url;
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const initialSession = await handleWorkerRequest(request("/api/session"), env, engineFetch);
  assert.deepEqual(await initialSession.json(), { authenticated: false });

  const blocked = await handleWorkerRequest(request("/api/engine/capabilities"), env, engineFetch);
  assert.equal(blocked.status, 401);
  assert.equal(engineCallCount, 0);

  const rejectedCrossOrigin = await handleWorkerRequest(request("/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://other.example",
    },
    body: JSON.stringify({ accessCode }),
  }), env, engineFetch);
  assert.equal(rejectedCrossOrigin.status, 403);

  const wrongCode = await handleWorkerRequest(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessCode: "not-the-client-code" }),
  }), env, engineFetch);
  assert.equal(wrongCode.status, 401);

  const login = await handleWorkerRequest(request("/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.12",
    },
    body: JSON.stringify({ accessCode }),
  }), env, engineFetch);
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), { authenticated: true });
  const setCookie = login.headers.get("Set-Cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0];

  const proxied = await handleWorkerRequest(request("/api/engine/capabilities?detail=1", {
    headers: { Cookie: cookie },
  }), env, engineFetch);
  assert.equal(proxied.status, 200);
  assert.deepEqual(await proxied.json(), { ok: true });
  assert.equal(engineCallCount, 1);
  assert.equal(engineAuthorization, `Bearer ${engineToken}`);
  assert.equal(engineUrl, "https://engine.test/api/engine/capabilities?detail=1");
  assert.equal(limitCalls.length, 2);
  assert.deepEqual(limitCalls[1], { key: "artboard-login:192.0.2.12" });

  const logout = await handleWorkerRequest(request("/api/session", {
    method: "DELETE",
    headers: { Cookie: cookie },
  }), env, engineFetch);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("Set-Cookie") ?? "", /Max-Age=0/);

  const blockedAfterLogout = await handleWorkerRequest(request("/api/engine/capabilities"), env, engineFetch);
  assert.equal(blockedAfterLogout.status, 401);
  assert.equal(engineCallCount, 1);
});

test("rejects requests when Cloudflare's login limiter blocks the client", async () => {
  const { env } = makeEnvironment({
    LOGIN_LIMITER: {
      async limit() {
        return { success: false };
      },
    },
  });
  const response = await handleWorkerRequest(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessCode }),
  }), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
});

test("keeps license-key login available when the engine token is not configured", async () => {
  const { env } = makeEnvironment({ ARTBOARD_ENGINE_TOKEN: "" });
  const health = await handleWorkerRequest(request("/api/healthz"), env);
  assert.equal(health.status, 503);

  const login = await handleWorkerRequest(request("/api/session", { method: "GET" }), env);
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), { authenticated: false });

  const accepted = await handleWorkerRequest(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessCode }),
  }), env);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { authenticated: true });
});

test("fails closed when the session secret is missing", async () => {
  const { env } = makeEnvironment({ ARTBOARD_WEB_SESSION_SECRET: "" });
  const health = await handleWorkerRequest(request("/api/healthz"), env);
  assert.equal(health.status, 503);
  const login = await handleWorkerRequest(request("/api/session", { method: "GET" }), env);
  assert.equal(login.status, 503);
});

test("the built browser bundle contains no server-side secret names or values", async () => {
  const assetsPath = resolve(packageRoot, "dist/public/assets");
  const files = await readdir(assetsPath);
  const bundles = await Promise.all(files
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFile(resolve(assetsPath, file), "utf8")));
  assert.ok(bundles.length > 0, "Vite should emit at least one JavaScript bundle.");
  assert.ok(bundles.every((bundle) =>
    !bundle.includes("ARTBOARD_ENGINE_TOKEN")
    && !bundle.includes(engineToken)
    && !bundle.includes("ARTBOARD_WEB_SESSION_SECRET")
    && !bundle.includes(sessionSecret),
  ));
});
