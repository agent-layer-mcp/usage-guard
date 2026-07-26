# Changelog

## 0.2.4 - 2026-07-26

- Stop fabricating Claude Desktop reset times from old aggregate usage drops;
  reset remains unknown unless the provider supplies it.
- Evaluate observed quota burn across multiple recent horizons so a rapid
  0-to-46% rise enters `WATCH` and `PROTECT` before cumulative thresholds lag.
- Add an exact regression replay for the reported 22-hour field session.
- Inject one stable quality contract at session start and transition-only
  `WATCH`/`PROTECT` guidance; live percentages and resets remain behind the MCP
  status tool.
- Remove the catch-all Claude `PreToolUse` hook that spawned Node for every
  tool call.
- Optionally surface fresh local pxpipe context size, resident images, cache
  activity, and API-equivalent weighted request cost. Detect explicit
  five-minute (`1.25x`) and one-hour (`2x`) cache-write TTLs; show a range when
  TTL is unknown.
- Replace unreliable legacy macOS alert delivery with a native, auditable Usage
  Guard notification helper installed in the user-only state directory.
- Document why model/effort downgrades can invalidate prompt caches, while
  keeping provider-private subscription weighting clearly labeled as unknown.

## 0.2.3 - 2026-07-26

- Prefer `terminal-notifier` for macOS alerts when it is installed, with
  AppleScript retained as a dependency-free fallback.
- Detect both Apple Silicon and Intel Homebrew notifier paths without relying on
  the restricted `PATH` inherited by desktop LaunchAgents.

## 0.2.2 - 2026-07-26

- Show one in-chat Claude notice when an active tool-using run transitions into
  `WATCH` or `PROTECT`.
- Deduplicate notices per Claude session so repeated tool calls do not flood the
  conversation while separate sessions still receive their own first cue.

## 0.2.1 - 2026-07-26

- Detect rapid quota burn even when Claude Desktop does not expose a reset
  timestamp, warning when the protected reserve is projected within 90 minutes
  and protecting when it is projected within 30 minutes.
- Recheck Claude quota at tool boundaries so a long agentic run can be stopped
  after it reaches the protected reserve instead of waiting for the next prompt.
- Install a local macOS background monitor that checks Claude's aggregate usage
  once per minute and sends visible notifications on `WATCH`, `PROTECT`, and
  `QUEUE` escalation.
- Persist only notification state needed to suppress duplicate alerts.
- Add a regression replay for a real five-hour window that rose from 13% to 53%
  in ten minutes and reached 100% during one desktop task.

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
