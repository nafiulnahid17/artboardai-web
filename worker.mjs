const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sessionCookie = "artboard_session";
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const maxLoginBodyBytes = 4096;
const defaultEngineUrl = "https://artboardaitool-jerseyos-engine-production.up.railway.app";
const hmacKeys = new Map();

function getHmacKey(secret) {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    hmacKeys.set(secret, key);
  }
  return key;
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url value.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signSession(payload, secret) {
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return encodeBase64Url(new Uint8Array(signature));
}

async function verifySessionValue(value, secret) {
  if (value.length > 2048) return false;
  const separator = value.lastIndexOf(".");
  if (separator <= 0 || separator === value.length - 1) return false;

  const payload = value.slice(0, separator);
  let signature;
  let data;
  try {
    signature = decodeBase64Url(value.slice(separator + 1));
    data = JSON.parse(decoder.decode(decodeBase64Url(payload)));
  } catch {
    return false;
  }

  if (!Number.isFinite(data?.expiresAt) || data.expiresAt <= Date.now()) return false;
  try {
    const key = await getHmacKey(secret);
    return await crypto.subtle.verify("HMAC", key, signature, encoder.encode(payload));
  } catch {
    return false;
  }
}

async function verifyAccessCode(candidate, config) {
  const key = await getHmacKey(config.sessionSecret);
  const expectedSignature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(config.accessCode),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    expectedSignature,
    encoder.encode(candidate),
  );
}

function readCookie(request) {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === sessionCookie) {
      return part.slice(separator + 1).trim();
    }
  }
  return "";
}

function getSessionConfig(env) {
  const accessCode = typeof env?.ARTBOARD_WEB_ACCESS_CODE === "string"
    ? env.ARTBOARD_WEB_ACCESS_CODE
    : "";
  const sessionSecret = typeof env?.ARTBOARD_WEB_SESSION_SECRET === "string"
    ? env.ARTBOARD_WEB_SESSION_SECRET
    : "";

  if (encoder.encode(accessCode).byteLength < 15) return null;
  if (encoder.encode(sessionSecret).byteLength < 32) return null;
  return { accessCode, sessionSecret };
}

function getEngineConfig(env) {
  const engineToken = typeof env?.ARTBOARD_ENGINE_TOKEN === "string"
    ? env.ARTBOARD_ENGINE_TOKEN
    : "";
  if (!engineToken) return null;
  let engineUrl;
  try {
    engineUrl = new URL(env.ARTBOARD_ENGINE_URL || defaultEngineUrl);
  } catch {
    return null;
  }
  if (
    engineUrl.protocol !== "https:"
    || engineUrl.username
    || engineUrl.password
    || engineUrl.pathname !== "/"
    || engineUrl.search
    || engineUrl.hash
  ) {
    return null;
  }

  return { engineToken, engineUrl };
}

function isReady(env) {
  return Boolean(
    getSessionConfig(env)
    && getEngineConfig(env)
    && typeof env?.ASSETS?.fetch === "function"
    && typeof env?.LOGIN_LIMITER?.limit === "function",
  );
}

function withSecurityHeaders(response, { noStore = false } = {}) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'",
  );
  headers.set("Strict-Transport-Security", "max-age=31536000");
  if (noStore || headers.get("Content-Type")?.includes("text/html")) {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(status, value, headers = {}) {
  return withSecurityHeaders(new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  }), { noStore: true });
}

function configurationUnavailable() {
  return jsonResponse(503, {
    error: {
      code: "WEB_CONFIGURATION_MISSING",
      message: "The license-key access service is not configured yet.",
    },
  });
}

function isSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function readJsonLimited(request) {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const error = new Error("Login requests must use JSON.");
    error.status = 415;
    throw error;
  }

  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (declaredLength > maxLoginBodyBytes) {
    const error = new Error("Login request is too large.");
    error.status = 413;
    throw error;
  }

  if (!request.body) {
    const error = new Error("Login request body is required.");
    error.status = 400;
    throw error;
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxLoginBodyBytes) {
        await reader.cancel();
        const error = new Error("Login request is too large.");
        error.status = 413;
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    const error = new Error("Login request must contain valid JSON.");
    error.status = 400;
    throw error;
  }
}

async function newSessionValue(secret) {
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    expiresAt: Date.now() + sessionLifetimeMs,
    nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  })));
  return `${payload}.${await signSession(payload, secret)}`;
}

function sessionCookieHeader(value, maxAge) {
  return `${sessionCookie}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function handleSession(request, env, config) {
  if (request.method === "GET") {
    return jsonResponse(200, {
      authenticated: await verifySessionValue(readCookie(request), config.sessionSecret),
    });
  }

  if (!["POST", "DELETE"].includes(request.method)) {
    return jsonResponse(405, {
      error: { code: "METHOD_NOT_ALLOWED", message: "This method is not supported." },
    }, { Allow: "GET, POST, DELETE" });
  }

  if (!isSameOrigin(request)) {
    return jsonResponse(403, {
      error: { code: "CROSS_ORIGIN_DENIED", message: "Cross-origin access is not allowed." },
    });
  }

  if (request.method === "DELETE") {
    return jsonResponse(200, { authenticated: false }, {
      "Set-Cookie": sessionCookieHeader("", 0),
    });
  }

  let rateLimit;
  try {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    rateLimit = await env.LOGIN_LIMITER.limit({ key: `artboard-login:${ip}` });
  } catch {
    return configurationUnavailable();
  }
  if (!rateLimit?.success) {
    return jsonResponse(429, {
      error: { code: "LOGIN_RATE_LIMITED", message: "Too many access attempts. Wait a minute before trying again." },
    }, { "Retry-After": "60" });
  }

  let body;
  try {
    body = await readJsonLimited(request);
  } catch (error) {
    return jsonResponse(error.status ?? 400, {
      error: { code: "INVALID_LOGIN_REQUEST", message: error.message },
    });
  }

  const candidate = typeof body?.accessCode === "string" ? body.accessCode : "";
  if (!await verifyAccessCode(candidate, config)) {
    return jsonResponse(401, {
      error: { code: "INVALID_ACCESS_CODE", message: "The access code was not accepted." },
    });
  }

  const session = await newSessionValue(config.sessionSecret);
  return jsonResponse(200, { authenticated: true }, {
    "Set-Cookie": sessionCookieHeader(session, Math.floor(sessionLifetimeMs / 1000)),
  });
}

async function proxyEngine(request, env, sessionConfig, fetcher) {
  if (!await verifySessionValue(readCookie(request), sessionConfig.sessionSecret)) {
    return jsonResponse(401, {
      error: {
        code: "WEB_SESSION_REQUIRED",
        message: "Enter the team access code to use the artwork engine.",
      },
    });
  }
  const engineConfig = getEngineConfig(env);
  if (!engineConfig) return configurationUnavailable();
  if (!["GET", "HEAD", "POST"].includes(request.method)) {
    return jsonResponse(405, {
      error: { code: "METHOD_NOT_ALLOWED", message: "This method is not supported." },
    }, { Allow: "GET, HEAD, POST" });
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, engineConfig.engineUrl);
  const headers = new Headers();
  for (const header of ["accept", "content-type"]) {
    const value = request.headers.get(header);
    if (value) headers.set(header, value);
  }
  headers.set("Authorization", `Bearer ${engineConfig.engineToken}`);

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
    init.duplex = "half";
  }

  let upstream;
  try {
    upstream = await fetcher(new Request(targetUrl, init));
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return jsonResponse(timedOut ? 504 : 502, {
      error: {
        code: timedOut ? "ENGINE_TIMEOUT" : "ENGINE_UNREACHABLE",
        message: timedOut
          ? "The artwork engine request timed out."
          : "The artwork engine could not be reached.",
      },
    });
  }

  const responseHeaders = new Headers();
  for (const header of [
    "content-type",
    "content-disposition",
    "etag",
    "content-range",
    "accept-ranges",
  ]) {
    const value = upstream.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }
  responseHeaders.set("Cache-Control", "no-store");
  return withSecurityHeaders(new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  }), { noStore: true });
}

export async function handleWorkerRequest(request, env, fetcher = globalThis.fetch) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/healthz" && request.method === "GET") {
      if (!isReady(env)) return configurationUnavailable();
      return jsonResponse(200, { status: "ok", app: "Artboard Ai" });
    }
    if (url.pathname === "/api/session") {
      const sessionConfig = getSessionConfig(env);
      if (!sessionConfig) return configurationUnavailable();
      return handleSession(request, env, sessionConfig);
    }
    if (url.pathname === "/api/engine" || url.pathname.startsWith("/api/engine/")) {
      const sessionConfig = getSessionConfig(env);
      if (!sessionConfig) return configurationUnavailable();
      return proxyEngine(request, env, sessionConfig, fetcher);
    }
    return jsonResponse(404, {
      error: { code: "NOT_FOUND", message: "API route not found." },
    });
  }

  try {
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  } catch {
    return jsonResponse(500, {
      error: { code: "WEB_ASSET_FAILED", message: "The web page could not be loaded." },
    });
  }
}

export default {
  fetch(request, env) {
    return handleWorkerRequest(request, env, fetch);
  },
};
