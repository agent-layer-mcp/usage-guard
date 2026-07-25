# Changelog

## 0.2.0 - 2026-07-25

- Preserve Claude context observations even when quota windows are absent.
- Isolate context pressure by desktop session and surface it in CLI, status
  line, dashboard, hooks, and MCP output.
- Add quality-preserving context watch and protect thresholds.
- Forecast from the nearest meaningful recent burn sample.
- Emit compatible prompt-block responses at the protected reserve.
- Record absolute runtime paths for reliable Claude and Codex desktop hooks and
  MCP startup.
- Bootstrap plugin hooks and MCP through `/bin/sh` so Node can start even when
  desktop applications omit Homebrew from `PATH`.
- Ingest allowlisted five-hour and weekly aggregate percentages from Claude
  Desktop's local macOS plan history before prompt policy evaluation.
- Fail open on missing, stale, malformed, or changed Claude Desktop cache data,
  and never retain organization identifiers or unknown fields.
- Expand `doctor` to verify runtime, status lines, enabled plugins, quota
  meters, and Claude context.
- Clarify optional provider windows and the limits of reserve enforcement.

## 0.1.0 - 2026-07-14

- Add Claude Code five-hour and weekly status-line ingestion.
- Add Codex multi-bucket rate-limit reads through the local app-server.
- Add reserve-aware pacing, visible lifecycle notices, and protected prompt pauses.
- Add local SQLite history, dashboard, MCP tools, installer, and rollback.
- Add installable Claude Code and Codex marketplace plugins.
