import test from "node:test";
import assert from "node:assert/strict";

import { buildConfig, resolveModelRoute } from "../src/config.js";

test("builds config from model.openai.list", () => {
  const config = buildConfig({
    settings: {
      proxy: { host: "127.0.0.1", port: 8788, authMode: "proxy", requestTimeoutMs: 12345, logLevel: "silent" },
      upstream: { baseUrl: "https://example.test/v1/", apiKey: "settings-key" },
      model: {
        openai: { list: ["kimi-k2.6", "deepseek-v4-pro"], suffix_path: "chat/completions" },
      },
    },
  });

  assert.equal(config.authMode, "proxy");
  assert.equal(config.port, 8788);
  assert.equal(config.upstreamBaseUrl, "https://example.test/v1");
  assert.equal(config.defaultModel, "kimi-k2.6");
  assert.deepEqual(config.models, ["kimi-k2.6", "deepseek-v4-pro"]);
  assert.equal(config.modelRouting.get("kimi-k2.6").type, "openai");
  assert.equal(config.modelRouting.get("kimi-k2.6").suffix_path, "chat/completions");
});

test("supports both openai and anthropic groups", () => {
  const config = buildConfig({
    settings: {
      proxy: { port: 8787, authMode: "proxy" },
      upstream: { baseUrl: "https://example.test/v1", apiKey: "k" },
      model: {
        openai: { list: ["kimi-k2.6"], suffix_path: "chat/completions" },
        anthropic: { list: ["minimax-m2.7"], suffix_path: "messages" },
      },
    },
  });

  assert.deepEqual(config.models, ["kimi-k2.6", "minimax-m2.7"]);
  assert.equal(config.modelRouting.get("kimi-k2.6").type, "openai");
  assert.equal(config.modelRouting.get("minimax-m2.7").type, "anthropic");
  assert.equal(config.modelRouting.get("minimax-m2.7").suffix_path, "messages");
});

test("resolveModelRoute returns correct route", () => {
  const config = buildConfig({
    settings: {
      proxy: { port: 8787, authMode: "proxy" },
      upstream: { baseUrl: "https://example.test/v1", apiKey: "k" },
      model: {
        openai: { list: ["kimi-k2.6"] },
        anthropic: { list: ["minimax-m2.7"] },
      },
    },
  });

  assert.equal(resolveModelRoute("kimi-k2.6", config).type, "openai");
  assert.equal(resolveModelRoute("minimax-m2.7", config).type, "anthropic");
});

test("throws when model not in any group", () => {
  const config = buildConfig({
    settings: {
      proxy: { port: 8787, authMode: "proxy" },
      upstream: { baseUrl: "https://example.test/v1", apiKey: "k" },
      model: {
        openai: { list: ["kimi-k2.6"] },
      },
    },
  });

  assert.throws(() => resolveModelRoute("unknown-model", config), /not found/);
});

test("default suffix_path for openai is chat/completions", () => {
  const config = buildConfig({
    settings: {
      proxy: { port: 8787, authMode: "proxy" },
      upstream: { baseUrl: "https://example.test/v1", apiKey: "k" },
      model: { openai: { list: ["kimi"] } },
    },
  });

  assert.equal(config.modelRouting.get("kimi").suffix_path, "chat/completions");
});

test("default suffix_path for anthropic is messages", () => {
  const config = buildConfig({
    settings: {
      proxy: { port: 8787, authMode: "proxy" },
      upstream: { baseUrl: "https://example.test/v1", apiKey: "k" },
      model: { anthropic: { list: ["mm"] } },
    },
  });

  assert.equal(config.modelRouting.get("mm").suffix_path, "messages");
});

test("model.default picks from either group", () => {
  const config = buildConfig({
    settings: {
      proxy: { port: 8787, authMode: "proxy" },
      upstream: { baseUrl: "https://example.test/v1", apiKey: "k" },
      model: {
        default: "minimax-m2.7",
        openai: { list: ["kimi-k2.6"] },
        anthropic: { list: ["minimax-m2.7"] },
      },
    },
  });

  assert.equal(config.defaultModel, "minimax-m2.7");
});

test("throws when model appears in both groups", () => {
  assert.throws(
    () =>
      buildConfig({
        settings: {
          upstream: { baseUrl: "https://example.test/v1" },
          model: {
            openai: { list: ["duplicate"] },
            anthropic: { list: ["duplicate"] },
          },
        },
      }),
    /multiple groups/,
  );
});

test("throws when no groups configured", () => {
  assert.throws(
    () =>
      buildConfig({
        settings: { upstream: { baseUrl: "https://example.test/v1" }, model: {} },
      }),
    /openai.*anthropic/,
  );
});
