# OpenCode Go Claude Proxy

Anthropic Messages API compatible proxy for using an OpenCode Go package from
Claude Code.

Claude Code talks to this local service as if it were an Anthropic-compatible
API. The proxy translates requests to OpenAI Chat Completions and forwards them
to OpenCode Go.

## Status

Implemented:

- `POST /v1/messages`
- `GET /v1/models`
- `GET /health`
- non-streaming text responses
- Anthropic SSE streaming
- custom tool calls and tool results
- Claude-facing model names mapped to OpenCode Go model names
- passthrough or proxy-managed upstream API keys
- Anthropic-shaped errors
- local mock upstream tests

## Setup

```bash
cp .env.example .env
```

Edit `.env`. The model name here is the model Claude Code should display and
request:

```env
OPENCODE_API_KEY=your-opencode-go-api-key
OPENCODE_BASE_URL=https://opencode.ai/zen/go/v1
AUTH_MODE=passthrough
DEFAULT_MODEL=kimi-k2.6
MODELS=kimi-k2.6
```

With `AUTH_MODE=passthrough`, Claude Code owns the OpenCode Go API key and the
proxy only forwards it upstream.

Start the proxy:

```bash
npm start
```

Check it:

```bash
npm run doctor
```

## Claude Code

Print the environment variables Claude Code needs. These variables tell Claude
Code which local proxy and model name to use. The same model name should be set
in the proxy `.env`, so Claude Code displays the real model being used.

```bash
npm run claude:print-env
```

Typical output:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_DEFAULT_SONNET_MODEL=kimi-k2.6
export ANTHROPIC_DEFAULT_OPUS_MODEL=kimi-k2.6
export ANTHROPIC_DEFAULT_HAIKU_MODEL=kimi-k2.6
export CLAUDE_CODE_SUBAGENT_MODEL=kimi-k2.6
```

For `AUTH_MODE=passthrough`, set Claude Code's `ANTHROPIC_API_KEY` to the real
OpenCode Go key.

For `AUTH_MODE=proxy`, keep the real key in `.env` as `OPENCODE_API_KEY`. If
Claude Code requires an API key for a custom `ANTHROPIC_BASE_URL`, you can print
an explicit placeholder:

```bash
npm run claude:print-env -- --with-placeholder-key
```

In `proxy` mode, the proxy does not trust or forward Claude Code's downstream
API key. It always uses `OPENCODE_API_KEY` from `.env` for upstream requests.

## Configuration

| Variable | Purpose |
| --- | --- |
| `AUTH_MODE` | `passthrough` or `proxy` |
| `OPENCODE_API_KEY` | OpenCode Go API key used upstream when `AUTH_MODE=proxy` |
| `OPENCODE_BASE_URL` | OpenAI-compatible base URL, usually `https://opencode.ai/zen/go/v1` |
| `HOST` / `PORT` | Local listen address |
| `DEFAULT_MODEL` | Claude-facing default model |
| `MODELS` | Models returned by `/v1/models` |
| `MODEL_MAP` | Optional comma-separated `displayed_model=upstream_model` pairs |
| `TOOL_CHOICE_POLICY` | `auto-on-forced`, `passthrough`, or `drop` |
| `REQUEST_TIMEOUT_MS` | Upstream request timeout |
| `LOG_LEVEL` | `info` or `silent` |

## Development

```bash
npm run check
npm test
```

The tests use a local mock OpenAI upstream and do not call OpenCode Go.

## Design

See [docs/protocol-adapter-design.md](docs/protocol-adapter-design.md).
