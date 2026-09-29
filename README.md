# Usage Guard

Local quota protection and model stepping for Claude Code and Codex.

Usage Guard reads every short, weekly, and additional quota window the provider
actually exposes, learns the observed quota burn rate, and makes a visible
choice before a session runs into its protected reserve. It never invents a
reset time when the provider has not supplied one.

Model stepping is on by default. Usage Guard recommends cheaper models for new
work as quota tightens, preserves strong planning and review, and stops at your
reserve. Every recommendation has a visible reason.

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
- Guides agents to reduce duplicate context and speculative concurrency.
- Recommends separate model/effort settings for the main thread and routine
  subagents, with recovery hysteresis and optional quiet hours.
- Offers an optional quality lock to retain the previous model-preserving behavior.
- Blocks new prompts and tool calls at the reserve and explains when work can
  resume. With model stepping active, it also saves a quota-only handover.
- Rechecks quota before Claude tool calls and after tool batches so an active
  desktop run can stop before another expensive model request.
- Uses Claude's native compaction at 40% by default and saves the provider's
  compact summary as a private project-keyed handoff for a fresh local session.
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

The current release is **0.5.0**. Claude Code **2.1.284 or newer** is required
for the default Opus/Sonnet 5.5 ladder. `usage-guard doctor` checks the CLI
version; an older CLI must be updated before applying those recommendations.
Claude Desktop has its own runtime and available tools.

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
   gateway. It preserves any existing `ANTHROPIC_BASE_URL` as its upstream and
   configures the Claude CLI route. Claude Desktop ignores that settings-file
   route and must be configured separately through its supported Third-Party
   Inference screen.
8. Configures Claude's supported proactive compaction variables to compact at
   40% of the active model window. The installer preserves and restores the
   user's previous values exactly.

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
usage-guard config compactionHandoffEnabled false
usage-guard config qualityLock true
usage-guard config qualityLock false modelStepping true

# Choose a different native auto-compaction percentage during installation.
usage-guard install --auto-compact-percent 50
```

The dashboard runs on `http://127.0.0.1:4765` and binds only to localhost.

## Model stepping

The default ladders use these exact IDs, verified against the providers'
[Claude model documentation](https://code.claude.com/docs/en/model-config) and
[Codex model documentation](https://learn.chatgpt.com/docs/models):

| Rung | Claude model / effort | Codex model / effort |
| --- | --- | --- |
| 1 | `claude-opus-5-5` / high | `gpt-6-astra` / high |
| 2 | `claude-sonnet-5-5` / high | `gpt-6-sol` / high |
| 3 | `claude-sonnet-5-5` / medium | `gpt-6-sol` / medium |
| 4, routine only | `claude-haiku-4-5-20251001` / default | `gpt-6-luna` / high |

Haiku's `default` is a Usage Guard label: omit the host's effort parameter and
clear inherited overrides. Haiku 4.5 does not support that parameter. The
stepped-down rungs reject `max` and `xhigh`. Fable and GPT-5.5 are not in the
default ladders. Haiku 5.5 is not preconfigured before release; a verified new
model can be added later through `modelLadders`.

Usable quota is **remaining quota minus the protected reserve**, in percentage
points of the whole allowance. Five-hour usable quota below 40%, 25%, and 12%
selects rungs 2, 3, and 4. Weekly usable quota below 30% selects rung 2; below
10% selects rung 4. The worse window wins. Rapid burn adds one rung, and quiet
hours can add another; the ladder stops at rung 4. A sustained-pace warning
(`paceRatio >= 0.95`) or a predicted reserve within `rapidBurnWatchMinutes`
counts as rapid burn. Context pressure alone does not step models down.

Each quota window retains its rung until usable quota reaches the triggering
threshold plus the 10-point recovery margin. A fresh, provider-confirmed reset
releases that window's latch without releasing another pressured window.
Rapid-burn and quiet-hours adjustments end when those conditions end. Missing,
stale, or expired meters withhold recommendations until refreshed; a fresh
window at its reserve still stops work even if another meter is stale.

Planning, architecture, finished-work reviews, and work involving money,
security, children's data, or production use the best rung allowed by quota,
never below rung 2. Routine searches, test runs, reading, mechanical edits, and
summaries go one rung cheaper first. General implementation can use rung 3;
the floor is routine-only. Without a task description, status assumes the main
thread is planning. Sensitive task classification overrides a supplied routine
role, using the task description in memory only.

`usage_guard_status` and `usage_guard_decision` return `recommendedModel`,
`recommendedEffort`, `routineModel`, `routineEffort`, and a one-line
`modelReason`. Pass a `role` or transient `task` to obtain the right
recommendation before starting a different kind of work. The `instructions`
tell the agent to finish the current edit and verification, then switch between
tasks. In Claude Desktop, agents can use the exposed
`mcp__ccd_session_mgmt__set_session_model` and
`mcp__ccd_session_mgmt__set_session_effort` tools with their declared schemas.
Other hosts use an available session control or a new subagent with explicit
model and effort. A host without either capability must report the limitation.
Usage Guard emits guidance; it does not impersonate a host control or claim an
unconfirmed switch. Subagents share the same quota and cannot bypass a reserve
pause. Enabled stepping does not ask for confirmation on each change.

Changes are recorded in `recentDecisions` with timestamps, quota figures,
chosen rungs, and both model/effort pairs. These are **recommendation changes**,
marked `applied: false`, not proof a host changed its session. The audit tracks
the protected-main and routine roles consistently so querying a different role
does not invent overnight changes. A separate history retains steps even after
many status polls. `overnightSummary` summarizes the last 12 hours by default.

Every setting is configurable through `usage_guard_configure`, including
custom ladders, thresholds, reserves, hysteresis, role limits, rapid-burn
settings, quiet hours, and summary duration. See the [complete default config
and example status](docs/model-stepping.md). `quietHours: null` disables quiet
hours; `{ "start": "22:00", "end": "07:00" }` uses the machine's local time.
An optional IANA `timeZone` supports a fixed zone, and `extraRungs` defaults to 1.

Setting `qualityLock: true` takes precedence over stepping and restores the
legacy provider decisions and hook behavior. Setting both switches to false
leaves model choice alone. Upgrading from the old fixed-lock release turns on
the new default once; explicitly re-enabling the lock thereafter persists.

## Policy states

| State | Behavior |
| --- | --- |
| `safe` | Work normally; avoid duplicate context. |
| `watch` | Reuse evidence, compact at safe boundaries, and bound parallel work. |
| `protect` | Use one active path, preserve strong planning/review, and stop speculative branches. |
| `queue` | Pause new prompts and tool calls at the reserve; save a quota-only handover when model stepping is active. |
| `missing` / `stale` | Refresh the meter; never block from uncertain data. |

Default reserves are 8% for windows up to six hours and 5% for longer windows. Change them locally with `usage-guard config`.

Claude context guidance defaults to `watch` at 70% and `protect` at 85%.
Context pressure never changes the selected model and never causes a hard block
by itself. At the protect threshold, Usage Guard asks the agent to finish its
current coherent step, update a durable handoff, and compact or start a fresh
task before another large phase.

### Early compaction and continuity

Usage Guard configures Claude's documented
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` variables. The default is 40%. Claude still
performs the compaction itself with the active session's summarization
machinery. Usage Guard does not create a replacement summary; resumed work
follows the current model and effort policy.

After compaction, the supported `PostCompact` hook receives Claude's compact
summary. By default, Usage Guard stores that summary below
`~/.usage-guard/handoffs/<project-key>/context-handoff.md` with user-only
permissions. A different fresh local session for the same Git repository
receives the recent handoff through its supported `SessionStart` context. The
summary is not redacted or filtered and may contain prompt and response text,
source code, diffs, pasted secrets, or other sensitive content. Usage Guard does
not read or copy the raw transcript to create it. Disable future saving and
injection with:

```bash
usage-guard config compactionHandoffEnabled false
```

This does not delete an existing handoff file; `usage-guard reset` removes saved
handoffs along with quota history and other local state.

Claude Desktop does not expose an official way for a plugin to silently create
and submit a new Code session. Its deep link can only prefill a composer and
always confirms a supplied folder. Native compaction in the same session is
therefore the fully automatic continuity path.

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
the memory, and it stores replacement counts, byte totals, timestamps, retention
settings, and the configured upstream URL. On
install it chains to the user's prior Claude upstream and restores that exact
setting on uninstall.

Screenshot Memory applies to local Claude CLI requests after installation.
Claude Desktop explicitly does not use `ANTHROPIC_BASE_URL` or `settings.json`
for gateway routing. Its supported Third-Party Inference configuration uses a
separate gateway credential path rather than silently proxying the user's
normal claude.ai subscriber session. Usage Guard therefore does not enable or
claim Screenshot Memory for a normal Desktop subscription session. Users who
already operate a credentialed Desktop gateway can deliberately point that
configuration at `http://127.0.0.1:47822` and verify it separately. See
Anthropic's
[gateway documentation](https://code.claude.com/docs/en/llm-gateway-connect).

Codex does not offer an equivalent supported local request-routing surface, so
Usage Guard does not claim to remove images from Codex context.

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

The meter separately reads `config/read` for the configured model and effort
when the hook did not supply a session-specific choice. A configured default is
not proof of a session override. Quota bucket labels are never treated as model
selection: a Spark-named bucket retains that name if the provider still returns
it, while buckets absent from a fresh authoritative response leave the current
view. Their history is retained for inspection.

Codex currently supports built-in quota status-line segments rather than a Claude-style arbitrary renderer. The plugin uses those native segments, while lifecycle notices and the local dashboard show richer decisions.

Codex's stable hook payload does not currently expose an exact context
percentage to Usage Guard. Codex displays its own native context meter and
automatically compacts. Usage Guard does not read the unstable transcript to
manufacture an estimate.

### Desktop support

- Codex Desktop Work/Codex sessions: local plugin, hooks, MCP, and native status
  segments.
- Codex CLI: plugin, hooks, MCP, and native status segments.
- Claude Desktop Code tab, local sessions: plugin, session/prompt/tool hooks, MCP,
  aggregate five-hour/weekly cache ingestion, and background macOS
  notifications. Sessions receive the configured model policy at start.
  With quality lock enabled, entering `PROTECT` retains the legacy tool approval.
  With stepping enabled, recommendations are delivered for the next task
  boundary without asking again for downgrade permission;
  reaching `QUEUE` denies the tool and stops the run. `PostToolBatch` provides a
  second stop before another model request. The compact `Stop` footer remains a
  best-effort host message and is not treated as the enforcement surface.
  Screenshot Memory requires the separate Desktop Third-Party Inference setup
  described above.
- Claude Code CLI: plugin, hooks, MCP, and custom status line.
- Claude Desktop SSH and remote sessions: do not assume that the local desktop
  aggregate cache describes the remote account or that provider hooks are
  supported.

Run `usage-guard doctor` after installation. It verifies both CLIs, the
PATH-independent plugin bootstrap, absolute desktop runtime paths, status-line
configuration, native early compaction, plugin enabled state, Claude Desktop
aggregate-cache ingestion, meter freshness, and whether Claude has supplied a
context observation. It deliberately reports Claude Desktop gateway routing as
unverified instead of treating the Claude CLI environment as proof.

Claude Desktop displays exact context usage in its native UI, but its observed
stable plugin hook payload and aggregate cache do not expose that percentage.
Usage Guard does not read transcripts to manufacture it. Desktop users retain
Claude's native context meter and automatic compaction; exact Usage Guard
context guidance remains available where Claude's status-line payload supplies
the value.

## Quality contract

1. Model stepping is visible, authorized by the enabled setting, and applied only between tasks.
2. Planning, architecture, sensitive work, and final review never go below rung 2.
3. Routine work steps down first; tests and verification remain required.
4. Quality lock restores the previous model-preserving behavior.
5. Stale or missing observations never justify a stop; fresh reserve evidence does.
6. Every intervention names its reason and uses a reset time only when supplied.

Switching models can change cache economics, so the governor uses hysteresis
and task boundaries to avoid repeated switches. API token prices are not a
guarantee of subscription quota savings; those provider weights are private.

Usage Guard materially reduces surprise exhaustion when provider observations
are fresh. It cannot guarantee that an account never reaches a provider limit:
another device or application can consume the same quota, providers can omit a
window, and no plugin can interrupt a model generation already in flight.
Usage Guard runs a `PreToolUse` check before tool calls and a `PostToolBatch`
check before another model request. The background monitor also provides
escalation alerts. A reserve stop blocks new prompts and tool calls, including
deterministic tools inside the stopped run; independent local checks outside
that run are unaffected.

## Privacy

Usage Guard is local-only by default. Its quota governance and model-step
records do not store prompt text, source code, diffs, or transcript bodies.
The separate provider-supplied compact-summary handoff is enabled by default
and is saved locally without redaction or filtering; it may contain exact
prompt or response text, code, diffs, pasted credentials, and other sensitive
content. Usage Guard does not read or copy the raw transcript to produce that
handoff. Screenshot Memory inspects image payloads in memory but does not save
them; it forwards authorization headers without persisting them. Quota
governance does not directly read browser sessions or provider auth files.

It stores normalized quota observations, model/effort labels supplied by
lifecycle payloads, local session identifiers, aggregate context percentage,
policy decisions, model-step history, and local configuration in
`~/.usage-guard/usage-guard.sqlite3`.

Reserve handovers contain only quota/model metadata, never the task text,
prompts, source code, or tool arguments. With model stepping active
(`modelStepping: true` and `qualityLock: false`), the hook saves one locally
before stopping. This does not happen under the legacy quality lock. The
compact-summary handoff is separate and enabled by default.

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
