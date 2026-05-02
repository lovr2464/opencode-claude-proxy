# Changelog

## 1.2.1 — 2026-05-02

### Fixed

- **Moonshot MFJS schema sanitization** for Kimi K2.6 compatibility:
  - Strips unsupported JSON Schema keywords (`format`, `allOf`, `exclusiveMinimum`, etc.)
  - Normalizes `type` arrays (`["string", "null"]`) to single string
  - Auto-creates missing `properties` and `type: "object"`
  - Removes `type` when coexisting with `anyOf`/`$ref`
  - Pushes parent `properties`/`required` into `anyOf` branches to avoid keyword conflicts
  - Filters invalid property names (e.g. `{{userName}}`) that break Moonshot path parser
  - Progressive size simplification: strips descriptions → flattens nested objects → falls back to `{}` when schema exceeds 14 KB (Moonshot limit 15 KB)
- **start.sh reliability**: `stop` now SIGKILL after graceful timeout, `restart` waits up to 10s and force-kills stale processes, stdout/stderr appends to `proxy.log`
- **Error log truncation**: passthrough path now logs up to 2000 chars (was 200)

## 1.2.0 — 2026-05-01

### Breaking

- Model config simplified: `model.list` replaces `claudeId`/`upstreamId`/`list`/`map`. Use `model.openai.list` or `model.anthropic.list`.
- Model names pass through to upstream unchanged — no more mapping layer.

### Added

- Multi-protocol support: `model.openai` (Anthropic↔OpenAI conversion) and `model.anthropic` (passthrough).
- Per-group `suffix_path` for different upstream endpoints.
- Daemon management: `./start.sh start|stop|restart|status`.
- File logging: requests written to `proxy.log`.
- Friendly error messages for DNS, timeout, auth failures.
- `settings.example.json` template.
- GitHub Actions CI.
- `--help` via `./start.sh`.

### Changed

- `start.sh` now displays config summary, model list with protocol tags, and Claude Code settings block.
- Server banner is now a single line.

### Removed

- `.env` file (never read by code).
- `model.claudeId`, `model.upstreamId`, `model.list` flat fields.
- `model.map` — models pass through directly now.

## 1.1.0 — 2026-04-30

- Initial release.
- Anthropic↔OpenAI protocol translation.
- Streaming SSE conversion.
- `proxy` and `passthrough` auth modes.
- Tool choice policy for reasoning models.
