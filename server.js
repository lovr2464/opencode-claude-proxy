import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv(envPath = path.join(__dirname, ".env")) {
  if (!fs.existsSync(envPath)) return {};

  return Object.fromEntries(
    fs
      .readFileSync(envPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        if (index === -1) return [line, ""];
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
        return [key, value];
      }),
  );
}

export function buildConfig(env = { ...loadEnv(), ...process.env }) {
  const baseUrl = env.OPENCODE_BASE_URL || env.OPENAI_BASE_URL;
  if (!baseUrl) {
    throw new Error("Missing OPENCODE_BASE_URL in .env");
  }

  return {
    apiKey: env.OPENCODE_API_KEY || env.OPENAI_API_KEY || "",
    authMode: env.AUTH_MODE || "passthrough",
    port: Number.parseInt(env.PORT || "8787", 10),
    host: env.HOST || "127.0.0.1",
    upstreamBaseUrl: baseUrl.replace(/\/$/, ""),
    defaultModel: env.DEFAULT_MODEL || "kimi-k2.6",
    models: parseCsv(env.MODELS) || [env.DEFAULT_MODEL || "kimi-k2.6"],
    modelMap: parseModelMap(env.MODEL_MAP),
    requestTimeoutMs: Number.parseInt(env.REQUEST_TIMEOUT_MS || "300000", 10),
    toolChoicePolicy: env.TOOL_CHOICE_POLICY || "auto-on-forced",
    logLevel: env.LOG_LEVEL || "info",
  };
}

function parseCsv(value) {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : null;
}

function parseModelMap(value) {
  const map = new Map();
  for (const pair of parseCsv(value) || []) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const from = pair.slice(0, index).trim();
    const to = pair.slice(index + 1).trim();
    if (from && to) map.set(from, to);
  }
  return map;
}

export function resolveModel(requestedModel, config) {
  const model = requestedModel || config.defaultModel;
  return config.modelMap.get(model) || config.modelMap.get("*") || model;
}

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

export function convertTools(anthropicTools) {
  if (!anthropicTools?.length) return [];

  return anthropicTools
    .filter((tool) => tool?.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
}

function anthropicSystemToOpenAI(systemPrompt) {
  if (!systemPrompt) return null;
  if (typeof systemPrompt === "string") return systemPrompt;
  if (!Array.isArray(systemPrompt)) return String(systemPrompt);

  return systemPrompt
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function anthropicImageToOpenAI(block) {
  const source = block?.source;
  if (source?.type === "base64" && source.data && source.media_type) {
    return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  if (source?.type === "url" && source.url) {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return { type: "text", text: "[Unsupported image block]" };
}

function stringifyToolResultContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);

  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text || "";
      if (block?.type === "image") return "[Image tool result omitted]";
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join("\n");
}

function makeAssistantMessage(texts, toolCalls) {
  const message = { role: "assistant" };
  const content = texts.filter(Boolean).join("\n");
  if (content) message.content = content;
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
    if (!content) message.content = null;
  }
  return message;
}

export function convertMessages(anthropicMessages = [], systemPrompt) {
  const openaiMessages = [];
  const system = anthropicSystemToOpenAI(systemPrompt);
  if (system) openaiMessages.push({ role: "system", content: system });

  for (const msg of anthropicMessages) {
    if (typeof msg.content === "string") {
      openaiMessages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    const texts = [];
    const userContentParts = [];
    const toolCalls = [];

    for (const block of msg.content) {
      if (block?.type === "text") {
        texts.push(block.text || "");
        userContentParts.push({ type: "text", text: block.text || "" });
      } else if (block?.type === "image") {
        userContentParts.push(anthropicImageToOpenAI(block));
      } else if (block?.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      } else if (block?.type === "tool_result") {
        openaiMessages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: stringifyToolResultContent(block.content),
        });
      }
    }

    if (msg.role === "assistant") {
      const assistantMessage = makeAssistantMessage(texts, toolCalls);
      if (assistantMessage.content !== undefined || assistantMessage.tool_calls?.length) {
        openaiMessages.push(assistantMessage);
      }
    } else if (msg.role === "user") {
      if (userContentParts.length > 0) {
        const onlyText = userContentParts.every((part) => part.type === "text");
        openaiMessages.push({
          role: "user",
          content: onlyText ? userContentParts.map((part) => part.text).join("\n") : userContentParts,
        });
      }
    }
  }

  return openaiMessages;
}

export function finishReasonToStopReason(reason) {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

function makeMsgId() {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

export function openAIResponseToAnthropic(openaiResp, requestedModel) {
  const choice = openaiResp.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (typeof msg.content === "string" && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part?.type === "text" && part.text) content.push({ type: "text", text: part.text });
    }
  }

  for (const toolCall of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(toolCall.function?.arguments || "{}");
    } catch {
      input = { _raw: toolCall.function?.arguments || "" };
    }
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now().toString(36)}`,
      name: toolCall.function?.name || toolCall.custom?.name || "unknown_tool",
      input,
    });
  }

  return {
    id: openaiResp.id || makeMsgId(),
    type: "message",
    role: "assistant",
    model: requestedModel || openaiResp.model,
    content,
    stop_reason: finishReasonToStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

function applyToolChoicePolicy(toolChoice, policy) {
  if (!toolChoice) return undefined;

  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "auto") return "auto";

  if (policy === "drop") return undefined;
  if (policy === "auto-on-forced" && (toolChoice.type === "any" || toolChoice.type === "tool")) return "auto";

  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool") return { type: "function", function: { name: toolChoice.name } };
  return undefined;
}

export function buildOpenAIRequest(anthropicReq, config) {
  const requestedModel = anthropicReq.model || config.defaultModel;
  const upstreamModel = resolveModel(requestedModel, config);
  const body = {
    model: upstreamModel,
    messages: convertMessages(anthropicReq.messages || [], anthropicReq.system),
    max_tokens: anthropicReq.max_tokens || 4096,
    stream: anthropicReq.stream === true,
  };

  for (const [anthropicKey, openaiKey] of [
    ["temperature", "temperature"],
    ["top_p", "top_p"],
    ["stop_sequences", "stop"],
  ]) {
    if (anthropicReq[anthropicKey] !== undefined) body[openaiKey] = anthropicReq[anthropicKey];
  }

  const tools = convertTools(anthropicReq.tools);
  if (tools.length) body.tools = tools;

  const toolChoice = applyToolChoicePolicy(anthropicReq.tool_choice, config.toolChoicePolicy);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;

  if (body.stream) {
    body.stream_options = { include_usage: true };
  }

  return { requestedModel, upstreamModel, body };
}

export function createStreamConverter(model, onEvent) {
  const msgId = makeMsgId();
  const toolBlocks = new Map();
  let started = false;
  let finalized = false;
  let nextContentIndex = 0;
  let textBlockIndex = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let pendingFinishReason = null;

  function ensureStarted() {
    if (started) return;
    started = true;
    onEvent("message_start", {
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", model, content: [], usage: { input_tokens: inputTokens } },
    });
  }

  function closeTextBlock() {
    if (textBlockIndex === null) return;
    onEvent("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
    textBlockIndex = null;
  }

  function ensureTextBlock() {
    if (textBlockIndex !== null) return textBlockIndex;
    const index = nextContentIndex++;
    textBlockIndex = index;
    onEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    return index;
  }

  function ensureToolBlock(toolDelta) {
    const openaiIndex = toolDelta.index ?? 0;
    if (toolBlocks.has(openaiIndex)) return toolBlocks.get(openaiIndex);

    closeTextBlock();
    const index = nextContentIndex++;
    const block = {
      index,
      id: toolDelta.id || `toolu_${Date.now().toString(36)}_${openaiIndex}`,
      name: toolDelta.function?.name || "unknown_tool",
    };
    toolBlocks.set(openaiIndex, block);
    onEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    return block;
  }

  function closeToolBlocks() {
    for (const block of toolBlocks.values()) {
      onEvent("content_block_stop", { type: "content_block_stop", index: block.index });
    }
    toolBlocks.clear();
  }

  function finalize(reason = "stop", usage = {}) {
    if (finalized) return;
    finalized = true;
    ensureStarted();
    closeTextBlock();
    closeToolBlocks();
    onEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: finishReasonToStopReason(reason), stop_sequence: null },
      usage: { output_tokens: usage.completion_tokens ?? outputTokens },
    });
    onEvent("message_stop", { type: "message_stop" });
  }

  return {
    processChunk(chunk) {
      if (finalized) return;

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) return;

      ensureStarted();
      const delta = choice.delta || {};

      if (delta.content) {
        const index = ensureTextBlock();
        onEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      for (const toolDelta of delta.tool_calls || []) {
        const block = ensureToolBlock(toolDelta);
        if (toolDelta.id) block.id = toolDelta.id;
        if (toolDelta.function?.name) block.name = toolDelta.function.name;
        if (toolDelta.function?.arguments) {
          onEvent("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "input_json_delta", partial_json: toolDelta.function.arguments },
          });
        }
      }

      if (choice.finish_reason) {
        pendingFinishReason = choice.finish_reason;
        if (chunk.usage) finalize(choice.finish_reason, chunk.usage);
      }
    },
    end() {
      if (started && !finalized) finalize(pendingFinishReason || "stop");
    },
  };
}

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
      Object.entries(headers).filter(([key]) => !["host", "x-api-key", "authorization", "content-length", "transfer-encoding", "connection", "accept-encoding", "anthropic-version", "anthropic-beta"].includes(key.toLowerCase())),
    ),
  };
}

function upstreamRequest(config, method, requestPath, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    if (!resolveUpstreamApiKey(config, headers)) {
      reject(Object.assign(new Error(`Missing API key for AUTH_MODE=${config.authMode}`), { statusCode: 401, errorType: "authentication_error" }));
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

function anthropicError(status, message, type = "api_error") {
  return { status, body: { type: "error", error: { type, message } } };
}

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
      return sendJson(res, upstream.statusCode, safeJsonParse(errBody, anthropicError(upstream.statusCode, errBody).body));
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-robots-tag": "none",
      "x-opencode-tool-choice-policy": config.toolChoicePolicy,
    });

    let buffer = "";
    const converter = createStreamConverter(requestedModel, (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });

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
    return sendJson(res, upstream.statusCode, safeJsonParse(respBody, anthropicError(upstream.statusCode, respBody).body));
  }

  const anthropicResp = openAIResponseToAnthropic(safeJsonParse(respBody, {}), requestedModel);
  return sendJson(res, 200, anthropicResp, {
    "x-robots-tag": "none",
    "request-id": anthropicResp.id,
    "x-opencode-tool-choice-policy": config.toolChoicePolicy,
  });
}

export function createProxyServer(config = buildConfig()) {
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
    console.log(`\n  OpenCode Go Claude Proxy  v1.0.0`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  Listen : http://${config.host}:${config.port}`);
    console.log(`  Target : ${config.upstreamBaseUrl}`);
    console.log(`  Model  : ${config.defaultModel}`);
    console.log(`  Tools  : ${config.toolChoicePolicy}`);
    console.log();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
