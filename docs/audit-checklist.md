# Local Audit Checklist

Run this before publishing the project.

## 1. Static and Mock Tests

```bash
npm run check
npm test
```

Expected result: all tests pass.

## 2. Start on a Temporary Port

Use a temporary port if `8787` is already occupied.

```bash
PORT=8788 npm start
```

In another terminal:

```bash
PORT=8788 npm run doctor
```

Expected result: `/health` and `/v1/models` return `200`.

## 3. Non-Streaming Smoke

```bash
curl --noproxy '*' -sS http://127.0.0.1:8788/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'x-api-key: local-test' \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "Reply with exactly: proxy-ok"}]
  }'
```

Expected result: Anthropic-shaped `message` JSON with a text content block.

## 4. Streaming Smoke

```bash
curl --noproxy '*' -sS -N http://127.0.0.1:8788/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'x-api-key: local-test' \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "stream": true,
    "messages": [{"role": "user", "content": "Reply with exactly: stream-ok"}]
  }'
```

Expected result: one `message_start`, one text content block with one or more
`content_block_delta` events, one `message_delta`, and one `message_stop`.

## 5. Claude Code Environment

```bash
PORT=8788 npm run claude:print-env
```

Apply the printed variables in a shell, then start Claude Code from that shell.
Claude Code should know the proxy address and the model name it should display.
This model name should match `DEFAULT_MODEL` in the proxy `.env`.

For `AUTH_MODE=passthrough`, Claude Code's `ANTHROPIC_API_KEY` must be the real
OpenCode Go key.

If Claude Code requires a custom API key for a custom base URL, use:

```bash
PORT=8788 npm run claude:print-env -- --with-placeholder-key
```

Use that placeholder only with `AUTH_MODE=proxy`.

Run a small file-inspection or command task and confirm tool calls complete.

## 6. Publish Gate

Do not publish until:

- `.env` is not staged
- tests pass
- README setup works from a clean clone
- Claude Code smoke test succeeds
- repository name and GitHub visibility are confirmed
