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

Usage Guard deliberately avoids browser-cookie scraping, direct auth-file parsing, account rotation, and private provider endpoints. It reads Claude's documented status-line payload and Codex's documented local app-server response.

Provider hooks run local commands and therefore require explicit trust in
Claude Code and Codex. Review
[`plugins/usage-guard/hooks`](plugins/usage-guard/hooks) before approving them.
The installer records the absolute Node and Usage Guard CLI paths. Hook and MCP
routers read that local record so desktop GUI processes do not depend on a
Terminal `PATH`; older installs fall back to the `usage-guard` executable name.

The dashboard binds to `127.0.0.1`, sends a restrictive content security policy, and exposes no credential-bearing endpoint. Do not proxy it to a public interface.
