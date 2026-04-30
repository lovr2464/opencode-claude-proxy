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
- Anthropic-shaped errors
- local mock upstream tests

## Setup

```bash
cp .env.example .env
```

Edit `.env`:

```env
OPENCODE_API_KEY=your-opencode-go-api-key
OPENCODE_BASE_URL=https://opencode.ai/zen/go/v1
DEFAULT_MODEL=claude-sonnet-4-5
MODEL_MAP=claude-sonnet-4-5=kimi-k2.6,claude-opus-4-5=kimi-k2.6,claude-haiku-4-5=kimi-k2.6
```

Start the proxy:

```bash
npm start
```

Check it:

```bash
npm run doctor
```

## Claude Code

Print the environment variables Claude Code needs:

```bash
npm run claude:print-env
```

Typical output:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=opencode-go-local
export ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-5
export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-4-5
export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-sonnet-4-5
export CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-4-5
```

Claude Code only needs a placeholder `ANTHROPIC_API_KEY`; the real OpenCode Go
key stays in this proxy's `.env`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `OPENCODE_API_KEY` | OpenCode Go API key used upstream |
| `OPENCODE_BASE_URL` | OpenAI-compatible base URL, usually `https://opencode.ai/zen/go/v1` |
| `HOST` / `PORT` | Local listen address |
| `DEFAULT_MODEL` | Claude-facing default model |
| `MODELS` | Models returned by `/v1/models` |
| `MODEL_MAP` | Comma-separated `claude_model=upstream_model` pairs |
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
