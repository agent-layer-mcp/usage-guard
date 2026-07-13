# Usage Guard

Local-first quota pacing for Claude Code and Codex that never silently lowers model quality.

Usage Guard reads the providers' documented five-hour, weekly, and additional quota windows, learns the local burn rate, and makes a visible choice before a session runs into its protected reserve.

> Stay in flow. Never hit a limit by surprise. Never silently trade away quality.

## What it does

- Shows every quota bucket the provider exposes, including reset time and current pace.
- Protects separate reserves for short and weekly windows.
- Reduces avoidable context and speculative concurrency before changing task timing.
- Keeps the active model and reasoning effort locked by default.
- Blocks new quota-heavy turns at the reserve and explains when work can resume.
- Adds a Claude Code status line and Codex's built-in five-hour/weekly status segments.
- Shows the same deliberate-choice notice in CLI and desktop plugin sessions.
- Provides a local dashboard and MCP tools for agents.

Usage Guard cannot create unlimited included quota. If demand exceeds the provider allowance, uninterrupted operation requires waiting for reset or a separately enabled paid overflow path. The current release implements protected waiting, not paid overflow.

## Install

Node.js 22 or newer is required. Until the npm package is published, install directly from the public repository:

```bash
npm install --global https://github.com/agent-layer-mcp/usage-guard/archive/refs/heads/main.tar.gz
usage-guard install
```

The installer:

1. Adds the Agent Layer marketplace and Usage Guard plugin to Claude Code and Codex.
2. Configures Claude's custom status line.
3. Adds Codex's built-in model, context, five-hour, and weekly status segments.
4. Backs up affected settings and records the exact values needed for rollback.

Claude and Codex require users to review and trust newly installed lifecycle hooks. Review the bundled hooks in [`plugins/usage-guard/hooks`](plugins/usage-guard/hooks) and approve them in the provider UI.

## Use

```bash
# Live terminal view. Codex is refreshed automatically.
usage-guard status

# Local dashboard.
usage-guard serve

# Verify providers, meters, and the privacy boundary.
usage-guard doctor

# Inspect or change policy.
usage-guard config
usage-guard config enforcement protect weeklyReservePercent 7
```

The dashboard runs on `http://127.0.0.1:4765` and binds only to localhost.

## Policy states

| State | Behavior |
| --- | --- |
| `safe` | Work normally; avoid duplicate context. |
| `watch` | Reuse evidence, compact at safe boundaries, and bound parallel work. |
| `protect` | Use one active path, preserve strong planning/review, and stop speculative branches. |
| `queue` | Pause new quota-heavy work until reset. Deterministic local checks may continue. |
| `missing` / `stale` | Refresh the meter; never block from uncertain data. |

Default reserves are 8% for windows up to six hours and 5% for longer windows. Change them locally with `usage-guard config`.

## Provider signals

### Claude Code

Claude sends its documented `rate_limits.five_hour` and `rate_limits.seven_day` data to the Usage Guard status-line command. The payload also carries model, effort, and context data. Usage Guard stores only normalized quota observations.

### Codex

Usage Guard starts the local `codex app-server`, completes the documented initialization handshake, calls `account/rateLimits/read`, stores every returned limit bucket, and exits the child process. It does not read `auth.json` or provider tokens.

Codex currently supports built-in quota status-line segments rather than a Claude-style arbitrary renderer. The plugin uses those native segments, while lifecycle notices and the local dashboard show richer decisions.

## Quality contract

1. No silent model or reasoning downgrade.
2. Architecture, difficult debugging, security, migrations, and final review retain strong reasoning.
3. Timing changes before quality changes.
4. Tests, static checks, and diff review remain protected.
5. Stale or missing data never causes a hard block.
6. Every intervention names the action, reason, and controlling reset.

## Privacy

Usage Guard is local-only by default. It does not read or store:

- prompts or transcript bodies
- source code or diffs
- cookies, OAuth tokens, or provider auth files
- API keys
- browsing activity

It stores normalized quota observations, model/effort labels supplied by lifecycle payloads, aggregate context percentage, policy decisions, and local configuration in `~/.usage-guard/usage-guard.sqlite3`.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Remove

```bash
usage-guard uninstall
npm uninstall --global @agent-layer/usage-guard
```

The uninstall command removes both plugin integrations and restores the prior status-line settings without replacing unrelated current settings.

## Development

```bash
npm install
npm run check
npm test
USAGE_GUARD_HOME="$(mktemp -d)" node bin/usage-guard.mjs demo
```

For local marketplace testing:

```bash
codex plugin marketplace add "$PWD"
codex plugin add usage-guard@agent-layer
claude plugin marketplace add "$PWD"
claude plugin install usage-guard@agent-layer --scope user
```

## Status

This is an early public release. Claude and Codex can change quota shapes and plugin surfaces. The adapters intentionally treat windows as optional and arbitrary; please report provider/account combinations that behave differently.

Built by [Agent Layer](https://agentlayer.sh). Licensed under MIT.
