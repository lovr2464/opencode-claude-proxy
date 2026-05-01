import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

export function loadSettings(settingsPath = process.env.PROXY_SETTINGS || path.join(rootDir, "settings.json")) {
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Settings file not found: ${settingsPath}`);
  }

  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (error) {
    throw new Error(`Invalid settings file ${settingsPath}: ${error.message}`);
  }
}

export function loadConfigSources(env = process.env) {
  const settingsPath = env.PROXY_SETTINGS || path.join(rootDir, "settings.json");

  return {
    settings: loadSettings(settingsPath),
    settingsPath,
  };
}

export function buildConfig(input = loadConfigSources()) {
  const settings = input?.settings || input || {};

  const upstream = settings.upstream || {};
  const upstreamBaseUrl = upstream.baseUrl;
  if (!upstreamBaseUrl) {
    throw new Error("Missing upstream base URL. Set upstream.baseUrl in settings.json");
  }

  const model = settings.model || {};
  const groups = resolveModelGroups(model);

  const proxy = settings.proxy || {};

  return {
    apiKey: upstream.apiKey || "",
    authMode: proxy.authMode || "proxy",
    port: Number.parseInt(proxy.port || "8787", 10),
    host: proxy.host || "127.0.0.1",
    upstreamBaseUrl: upstreamBaseUrl.replace(/\/$/, ""),
    defaultModel: groups.defaultModel,
    models: groups.models,
    modelRouting: groups.routing,
    groups: groups.sections,
    requestTimeoutMs: Number.parseInt(proxy.requestTimeoutMs || "300000", 10),
    toolChoicePolicy: (settings.behavior || {}).toolChoicePolicy || "auto-on-forced",
    reasoningMode: (settings.behavior || {}).reasoningMode || "auto",
    logLevel: proxy.logLevel || "info",
    logFile: proxy.logFile !== false ? (proxy.logFile || path.join(rootDir, "proxy.log")) : null,
  };
}

function resolveModelGroups(model) {
  const openai = model.openai || {};
  const anthropic = model.anthropic || {};

  const openaiList = normalizeList(openai.list);
  const anthropicList = normalizeList(anthropic.list);

  if (openaiList.length === 0 && anthropicList.length === 0) {
    throw new Error(
      "model.openai.list or model.anthropic.list is required.\n" +
        "Example: \"model\": { \"openai\": { \"list\": [\"kimi-k2.6\"] } }",
    );
  }

  const routing = new Map();
  const allModels = [];
  const sections = [];

  if (openaiList.length > 0) {
    const suffix = openai.suffix_path || "chat/completions";
    for (const m of openaiList) {
      if (routing.has(m)) throw new Error(`Model "${m}" appears in multiple groups`);
      routing.set(m, { type: "openai", suffix_path: suffix });
      allModels.push(m);
    }
    sections.push({ type: "openai", list: openaiList, suffix_path: suffix });
  }

  if (anthropicList.length > 0) {
    const suffix = anthropic.suffix_path || "messages";
    for (const m of anthropicList) {
      if (routing.has(m)) throw new Error(`Model "${m}" appears in multiple groups`);
      routing.set(m, { type: "anthropic", suffix_path: suffix });
      allModels.push(m);
    }
    sections.push({ type: "anthropic", list: anthropicList, suffix_path: suffix });
  }

  const defaultModel = model.default && routing.has(model.default)
    ? model.default
    : allModels[0];

  return { defaultModel, models: allModels, routing, sections };
}

function normalizeList(list) {
  if (!list || !Array.isArray(list)) return [];
  return list.map((s) => String(s).trim()).filter(Boolean);
}

export function resolveModelRoute(requestedModel, config) {
  const route = config.modelRouting.get(requestedModel || config.defaultModel);
  if (!route) {
    throw new Error(
      `Model "${requestedModel || config.defaultModel}" not found in model.openai.list or model.anthropic.list`,
    );
  }
  return route;
}
