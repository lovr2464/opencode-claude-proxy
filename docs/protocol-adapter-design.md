# Protocol Adapter Design

This proxy exposes an Anthropic Messages API surface to Claude Code and calls an
OpenAI Chat Completions compatible upstream provided by OpenCode Go.

## Contract

Downstream Claude Code sees:

- `POST /v1/messages`
- `GET /v1/models`
- `GET /health`
- Anthropic-shaped JSON errors: `{ "type": "error", "error": { "type", "message" } }`

Upstream OpenCode Go receives:

- `POST /chat/completions`
- `Authorization: Bearer <OPENCODE_API_KEY>`
- OpenAI Chat Completions message and tool schemas

## Product Boundary

In `AUTH_MODE=passthrough`, Claude Code owns:

- the OpenCode Go API key
- the model name it should display and request

The proxy owns:

- the OpenCode Go base URL
- protocol conversion
- optional model aliases or mappings

In `AUTH_MODE=proxy`, proxy configuration owns:

- the real OpenCode Go API key
- the OpenCode Go base URL
- the default model name
- optional model aliases or mappings

Claude Code then only needs the proxy base URL, displayed model name, and a
placeholder key if the client refuses to run without one.

## Model Mapping

By default, Claude Code should request the same model name that OpenCode Go
uses, so the Claude Code UI displays the real model in use.

Example:

```env
DEFAULT_MODEL=kimi-k2.6
MODELS=kimi-k2.6
```

If a provider needs a different upstream model id from the model name shown in
Claude Code, configure `MODEL_MAP` explicitly:

```env
DEFAULT_MODEL=kimi-k2.6
MODEL_MAP=kimi-k2.6=moonshotai/kimi-k2.6-20260420
```

The upstream request uses the mapped model. The Anthropic response reports the
model requested by Claude Code so the UI stays stable.

## Message Conversion

Anthropic input:

- top-level `system` -> OpenAI `role: "system"` message
- user text -> OpenAI `role: "user"` string content
- user image -> OpenAI `image_url` when the source is URL or base64
- assistant `text` + `tool_use` -> OpenAI assistant `content` + `tool_calls`
- user `tool_result` -> OpenAI `role: "tool"` with `tool_call_id`

OpenAI output:

- assistant text -> Anthropic `{ type: "text" }`
- `tool_calls[]` -> Anthropic `{ type: "tool_use" }`
- `finish_reason: "tool_calls"` -> `stop_reason: "tool_use"`

## Streaming Conversion

OpenAI stream chunks are converted to Anthropic SSE events:

1. `message_start`
2. one `content_block_start` per text/tool block
3. multiple `content_block_delta` events for the same block
4. `content_block_stop`
5. `message_delta`
6. one final `message_stop`

The converter ignores upstream comment lines, `[DONE]`, usage-only chunks, and
duplicate finish chunks. Tool-call argument deltas are grouped by OpenAI
`tool_calls[].index` to avoid interleaving multiple tool calls.

## Tool Choice Policy

Some OpenAI-compatible reasoning providers reject forced tool use while thinking
is enabled. OpenCode Go/Kimi returned:

```text
tool_choice 'specified' is incompatible with thinking enabled
```

`TOOL_CHOICE_POLICY=auto-on-forced` is the default. It maps Anthropic
`tool_choice: any` and `tool_choice: tool` to OpenAI `tool_choice: auto`.

Supported policies:

- `auto-on-forced`: prefer Claude Code usability with OpenCode Go
- `passthrough`: send forced tool choice to upstream
- `drop`: omit `tool_choice`

## Current Limits

- Server-side Anthropic tools such as web search and code execution are not
  implemented by the proxy.
- Extended thinking blocks and signatures are not exposed downstream.
- Image support is best effort; text and tool workflows are the primary target.
