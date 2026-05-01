# OpenAI-to-Anthropic API Adapter

[中文说明](docs/README_zh.md) | [Changelog](CHANGELOG.md)

**Got an OpenCode Go subscription but Claude Code doesn't support it?** This adapter bridges the gap. It sits between Claude Code and any OpenAI-compatible API, translating Anthropic↔OpenAI protocols in real time. Use Kimi, DeepSeek, GLM, Qwen, and more — all inside Claude Code.

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
