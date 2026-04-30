# OpenAI-to-Anthropic API Adapter

[中文说明](docs/README_zh.md) | [Design](docs/design.md) | [设计文档](docs/design_zh.md)

A local adapter that exposes an Anthropic Messages API surface and forwards requests to an OpenAI-compatible Chat Completions endpoint.

Some providers expose useful models only through an OpenAI-compatible API. For example, OpenCode Go may provide models such as Kimi, DeepSeek, or Qwen through an OpenAI-style endpoint; this adapter lets Claude Code use those models by translating Anthropic API requests and responses.

## Quick Start

1. Edit `settings.json`.

Keep the committed file as a template when publishing. Do not commit a real upstream API key.

```json
{
  "proxy": {
    "host": "127.0.0.1",
    "port": 8787,
    "authMode": "proxy",
    "requestTimeoutMs": 300000,
    "logLevel": "info"
  },
  "upstream": {
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "apiKey": "your-opencode-go-api-key"
  },
  "model": {
    "claudeId": "opencode-go",
    "upstreamId": "kimi-k2.6",
    "list": ["opencode-go"],
    "map": {
      "opencode-go": "kimi-k2.6"
    }
  }
}
```

2. Start the adapter.

```bash
./start.sh
```

You can also start it directly:

```bash
node server.js
```

By default it listens on `http://127.0.0.1:8787`.

## Configure Claude Code

Configure Claude Code's own settings file to point to the local adapter. Use a placeholder API key and the same placeholder model name as `model.claudeId` in `settings.json`.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "opencode-go-local",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "opencode-go",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opencode-go",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "opencode-go",
    "CLAUDE_CODE_SUBAGENT_MODEL": "opencode-go",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "opencode-go",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "OpenAI-compatible model via local adapter",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "Anthropic Messages API backed by an OpenAI-compatible endpoint"
  }
}
```

With the recommended `proxy.authMode: "proxy"`, Claude Code only sees `opencode-go-local`; the real upstream key stays in this project's `settings.json`.

## Settings Reference

| Setting | Meaning |
| --- | --- |
| `proxy.host` | Local listen host. Use `127.0.0.1` for local-only access. |
| `proxy.port` | Local listen port. Claude Code's `ANTHROPIC_BASE_URL` must use this port. |
| `proxy.authMode` | `proxy` keeps the real upstream key in `settings.json`; `passthrough` forwards Claude Code's `ANTHROPIC_API_KEY` upstream. |
| `proxy.requestTimeoutMs` | Timeout for upstream requests, in milliseconds. |
| `proxy.logLevel` | `info` logs startup and request errors; `silent` reduces logs. |
| `upstream.baseUrl` | OpenAI-compatible API base URL. The adapter calls `${baseUrl}/chat/completions`. |
| `upstream.apiKey` | Real upstream API key when `authMode` is `proxy`. |
| `model.claudeId` | Placeholder model id used by Claude Code. |
| `model.upstreamId` | Real upstream model id. Used as the default mapping target. |
| `model.list` | Models returned by `/v1/models` to Claude Code. Usually just the placeholder id. |
| `model.map` | Maps Claude-facing model ids to real upstream model ids. |

The default protocol behavior is intentionally opinionated for Claude Code:

- Anthropic `tool_choice: any` and `tool_choice: tool` are downgraded to OpenAI `tool_choice: auto` for reasoning-model compatibility.
- Anthropic thinking blocks and OpenAI `reasoning_content` / `reasoning` fields are converted both ways.
- Streaming SSE events are translated into Anthropic Messages API event order.

## Endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/v1/messages` | POST | Anthropic Messages-compatible chat endpoint. Supports streaming and non-streaming requests. |
| `/v1/models` | GET | Anthropic-shaped model list based on `model.list`. |
| `/health` | GET | Health check with non-secret configuration summary. |

## Development

```bash
npm run check
npm test
npm run dev
npm run doctor
```

Tests use a local mock upstream and do not require an API key.

## Design

For architecture, protocol mapping, streaming behavior, and known limits, see [docs/design.md](docs/design.md). The Chinese version is [docs/design_zh.md](docs/design_zh.md).

## License

MIT
