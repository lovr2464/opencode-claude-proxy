import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

export function loadSettings(settingsPath = process.env.PROXY_SETTINGS || path.join(rootDir, "settings.json")) {
  if (!fs.existsSync(settingsPath)) return {};

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
  const proxy = settings.proxy || {};
  const upstream = settings.upstream || {};
  const model = settings.model || settings.models || {};
  const behavior = settings.behavior || {};
  const claudeCode = settings.claudeCode || {};

  const upstreamBaseUrl = upstream.baseUrl || settings.upstreamBaseUrl;
  if (!upstreamBaseUrl) {
    throw new Error("Missing upstream base URL. Set upstream.baseUrl in settings.json");
  }

  const host = proxy.host || "127.0.0.1";
  const port = Number.parseInt(proxy.port || "8787", 10);
  const defaultModel = model.claudeId || model.default || settings.defaultModel || "opencode-go";
  const upstreamModel = model.upstreamId || settings.upstreamModel || "";
  const modelMap = new Map();
  mergeModelMap(modelMap, model.map || settings.modelMap);
  if (upstreamModel && upstreamModel !== defaultModel && !modelMap.has(defaultModel)) {
    modelMap.set(defaultModel, upstreamModel);
  }

  const apiKey = upstream.apiKey || settings.apiKey || "";
  const authMode = proxy.authMode || settings.authMode || "proxy";
  const localBaseUrl = claudeCode.baseUrl || `http://${host}:${port}`;
  const claudeModel = claudeCode.modelId || defaultModel;

  return {
    apiKey,
    authMode,
    port,
    host,
    upstreamBaseUrl: upstreamBaseUrl.replace(/\/$/, ""),
    defaultModel,
    models: toStringArray(model.list || model.available || settings.modelsList) || [defaultModel],
    modelMap,
    requestTimeoutMs: Number.parseInt(proxy.requestTimeoutMs || "300000", 10),
    toolChoicePolicy: behavior.toolChoicePolicy || "auto-on-forced",
    reasoningMode: behavior.reasoningMode || "auto",
    logLevel: proxy.logLevel || "info",
    claudeCode: {
      baseUrl: localBaseUrl,
      apiKey: claudeCode.apiKey || (authMode === "proxy" ? "opencode-go-local" : apiKey),
      modelId: claudeModel,
      customModelOption: claudeCode.customModelOption || claudeModel,
      customModelOptionName: claudeCode.customModelOptionName || "OpenAI-compatible model via local adapter",
      customModelOptionDescription:
        claudeCode.customModelOptionDescription || "Anthropic Messages API backed by an OpenAI-compatible endpoint",
    },
  };
}

function mergeModelMap(map, value) {
  if (!value) return map;
  if (value instanceof Map) {
    for (const [from, to] of value.entries()) if (from && to) map.set(from, to);
    return map;
  }
  for (const [from, to] of Object.entries(value)) {
    if (from && to) map.set(from, String(to));
  }
  return map;
}

function toStringArray(value) {
  if (!Array.isArray(value)) return null;
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  return items.length ? items : null;
}

export function resolveModel(requestedModel, config) {
  const model = requestedModel || config.defaultModel;
  return config.modelMap.get(model) || config.modelMap.get("*") || model;
}
