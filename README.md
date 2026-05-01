# OpenAI-to-Anthropic API Adapter

[中文说明](docs/README_zh.md) | [Changelog](CHANGELOG.md)

**Got an OpenCode Go subscription but Claude Code doesn't support it?** This adapter bridges the gap. Use Kimi, DeepSeek, GLM, Qwen, and more — all inside Claude Code.

The proxy does exactly three things:

1. **Protocol translation** — Anthropic Messages API ↔ OpenAI Chat Completions
2. **Timeout control** — upstream request timeout (`proxy.requestTimeoutMs`)
3. **Model routing** — which model goes to which upstream endpoint

It does NOT set model parameters (temperature, max_tokens, context size, etc.) — those pass through from Claude Code unchanged.

## Requirements

- **Node.js** ≥ 18
- **macOS** — tested and supported
- **Linux / Windows** — not tested, may work (Node.js HTTP server, no platform-specific code) but not guaranteed

## Quick Start

```bash
./start.sh                   # first run: enter API key → auto-creates settings.json + starts proxy
./start.sh setup-claude      # one-time: writes 3 env vars to ~/.claude/settings.json
./start.sh install           # optional: auto-start on login, restart if crashed
```

Done. Open Claude Code, select the model from the picker.

All commands: `./start.sh [start|stop|restart|status|install|uninstall|setup-claude]`

## What `./start.sh` does on first run

It asks 4 questions. Press Enter to accept the default (shown in brackets):

```
OpenCode Go API key: sk-xxx
Upstream base URL [https://opencode.ai/zen/go/v1]: ↵
Models [kimi-k2.6 deepseek-v4-pro glm-5.1 qwen3.6-plus]: ↵
Listen port [8787]: ↵
```

This creates `settings.json` and starts the proxy.

## What `setup-claude` does

Writes exactly 3 env vars to `~/.claude/settings.json`. Never touches your existing config:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "local-proxy-key",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "kimi-k2.6"
  }
}
```

## Switching models

Edit `~/.claude/settings.json` and change `ANTHROPIC_CUSTOM_MODEL_OPTION` to any model in your `settings.json` → `model.openai.list`. Or add multiple slots:

```json
"ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k2.6",
"ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]"
```

**DeepSeek V4 Pro has 1M context** — append `[1m]` so Claude Code shows the correct context window. The proxy strips this before sending upstream.

## Settings Reference

### proxy

| Key | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | Listen address |
| `port` | `8787` | Listen port |
| `authMode` | `proxy` | `proxy` = key in settings.json. `passthrough` = key from Claude Code |
| `requestTimeoutMs` | `300000` | Upstream timeout (5 min) |
| `logLevel` | `info` | `info` or `silent` |

### upstream

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `https://opencode.ai/zen/go/v1` | Upstream API base URL |
| `apiKey` | (your key) | OpenCode Go API key |

### model

| Key | Default | Meaning |
| --- | --- | --- |
| `openai.list` | `kimi-k2.6, deepseek-v4-pro, glm-5.1, qwen3.6-plus` | Model names. Pass through to upstream unchanged |
| `openai.suffix_path` | `chat/completions` | Upstream endpoint. For Anthropic-native models, add an `anthropic` group instead |

## Manual Claude Code / Claude Desktop configuration

`./start.sh setup-claude` handles this automatically, but if you prefer to configure manually:

### Claude Code CLI

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "local-proxy-key",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "kimi-k2.6"
  }
}
```

To add more models as quick-switch slots:

```json
"ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k2.6",
"ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]",
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.1"
```

### Claude Desktop (macOS app)

Open Claude → Settings → Developer → Edit Config. This opens `claude_desktop_config.json`. Add the same `env` block under the top-level `"env"` key.

### Notes

- `ANTHROPIC_API_KEY` can be any non-empty string in proxy mode — the real key is in `settings.json`.
- Model names must match entries in `settings.json` → `model.openai.list`.
- `[1m]` suffix is a Claude Code display hint for context window size. The proxy strips it before sending upstream.
- If you set multiple `DEFAULT_*_MODEL` slots, switch models in Claude Code by changing the active model slot (Sonnet / Opus / Haiku).

## Troubleshooting

**401/403 on upstream.** `upstream.apiKey` is wrong or expired.

**Response only has thinking, no text.** Reasoning models eat tokens. Increase `max_tokens` or add `"behavior": { "reasoningMode": "drop" }` to settings.json.

**"model not found".** The model isn't in `model.openai.list`. Run `./start.sh status` to see available models.

**Proxy not responding.** Run `./start.sh status`. Restart: `./start.sh restart`.

## Development

```bash
npm test        # 30 tests, no API key needed
npm run dev     # auto-restart on file changes
```

## License

MIT
