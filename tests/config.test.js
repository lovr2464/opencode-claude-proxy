import test from "node:test";
import assert from "node:assert/strict";

import { buildConfig } from "../src/config.js";

test("builds proxy config from settings.json shape", () => {
  const config = buildConfig({
    settings: {
      proxy: {
        host: "127.0.0.1",
        port: 8788,
        authMode: "proxy",
        requestTimeoutMs: 12345,
        logLevel: "silent",
      },
      upstream: {
        baseUrl: "https://example.test/v1/",
        apiKey: "settings-key",
      },
      model: {
        claudeId: "opencode-go",
        upstreamId: "kimi-k2.6",
        list: ["opencode-go"],
      },
    },
  });

  assert.equal(config.authMode, "proxy");
  assert.equal(config.port, 8788);
  assert.equal(config.upstreamBaseUrl, "https://example.test/v1");
  assert.equal(config.apiKey, "settings-key");
  assert.equal(config.defaultModel, "opencode-go");
  assert.deepEqual(config.models, ["opencode-go"]);
  assert.equal(config.modelMap.get("opencode-go"), "kimi-k2.6");
  assert.equal(config.claudeCode.baseUrl, "http://127.0.0.1:8788");
  assert.equal(config.claudeCode.apiKey, "opencode-go-local");
  assert.equal(config.claudeCode.modelId, "opencode-go");
  assert.equal(config.toolChoicePolicy, "auto-on-forced");
  assert.equal(config.reasoningMode, "auto");
});

test("adds default model mapping from upstreamId when map is omitted", () => {
  const config = buildConfig({
    settings: {
      proxy: { port: 8787, authMode: "proxy" },
      upstream: { baseUrl: "https://settings.test/v1", apiKey: "settings-key" },
      model: {
        claudeId: "opencode-go",
        upstreamId: "kimi-k2.6",
        list: ["opencode-go"],
      },
    },
  });

  assert.equal(config.defaultModel, "opencode-go");
  assert.equal(config.modelMap.get("opencode-go"), "kimi-k2.6");
});

test("requires upstream base URL in settings", () => {
  assert.throws(
    () =>
      buildConfig({
        settings: {
          upstream: { apiKey: "settings-key" },
          model: { claudeId: "opencode-go", upstreamId: "kimi-k2.6" },
        },
      }),
    /Set upstream\.baseUrl in settings\.json/,
  );
});
