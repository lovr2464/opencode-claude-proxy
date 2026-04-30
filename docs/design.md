# Design: OpenAI-to-Anthropic API Adapter

## Goal

The adapter lets Claude Code use an OpenAI-compatible Chat Completions backend while Claude Code continues to speak the Anthropic Messages API.

The product boundary is intentionally small:

- Downstream surface: Anthropic-compatible `/v1/messages`, `/v1/models`, and `/health`.
- Upstream surface: OpenAI-compatible `/chat/completions`.
- Configuration surface: one local `settings.json` file.

OpenCode Go is an important target because it can expose models such as Kimi, DeepSeek, and Qwen through an OpenAI-compatible endpoint. The design does not depend on OpenCode Go specifically; any sufficiently compatible OpenAI-style provider should work.

## Runtime Shape

```text
Claude Code
  |
  | Anthropic Messages API
  v
Local adapter
  |
  | OpenAI Chat Completions API
  v
OpenAI-compatible upstream
```

Claude Code never talks directly to the upstream provider in the recommended mode. It talks to the local adapter with a placeholder API key and placeholder model name.

## Configuration Model

`settings.json` is the only adapter configuration file.

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

Claude Code has its own settings file. Users configure Claude Code there with:

- `ANTHROPIC_BASE_URL`: the local adapter URL.
- `ANTHROPIC_API_KEY`: a placeholder key when `proxy.authMode` is `proxy`.
- model variables: the placeholder model name, usually `model.claudeId`.

This separation keeps provider secrets in the adapter process and keeps Claude Code configuration familiar.

## Authentication

Two modes are supported:

- `proxy`: the adapter uses `upstream.apiKey` for upstream requests. Claude Code may send any non-empty placeholder key.
- `passthrough`: the adapter forwards Claude Code's `ANTHROPIC_API_KEY` as the upstream bearer token.

`proxy` is the recommended mode because it avoids putting the real upstream key in Claude Code settings.

## Model Mapping

Claude Code requests a stable Anthropic-side model id such as `opencode-go`. The adapter maps that id to the real upstream model id such as `kimi-k2.6`.

Resolution order:

1. `model.map[requestedModel]`
2. `model.map["*"]`
3. requested model unchanged

If `model.upstreamId` differs from `model.claudeId` and no explicit mapping is provided for `model.claudeId`, the adapter adds that default mapping internally.

Responses report the Claude-facing model id so Claude Code sees a stable model name.

## Message Conversion

Request conversion:

| Anthropic input | OpenAI output |
| --- | --- |
| top-level `system` | `role: "system"` message |
| user `text` | user text content |
| user `image` URL/base64 | `image_url` content part |
| assistant `text` | assistant `content` |
| assistant `tool_use` | assistant `tool_calls` |
| user `tool_result` | `role: "tool"` with `tool_call_id` |
| `thinking` / `redacted_thinking` | `reasoning_content` when enabled |

Response conversion:

| OpenAI input | Anthropic output |
| --- | --- |
| assistant text | `{ "type": "text" }` block |
| `tool_calls[]` | `{ "type": "tool_use" }` block |
| `finish_reason: "tool_calls"` | `stop_reason: "tool_use"` |
| `reasoning_content` / `reasoning` | `{ "type": "thinking" }` block |

Tool errors are preserved in tool result text so the next model turn can reason over failures.

## Streaming

OpenAI SSE chunks are translated into Anthropic event order:

1. `message_start`
2. `content_block_start`
3. `content_block_delta`
4. `content_block_stop`
5. `message_delta`
6. `message_stop`

The stream converter handles:

- text deltas
- reasoning deltas
- one or more tool calls
- interleaved tool-call argument chunks
- providers that stream tool arguments before tool id/name
- duplicate finish chunks
- usage-only chunks
- `[DONE]` and comment lines

## Tool Choice Policy

Some reasoning models reject forced tool choice while thinking is enabled. The adapter therefore defaults to a Claude Code oriented policy:

- Anthropic `tool_choice: auto` stays OpenAI `auto`.
- Anthropic `tool_choice: any` becomes OpenAI `auto`.
- Anthropic `tool_choice: tool` becomes OpenAI `auto`.

This preserves Claude Code tool loops with providers that do not accept forced tool choice in reasoning mode.

## Reasoning Conversion

The default mode converts reasoning in both directions:

- Anthropic `thinking` blocks become OpenAI `reasoning_content`.
- OpenAI `reasoning_content` or provider-specific `reasoning` fields become Anthropic `thinking` blocks.
- Assistant tool-call messages receive `reasoning_content` when needed for reasoning-model compatibility.

Anthropic thinking signatures are emitted as empty strings because OpenAI-compatible providers do not implement Anthropic's signature mechanism.

## Error Handling

The adapter normalizes errors into Anthropic-shaped responses:

```json
{
  "type": "error",
  "error": {
    "type": "api_error",
    "message": "..."
  }
}
```

Invalid upstream success bodies are treated as upstream failures instead of returning empty assistant messages.

## Current Limits

- Server-side Anthropic tools such as hosted web search and hosted code execution are not implemented.
- Image conversion is best effort; text and tool workflows are the primary target.
- The adapter targets Chat Completions style upstreams, not the newer OpenAI Responses API.
