import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import { createProxyServer } from "../server.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

function startMockUpstream(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    await handler(req, res, body);
  });
  return listen(server).then((baseUrl) => ({ server, baseUrl, requests }));
}

function parseSse(text) {
  return text
    .trim()
    .split("\n\n")
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1] || "{}");
      return { event, data };
    });
}

async function startProxy(upstreamBaseUrl, overrides = {}) {
  const server = createProxyServer({
    apiKey: "test-key",
    authMode: "proxy",
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl,
    defaultModel: "kimi-k2.6",
    models: ["kimi-k2.6"],
    modelRouting: new Map([["kimi-k2.6", { type: "openai", suffix_path: "chat/completions" }]]),
    requestTimeoutMs: 5000,
    toolChoicePolicy: "auto-on-forced",
    logLevel: "silent",
    ...overrides,
  });
  const baseUrl = await listen(server);
  return { server, baseUrl };
}

test("proxies non-streaming messages through mock OpenAI upstream", async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_1",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "proxy-ok" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    );
  });
  const proxy = await startProxy(upstream.baseUrl);

  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "local", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "kimi-k2.6",
        max_tokens: 64,
        system: "You are concise.",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, "kimi-k2.6");
    assert.equal(body.content[0].text, "proxy-ok");
    assert.equal(upstream.requests[0].url, "/chat/completions");
    assert.equal(upstream.requests[0].body.model, "kimi-k2.6");
    assert.equal(upstream.requests[0].body.messages[0].role, "system");
    assert.equal(upstream.requests[0].headers["accept-encoding"], undefined);
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("passes downstream API key upstream in passthrough auth mode", async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_auth",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "auth-ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
  });
  const proxy = await startProxy(upstream.baseUrl, { authMode: "passthrough" });

  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "real-downstream-key" },
      body: JSON.stringify({
        model: "kimi-k2.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(upstream.requests[0].headers.authorization, "Bearer real-downstream-key");
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("proxies streaming chunks as Anthropic SSE", async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"stream"},"finish_reason":null}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"-ok"},"finish_reason":null}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":6}}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const proxy = await startProxy(upstream.baseUrl);

  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k2.6",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const events = parseSse(await response.text());
    assert.deepEqual(
      events.map((item) => item.event),
      ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
    );
    assert.equal(events[2].data.delta.text + events[3].data.delta.text, "stream-ok");
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("normalizes upstream OpenAI-shaped errors to Anthropic errors", async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "bad request" } }));
  });
  const proxy = await startProxy(upstream.baseUrl);

  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "kimi-k2.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(body.error.message, "bad request");
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("rejects invalid upstream success bodies instead of returning empty messages", async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>not json</html>");
  });
  const proxy = await startProxy(upstream.baseUrl);

  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "local" },
      body: JSON.stringify({
        model: "kimi-k2.6",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "upstream_error");
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("returns Anthropic-shaped 404 errors", async () => {
  const upstream = await startMockUpstream(() => {});
  const proxy = await startProxy(upstream.baseUrl);

  try {
    const response = await fetch(`${proxy.baseUrl}/missing`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "not_found_error");
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});
