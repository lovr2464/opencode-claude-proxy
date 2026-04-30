import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

import { buildConfig } from "./src/config.js";
import { buildOpenAIRequest, openAIResponseToAnthropic } from "./src/convert.js";
import { createStreamConverter } from "./src/stream.js";

// ── HTTP helpers ────────────────────────────────────────────────────────────

function log(config, method, url, status, detail) {
  if (config.logLevel === "silent") return;
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const s = status >= 400 ? `\x1b[31m${status}\x1b[0m` : `\x1b[32m${status}\x1b[0m`;
  console.log(`${time}  ${method}  ${s}  ${url}${detail ? `  (${detail})` : ""}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(obj));
}

function safeJsonParse(text, fallback = {}) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function parseJsonStrict(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

// ── Upstream request ────────────────────────────────────────────────────────

function downstreamApiKey(headers) {
  const xApiKey = headers["x-api-key"];
  if (Array.isArray(xApiKey)) return xApiKey[0];
  if (xApiKey) return xApiKey;

  const auth = headers.authorization;
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (!value) return "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

function resolveUpstreamApiKey(config, headers) {
  if (config.authMode === "proxy") return config.apiKey;
  return downstreamApiKey(headers);
}

function upstreamHeaders(config, headers, bodyStr) {
  const apiKey = resolveUpstreamApiKey(config, headers);
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Content-Length": Buffer.byteLength(bodyStr || ""),
    ...Object.fromEntries(
      Object.entries(headers).filter(([key]) =>
        !["host", "x-api-key", "authorization", "content-length", "transfer-encoding", "connection", "accept-encoding", "anthropic-version", "anthropic-beta"].includes(key.toLowerCase()),
      ),
    ),
  };
}

function upstreamRequest(config, method, requestPath, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    if (!resolveUpstreamApiKey(config, headers)) {
      reject(Object.assign(
        new Error(`Missing API key for AUTH_MODE=${config.authMode}`),
        { statusCode: 401, errorType: "authentication_error" },
      ));
      return;
    }

    const url = new URL(config.upstreamBaseUrl + requestPath);
    const req = (url.protocol === "https:" ? https : http).request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers: upstreamHeaders(config, headers, bodyStr),
        timeout: config.requestTimeoutMs,
      },
      resolve,
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Error response ──────────────────────────────────────────────────────────

function anthropicError(status, message, type = "api_error") {
  return { status, body: { type: "error", error: { type, message } } };
}

function normalizeUpstreamError(status, text) {
  const parsed = safeJsonParse(text, null);
  if (parsed?.type === "error" && parsed.error?.message) return parsed;
  if (parsed?.error) {
    const error = parsed.error;
    return anthropicError(
      status,
      typeof error.message === "string" ? error.message : text,
      typeof error.type === "string" ? error.type : "upstream_error",
    ).body;
  }
  return anthropicError(status, text || `Upstream request failed with status ${status}`, "upstream_error").body;
}

// ── Route handlers ──────────────────────────────────────────────────────────

async function handleMessages(config, req, res, url) {
  let anthropicReq;
  try {
    anthropicReq = safeJsonParse(await readBody(req), null);
    if (!anthropicReq) throw new Error("Invalid JSON request body");
  } catch (error) {
    log(config, req.method, url.pathname, 400, error.message);
    return sendJson(res, 400, anthropicError(400, error.message, "invalid_request_error").body);
  }

  const { requestedModel, upstreamModel, body } = buildOpenAIRequest(anthropicReq, config);
  const bodyStr = JSON.stringify(body);

  // ── Streaming path ────────────────────────────────────────────────────
  if (body.stream) {
    log(config, req.method, url.pathname, 200, `stream ${requestedModel} -> ${upstreamModel}`);
    let upstream;
    try {
      upstream = await upstreamRequest(config, "POST", "/chat/completions", req.headers, bodyStr);
    } catch (error) {
      const status = error.statusCode || 502;
      log(config, "UPSTREAM", upstreamModel, status, error.message);
      return sendJson(res, status, anthropicError(status, error.message, error.errorType || "upstream_error").body);
    }

    if (upstream.statusCode >= 400) {
      const errBody = await readBody(upstream);
      log(config, "UPSTREAM", upstreamModel, upstream.statusCode, errBody.slice(0, 200));
      return sendJson(res, upstream.statusCode, normalizeUpstreamError(upstream.statusCode, errBody));
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-robots-tag": "none",
      "x-opencode-tool-choice-policy": config.toolChoicePolicy,
      "x-opencode-reasoning-mode": config.reasoningMode,
    });

    let buffer = "";
    const converter = createStreamConverter(requestedModel, (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }, config.reasoningMode);

    upstream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        converter.processChunk(safeJsonParse(data, {}));
      }
    });
    upstream.on("end", () => {
      converter.end();
      res.end();
    });
    upstream.on("error", () => {
      if (!res.writableEnded) res.end();
    });
    return;
  }

  // ── Non-streaming path ────────────────────────────────────────────────
  log(config, req.method, url.pathname, 200, `${requestedModel} -> ${upstreamModel}`);
  let upstream;
  try {
    upstream = await upstreamRequest(config, "POST", "/chat/completions", req.headers, bodyStr);
  } catch (error) {
    const status = error.statusCode || 502;
    log(config, "UPSTREAM", upstreamModel, status, error.message);
    return sendJson(res, status, anthropicError(status, error.message, error.errorType || "upstream_error").body);
  }

  const respBody = await readBody(upstream);
  if (upstream.statusCode >= 400) {
    log(config, "UPSTREAM", upstreamModel, upstream.statusCode, respBody.slice(0, 200));
    return sendJson(res, upstream.statusCode, normalizeUpstreamError(upstream.statusCode, respBody));
  }

  const parsed = parseJsonStrict(respBody);
  if (!parsed.ok || !Array.isArray(parsed.value?.choices)) {
    log(config, "UPSTREAM", upstreamModel, 502, "invalid success response");
    return sendJson(res, 502, anthropicError(502, "Invalid JSON response from upstream", "upstream_error").body);
  }

  const anthropicResp = openAIResponseToAnthropic(parsed.value, requestedModel, config.reasoningMode);
  return sendJson(res, 200, anthropicResp, {
    "x-robots-tag": "none",
    "request-id": anthropicResp.id,
    "x-opencode-tool-choice-policy": config.toolChoicePolicy,
    "x-opencode-reasoning-mode": config.reasoningMode,
  });
}

// ── Server ──────────────────────────────────────────────────────────────────

export function createProxyServer(config = buildConfig()) {
  config = {
    authMode: "passthrough",
    requestTimeoutMs: 300000,
    toolChoicePolicy: "auto-on-forced",
    reasoningMode: "auto",
    logLevel: "info",
    ...config,
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/" || url.pathname === "/health") {
      log(config, req.method, url.pathname, 200);
      return sendJson(res, 200, {
        status: "ok",
        target: config.upstreamBaseUrl,
        default_model: config.defaultModel,
        models: config.models,
        model_map: Object.fromEntries(config.modelMap),
        auth_mode: config.authMode,
        tool_choice_policy: config.toolChoicePolicy,
        reasoning_mode: config.reasoningMode,
      });
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      log(config, req.method, url.pathname, 200);
      return sendJson(res, 200, {
        object: "list",
        data: config.models.map((id) => ({ id, object: "model", type: "model" })),
      });
    }

    if (url.pathname === "/v1/messages" && req.method === "POST") {
      return handleMessages(config, req, res, url);
    }

    log(config, req.method, url.pathname, 404);
    return sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
  });
}

export function startServer(config = buildConfig()) {
  const server = createProxyServer(config);
  server.on("error", (error) => {
    console.error(`Failed to start proxy on ${config.host}:${config.port}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`\n  OpenAI-to-Anthropic API Adapter  v1.1.0`);
    console.log(`  ───────────────────────────────────────`);
    console.log(`  Listen : http://${config.host}:${config.port}`);
    console.log(`  Target : ${config.upstreamBaseUrl}`);
    console.log(`  Model  : ${config.defaultModel}`);
    console.log(`  Tools  : ${config.toolChoicePolicy}`);
    console.log();
  });
  return server;
}

// ── Entry point ─────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
