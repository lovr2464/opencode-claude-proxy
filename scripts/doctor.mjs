import { buildConfig, loadEnv } from "../server.js";

const env = { ...loadEnv(), ...process.env };
const config = buildConfig(env);
const baseUrl = `http://${config.host}:${config.port}`;

console.log("OpenCode Go Claude Proxy doctor");
console.log("----------------------------------");
console.log(`local:  ${baseUrl}`);
console.log(`target: ${config.upstreamBaseUrl}`);
console.log(`model:  ${config.defaultModel}`);
console.log(`auth:   ${config.authMode}`);
console.log(`tools:  ${config.toolChoicePolicy}`);
console.log(`key:    ${config.authMode === "proxy" ? (config.apiKey ? "present" : "missing") : "managed by Claude Code"}`);

async function check(url, label) {
  try {
    const response = await fetch(url, { headers: { "x-api-key": "doctor" } });
    const text = await response.text();
    console.log(`${label}: ${response.status} ${text.slice(0, 300)}`);
    return response.ok;
  } catch (error) {
    console.log(`${label}: failed (${error.message})`);
    return false;
  }
}

await check(`${baseUrl}/health`, "health");
await check(`${baseUrl}/v1/models`, "models");
