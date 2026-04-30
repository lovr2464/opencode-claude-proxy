import { buildConfig, loadEnv } from "../server.js";

const config = buildConfig({ ...loadEnv(), ...process.env });
const baseUrl = `http://${config.host}:${config.port}`;
const apiKey = process.env.CLAUDE_PROXY_API_KEY || "opencode-go-local";

console.log(`# Claude Code environment`);
console.log(`export ANTHROPIC_BASE_URL=${baseUrl}`);
console.log(`export ANTHROPIC_DEFAULT_SONNET_MODEL=${config.defaultModel}`);
console.log(`export ANTHROPIC_DEFAULT_OPUS_MODEL=${config.defaultModel}`);
console.log(`export ANTHROPIC_DEFAULT_HAIKU_MODEL=${config.defaultModel}`);
console.log(`export CLAUDE_CODE_SUBAGENT_MODEL=${config.defaultModel}`);
console.log(`export ANTHROPIC_CUSTOM_MODEL_OPTION=${config.defaultModel}`);
console.log(`export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="OpenCode Go via local proxy"`);
console.log(`export ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION="Anthropic Messages API backed by OpenCode Go"`);

if (process.argv.includes("--with-placeholder-key")) {
  console.log(`export ANTHROPIC_API_KEY=${apiKey}`);
}
