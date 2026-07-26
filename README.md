# Usage Guard

Local-first quota pacing for Claude Code and Codex that never silently lowers model quality.

Usage Guard reads every short, weekly, and additional quota window the provider
actually exposes, learns the observed quota burn rate, and makes a visible
choice before a session runs into its protected reserve. It never invents a
reset time when the provider has not supplied one.

> Stay in flow. Never hit a limit by surprise. Never silently trade away quality.

## What it does

- Shows every quota bucket the provider exposes, including authoritative reset
  time when available and current observed pace.
- Protects separate reserves for short and weekly windows.
- Tracks Claude context pressure per session when Claude supplies it.
- Optionally surfaces current Claude request context, resident images, cache
  writes/reads, and directional weighted cost from a local pxpipe ledger.
- Keeps screenshots visually available for five later user turns, then replaces
  their repeated image payload with compact text memory on future Claude
  requests.
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
npm install --global https://github.com/agent-layer-mcp/usage-guard/releases/latest/download/usage-guard.tgz
usage-guard install
```

The installer:

1. Adds the Agent Layer marketplace and Usage Guard plugin to Claude Code and Codex.
2. Configures Claude's custom status line.
3. Adds Codex's built-in model, context, five-hour, and weekly status segments.
4. Backs up affected settings and records the exact values needed for rollback.
5. Records absolute Node and CLI paths and installs a `/bin/sh` bootstrap so
   plugin hooks and MCP startup do not depend on a Terminal `PATH`.
6. On macOS, builds a small native Usage Guard notification helper and installs
   a local one-minute background monitor. It alerts when Claude usage escalates
   to `WATCH`, `PROTECT`, or `QUEUE`, with legacy notification paths retained
   only as fallbacks.
7. On macOS, installs Screenshot Memory as a localhost-only Claude request
   gateway. It preserves any existing `ANTHROPIC_BASE_URL` as its upstream, so a
   local proxy such as pxpipe remains in the request path.

Claude and Codex require users to review and trust newly installed lifecycle hooks. Review the bundled hooks in [`plugins/usage-guard/hooks`](plugins/usage-guard/hooks) and approve them in the provider UI.

## Use

```bash
# Live terminal view. Supported local provider meters are refreshed automatically.
usage-guard status

# Refresh one provider or both explicitly.
usage-guard sync claude
usage-guard sync codex
usage-guard sync all

# Local dashboard.
usage-guard serve

# Verify providers, meters, and the privacy boundary.
usage-guard doctor

# Inspect or change policy.
usage-guard config
usage-guard config enforcement protect weeklyReservePercent 7
usage-guard config contextWatchPercent 70 contextProtectPercent 85
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

Claude context guidance defaults to `watch` at 70% and `protect` at 85%.
Context pressure never changes the selected model and never causes a hard block
by itself. At the protect threshold, Usage Guard asks the agent to finish its
current coherent step, update a durable handoff, and compact or start a fresh
task before another large phase.

## Provider signals

### Claude Code

Claude can send `rate_limits.five_hour` and `rate_limits.seven_day` data to the
Usage Guard status-line command. Eligible fields appear after a response and
individual windows may be absent. The payload also carries model, effort,
session, and context data. Usage Guard stores normalized quota observations and
local per-session aggregate context percentages, not transcript contents.

Claude Desktop's local Code surface runs Usage Guard's hooks and MCP server but
does not currently invoke the configured custom status-line command. On macOS,
Usage Guard therefore reads Claude Desktop's user-only aggregate plan history
before each prompt. It accepts only the observed `fh` and `sd` percentages and
their timestamps, ignores unknown fields, and never stores the cache's
organization identifier. This is an undocumented desktop cache, so malformed or
changed schemas fail open as a missing signal.

The Desktop cache does not include reset timestamps. Claude Code `v2.1.80` and
later provides authoritative `rate_limits.five_hour.resets_at` and
`rate_limits.seven_day.resets_at` values to its supported status-line JSON.
Usage Guard records those values and can retain a still-future reset while the
Desktop cache refreshes the corresponding percentage. It discards that reset
after expiry or an observed usage rollover. Before Claude Code supplies an
authoritative sample, Usage Guard reports the reset as unknown; it never treats
an earlier aggregate drop as the anchor for a later window.

Usage Guard still projects minutes until the configured reserve from multiple
recent aggregate-burn horizons: `WATCH` within 90 minutes and `PROTECT` within
30 minutes by default.

### Screenshot Memory

Vision payloads are unusually expensive when the same screenshot remains in a
long conversation. Screenshot Memory keeps each screenshot intact for the next
five user turns. On later outbound Claude requests, it replaces the base64 image
block with bounded text containing:

- the text from the user's original screenshot turn
- the first assistant response immediately following that turn
- the image type, approximate original size, and a short content hash
- a clear warning that the replacement is contextual memory, not a pixel-exact
  transcription

This transformation happens only in the request sent to Claude. It does not
edit the saved conversation or delete the original attachment. Reattach an
image whenever its pixels are needed again. Add `[usage-guard:pin-images]` or
`#keep-screenshot` to the screenshot turn to keep its image payload live.

The gateway binds to `127.0.0.1:47822`. It does not call another model to create
the memory, and it stores only numeric replacement counts and byte totals. On
install it chains to the user's prior Claude upstream and restores that exact
setting on uninstall.

Screenshot Memory currently applies to local Claude requests. Codex does not
offer an equivalent supported local request-routing surface, so Usage Guard
does not claim to remove images from Codex context.

### Optional Claude request diagnostics

Screenshot Memory is a narrow local request gateway, not a hosted API service.
When the separately installed local pxpipe proxy has a fresh
`~/.pxpipe/events.jsonl` ledger, the `status` command, MCP status tool, and
escalation notification can surface request metadata that explains cost:

- baseline context tokens
- resident image count
- cache creation and cache-read tokens
- output tokens
- directional API-equivalent request weight

Cache writes are weighted at `1.25x` for an explicitly reported five-minute
TTL and `2x` for an explicitly reported one-hour TTL. If pxpipe does not identify
the TTL, Usage Guard shows the possible range instead of choosing the cheaper
multiplier. These ratios are useful diagnostics, not a claim about Anthropic's
private Max-plan quota formula. Provider-reported usage percentage and its
observed derivative remain the decision authority.

### Codex

Usage Guard starts the local `codex app-server`, completes the documented initialization handshake, calls `account/rateLimits/read`, stores every returned limit bucket, and exits the child process. It does not read `auth.json` or provider tokens.

Codex currently supports built-in quota status-line segments rather than a Claude-style arbitrary renderer. The plugin uses those native segments, while lifecycle notices and the local dashboard show richer decisions.

Codex's stable hook payload does not currently expose an exact context
percentage to Usage Guard. Codex displays its own native context meter and
automatically compacts. Usage Guard does not read the unstable transcript to
manufacture an estimate.

### Desktop support

- Codex Desktop Work/Codex sessions: local plugin, hooks, MCP, and native status
  segments.
- Codex CLI: plugin, hooks, MCP, and native status segments.
- Claude Desktop Code tab, local sessions: plugin, session/prompt hooks, MCP,
  aggregate five-hour/weekly cache ingestion, and background macOS
  notifications, plus five-turn Screenshot Memory after starting a new session
  with the installed local gateway. Sessions receive one stable quality
  contract at start, one in-chat cue when their state changes into `WATCH` or
  `PROTECT`, and a compact post-response usage footer rendered by Claude's
  `Stop` hook. The footer is a host `systemMessage`; the model does not generate
  it and it is not injected as additional context.
- Claude Code CLI: plugin, hooks, MCP, and custom status line.
- Claude Desktop SSH and remote sessions: do not assume that the local desktop
  aggregate cache describes the remote account or that provider hooks are
  supported.

Run `usage-guard doctor` after installation. It verifies both CLIs, the
PATH-independent plugin bootstrap, absolute desktop runtime paths, status-line
configuration, plugin enabled state, Claude Desktop aggregate-cache ingestion,
meter freshness, and whether Claude has supplied a context observation.

Claude Desktop displays exact context usage in its native UI, but its observed
stable plugin hook payload and aggregate cache do not expose that percentage.
Usage Guard does not read transcripts to manufacture it. Desktop users retain
Claude's native context meter and automatic compaction; exact Usage Guard
context guidance remains available where Claude's status-line payload supplies
the value.

## Quality contract

1. No silent model or reasoning downgrade.
2. Architecture, difficult debugging, security, migrations, and final review retain strong reasoning.
3. Timing changes before quality changes.
4. Tests, static checks, and diff review remain protected.
5. Stale or missing data never causes a hard block.
6. Every intervention names the action and reason, and names the controlling
   reset only when the provider supplied it.

### Why Usage Guard does not downgrade the model

The quality lock is also a cache-economics decision. Field analysis of the
current Claude Code implementation found `model` and reasoning effort among
the prompt-cache key inputs. Changing either mid-session can invalidate a large
cached prefix and cause an expensive cache rewrite before any lower-cost turns
can repay it. Tool-schema changes can have a similar effect.

That implementation detail is not a public compatibility guarantee and may
change, but the product rule does not depend on it: Usage Guard first removes
waste, bounds concurrency, recommends a safe compaction boundary, or delays
work. It never silently weakens the selected model or reasoning effort.

Usage Guard materially reduces surprise exhaustion when provider observations
are fresh. It cannot guarantee that an account never reaches a provider limit:
another device or application can consume the same quota, providers can omit a
window, and no plugin can interrupt a model generation already in flight.
Usage Guard deliberately avoids a catch-all `PreToolUse` subprocess on every
tool call; the background monitor provides mid-run escalation alerts without
hundreds of Node process launches. Missing or stale signals are shown explicitly
and never produce a hard block.

## Privacy

Usage Guard is local-only by default. It does not store:

- prompts or transcript bodies
- screenshots or other image payloads
- source code or diffs
- cookies, OAuth tokens, or provider auth files
- API keys
- browsing activity

It stores normalized quota observations, model/effort labels supplied by
lifecycle payloads, local session identifiers, aggregate context percentage,
policy decisions, and local configuration in
`~/.usage-guard/usage-guard.sqlite3`.

On macOS its hook and one-minute background monitor may read Claude Desktop's
local aggregate plan history at
`~/Library/Application Support/Claude/plan-usage-history.json`. Usage Guard
stores only normalized percentages and timestamps from supported fields. It
does not store organization identifiers or unknown cache fields.

If pxpipe is installed separately, status surfaces may read its local request
ledger for the allowlisted numeric diagnostics listed above. Usage Guard does
not read Claude transcripts, does not return request bodies, and does not store
pxpipe rows. If transcript support is ever added, duplicated streaming records
must be grouped by request/message ID and the maximum usage values retained;
naive line summation is explicitly prohibited.

Screenshot Memory transiently parses outbound Claude JSON requests in local
memory to identify image blocks and their surrounding text. It forwards the
request to the configured upstream and does not write prompt text, assistant
text, image data, authorization headers, or transformed request bodies to disk.
Its status file contains only counts, byte totals, timestamps, retention
configuration, and the upstream URL.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Remove

```bash
usage-guard uninstall
npm uninstall --global @agent-layer/usage-guard
```

The uninstall command removes both plugin integrations and restores the prior status-line settings without replacing unrelated current settings.
On macOS it also unloads the Usage Guard background monitor and removes the
native notification helper and Screenshot Memory gateway. Claude's prior
`ANTHROPIC_BASE_URL` is restored.

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

This is an early public release. Claude and Codex can change quota shapes and
plugin surfaces. The adapters intentionally treat windows as optional and
arbitrary. Claude Desktop's aggregate cache is not a documented API and may
change. A missing five-hour meter means the provider did not expose a supported
reading in that snapshot, not that Usage Guard silently inferred it.

Built by [Agent Layer](https://agentlayer.sh). Licensed under MIT.
