# Security policy

## Supported versions

Security fixes are made against the latest released minor version.

## Report a vulnerability

Please do not open a public issue for a vulnerability that could expose local data or weaken provider settings. Use GitHub's private vulnerability reporting for this repository.

Include:

- affected Usage Guard version
- operating system and Node.js version
- Claude Code or Codex version involved
- minimal reproduction without credentials or private source code
- expected and observed behavior

## Security boundaries

Usage Guard deliberately avoids browser-cookie scraping, direct auth-file
parsing, account rotation, private provider endpoints, and transcript mining.
It reads Claude's documented status-line payload and Codex's documented local
app-server response.

Claude Desktop's local Code surface does not currently run the configured
status-line command. On macOS, Usage Guard may also read the user-only
`plan-usage-history.json` aggregate cache maintained by Claude Desktop. This is
an undocumented local implementation detail. The parser allowlists only `fh`,
`sd`, and sample timestamps; validates percentage ranges; does not persist
organization identifiers; ignores unknown fields; and fails open if the cache
is missing, stale, malformed, or changes shape.

Provider hooks run local commands and therefore require explicit trust in
Claude Code and Codex. Review
[`plugins/usage-guard/hooks`](plugins/usage-guard/hooks) before approving them.
The installer records the absolute Node and Usage Guard CLI paths. Plugin hooks
and MCP servers enter through `/bin/sh`, read a user-only runtime pointer, and
then execute the recorded Node binary. This avoids relying on a Terminal
`PATH`, which desktop GUI processes may not inherit. The JavaScript routers
then read the full install record for the Usage Guard CLI and provider paths.

Claude `PreToolUse` uses the documented permission-decision schema and a
universal stop result at the protected reserve. `PostToolBatch` independently
stops the loop before the next model request. Missing or stale quota data still
fails open.

The `PostCompact` hook stores only Claude's supplied compact summary, never the
raw JSONL transcript. Handoffs live below the user-only Usage Guard state
directory, are keyed by a hash of the repository identity, are written
atomically with mode `0600`, and are injected only into a different recent
session for the same repository.

On macOS, the installer also creates the user LaunchAgent
`sh.agentlayer.usage-guard.monitor`. It runs the recorded local Node and Usage
Guard CLI once per minute, reads only the same allowlisted aggregate Claude
cache, writes to the user-only Usage Guard state directory, and may display a
local notification. It does not run as root and is removed by
`usage-guard uninstall`.

On macOS, the installer creates a second user LaunchAgent,
`sh.agentlayer.usage-guard.screenshot-memory`. It binds only to
`127.0.0.1:47822`, rejects a self-referencing upstream, enforces a bounded
request body, and forwards to the Claude upstream that existed before
installation. The prior `ANTHROPIC_BASE_URL` is recorded for exact rollback.
The gateway runs as the current user and never as root.

`ANTHROPIC_BASE_URL` in Claude settings configures Claude CLI sessions but is
not evidence that Claude Desktop uses the gateway. Desktop routing must use
Claude's supported Third-Party Inference configuration. `doctor` keeps that
surface unverified rather than reporting a false pass.

Screenshot Memory must inspect outbound Claude JSON in memory to replace
expired image blocks. It does not log or persist request bodies, prompt text,
assistant text, image bytes, credentials, or authorization headers. Its
persistent status is numeric and is written atomically with user-only
permissions. The saved host conversation is not changed. Requests that do not
match supported Anthropic message endpoints pass through without
transformation.

The installer compiles a small, auditable Swift notification helper from the
source bundled in `native/`, ad-hoc signs it, and stores it below the user-only
Usage Guard state directory. It requests normal macOS notification permission
and runs without root privileges. If that helper is unavailable, Usage Guard
may invoke `terminal-notifier` only from the standard Apple Silicon or Intel
Homebrew path, then falls back to AppleScript.

Optional pxpipe diagnostics parse only recent successful message-event rows
from its local ledger and return an allowlist of numeric fields. Usage Guard
does not parse Claude transcript JSONL. Any future transcript-derived meter
must group streaming duplicates by message/request ID and retain maximum usage
values before aggregation; summing raw lines is prohibited.

The dashboard and Screenshot Memory gateway bind to `127.0.0.1`. The dashboard
sends a restrictive content security policy and exposes no credential-bearing
endpoint. Do not proxy either local service to a public interface.
