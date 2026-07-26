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

On macOS, the installer also creates the user LaunchAgent
`sh.agentlayer.usage-guard.monitor`. It runs the recorded local Node and Usage
Guard CLI once per minute, reads only the same allowlisted aggregate Claude
cache, writes to the user-only Usage Guard state directory, and may display a
local notification. It does not run as root and is removed by
`usage-guard uninstall`.

If Homebrew's `terminal-notifier` is already installed, Usage Guard invokes its
absolute path for more reliable macOS delivery. It does not install the helper
or execute a binary discovered from an untrusted desktop `PATH`; only the
standard Apple Silicon and Intel Homebrew paths are considered.

The dashboard binds to `127.0.0.1`, sends a restrictive content security policy, and exposes no credential-bearing endpoint. Do not proxy it to a public interface.
