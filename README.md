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

- Splits each weekly window into daily shares (day starts at 08:00 by default)
  and routes the next job to the lane with the most share left: Claude, Codex,
  or a capped pay-as-you-go Hermes (OpenRouter) lane.
- Has a master on/off switch and a tray app for Linux, Windows and macOS.

Usage Guard cannot create unlimited included quota. If demand exceeds the
provider allowance, work waits for the next daily share or reset, or goes to the
Hermes lane while it is under its daily dollar cap (default `$5`).

## Install

Node.js 22 or newer is required. Until the npm package is published, install directly from the public repository:

```bash
npm install --global https://github.com/agent-layer-mcp/usage-guard/releases/latest/download/usage-guard.tgz
usage-guard setup
```

`usage-guard setup` is a guided install. Run it on your own computer, not in a
cloud session: it stops in Claude Code on the web, Codespaces and similar, and
asks first inside a container. Usage is read from the logins on your machine,
so once it is installed there it also tracks the cloud sessions on the same
accounts. It lets you pick any mix of Claude, Codex and Hermes (OpenRouter),
asks before using your Claude Code login (macOS Keychain; on Linux
`~/.claude/.credentials.json`, then the Secret Service keyring), checks and privately saves your
OpenRouter key, and sets up a background timer that ticks every two minutes and
reads each lane every 10 minutes (systemd on Linux, launchd on macOS, Task
Scheduler on Windows). It finishes with a first
reading of each tool. For scripts: `usage-guard setup --yes --tools claude,codex`.
`usage-guard install` remains the non-interactive installer for both tools.

The current release is **0.5.1**. Claude Code **2.1.284 or newer** is required
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

On Linux the installer also writes systemd user units: `usage-guard-monitor.timer`
(started, unless `--disabled`) and `usage-guard-serve.service` (the local API
for the tray, written but not started).

Useful install flags:

- `--disabled` installs switched off with the monitor stopped. A plain
  `usage-guard install` installs switched on.
- `--no-integrations` leaves Claude and Codex settings and plugins untouched.
- `--day-time-zone <zone>` sets the time zone of the daily budget's day start,
  for example `--day-time-zone Australia/Brisbane`.
- `--auto-compact-percent <n>` changes the 40% early-compaction point.

### What the hookup changes

With integrations (the default), the installer changes:

- `~/.claude/settings.json`: the `statusLine` command now runs Usage Guard. If you
  already had a status line (for example `~/.claude/hooks/statusline.sh`), Usage
  Guard runs it with the same input and prints its output unchanged, adding
  `| <guard summary>` while switched on. It also adds the plugin and its hooks,
  and sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (40) and
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (1000000).
- `~/.codex/config.toml`: adds the `usage-guard@agent-layer` plugin, the
  `agent-layer` marketplace, and a `[tui] status_line`.

The previous values are saved in `~/.usage-guard/backups/` and in
`~/.usage-guard/install-record.json`. `usage-guard uninstall` puts them back
exactly. For a hand-made backup before installing:

```bash
mkdir -p ~/.usage-guard/my-backup
cp ~/.claude/settings.json ~/.usage-guard/my-backup/claude-settings.json
cp ~/.codex/config.toml ~/.usage-guard/my-backup/codex-config.toml
```

### Stable local install (from a checkout)

To run a checkout day to day without branch switches changing the live tool:

```bash
scripts/deploy-local.sh
usage-guard install --disabled --day-time-zone Australia/Brisbane
```

`deploy-local.sh` packs the checkout into `~/.local/share/usage-guard/app`,
keeps the previous copy in `app.prev`, records the version in
`app/DEPLOYED_VERSION`, links `~/.local/bin/usage-guard` to it, and copies
`~/.local/bin/usage-guard-tray` if the tray has been built. Run `install` from
the deployed command so hooks and services point at the fixed `app` path.
To roll back, move `app.prev` back to `app`.

### More than one computer

Claude and Codex limits belong to your account, not to a computer, so every
computer you use them on draws from the same 5-hour and weekly allowance. A
computer without Usage Guard still spends that allowance; the others only see
it as a sudden jump with no local sessions to explain it. Install Usage Guard
on every computer that runs Claude Code or Codex.

On each computer:

1. Install it (from the release, or from a checkout as above):

   ```bash
   npm install --global https://github.com/agent-layer-mcp/usage-guard/releases/latest/download/usage-guard.tgz
   usage-guard setup --tools claude,codex,hermes
   ```

2. Sign in to the same Claude and Codex accounts. Each install reads the
   account-wide meter from that computer's own logins, so all of them see the
   same totals and work out the same daily share.
3. Use the same day settings everywhere, so they agree on when "today" starts:

   ```bash
   usage-guard config dayTimeZone Australia/Brisbane
   usage-guard config dayStartTime 08:00
   ```

4. Copy the settings you changed. Run `usage-guard config` on the first
   computer and set the same values on the others with
   `usage-guard config <key> <value>`, typically `planPreset` (or
   `modelLadders`), `payAsYouGoDailyCapUsd`, `hermesModel` and
   `codexFirstUntilLeftPercent`. `hermesRepos` holds folder paths, so set it to
   that computer's own paths.
5. Keep the background timer on (`setup` starts it), so each computer's
   reading stays fresh even while it is idle.

What is shared and what is not:

- **Shared:** Claude and Codex quota, and so each day's share. If one computer
  spends today's share, the others see it as spent too.
- **Shared if you use the same OpenRouter key:** the Hermes daily cap is read
  from the key's own spend, so one key means one cap across all computers.
  Separate keys mean a separate cap per key.
- **Per computer:** settings, decision history, routed-task success rates and
  Hermes job folders. These live in `~/.usage-guard/` and are never synced.

Check it worked: `usage-guard status` should show the same weekly percentages
on every computer, within one reading (about 10 minutes).

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

The dashboard runs on `http://127.0.0.1:4765` and binds only to localhost. It
has the same four tabs as the tray: **Overview**, **Models**, **History** and
**Settings**. Its on/off switch is read-only; use the tray or
`usage-guard enable|disable`.

## Model stepping

The default ladders use these exact IDs, verified against the providers'
[Claude model documentation](https://code.claude.com/docs/en/model-config) and
[Codex model documentation](https://learn.chatgpt.com/docs/models):

| Rung | Claude model / effort | Codex model / effort |
| --- | --- | --- |
| 1 | `claude-opus-5-5` / high | `gpt-6.1-sol` / high |
| 2 | `claude-sonnet-5-5` / high | `gpt-6.1-sol` / medium |
| 3 | `claude-sonnet-5-5` / medium | `gpt-6-luna` / high |
| 4, routine only | `claude-haiku-5-5` / default | `gpt-6-luna` / medium |

`gpt-6-astra` is not on the default Codex ladder; add it yourself if you want it
for specialist work.

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

## Your plan's models

Each lane steps down a four-rung model ladder as its share runs low. Pick the
ladder that fits your plan:

```bash
usage-guard config planPreset lower      # Sonnet / Sol medium at the top, Haiku / Luna below
usage-guard config planPreset standard   # the default: Opus / Sol high at the top
usage-guard config planPreset high       # keeps Opus / Sol high for longer
usage-guard config ladders               # show the active ladder per lane
```

For bigger plans, set your own ladder. Any model in `KNOWN_MODELS`
(`src/config.mjs`) is accepted, for example Claude Fable or GPT Astra; an
unknown ID is rejected with the list of known ones:

```bash
usage-guard config modelLadders '{"claude":[{"model":"claude-fable-5-1","effort":"high"},{"model":"claude-opus-5-5","effort":"high"},{"model":"claude-sonnet-5-5","effort":"high"},{"model":"claude-haiku-5-5","effort":"default"}],"codex":[{"model":"gpt-6.1-sol","effort":"high"},{"model":"gpt-6.1-sol","effort":"medium"},{"model":"gpt-6-luna","effort":"high"},{"model":"gpt-6-luna","effort":"medium"}]}'
```

A ladder changes which models are used, never the daily share or the weekly
reserve. `route` and the tray say when a model came from a preset or a custom
ladder. The Hermes lane's model is set separately (`hermesModel`, or the tray's
model picker).

## On/off switch

`usage-guard disable` turns Usage Guard off without uninstalling: hooks return
nothing (no notices, no ask or deny), the monitor does nothing and its Linux
timer stops, `route` exits with code 3 so callers use their own rules, and the
status line shows `UG off`. `usage-guard enable` turns it back on. The setting
is `enabled` (also in `usage-guard config`, the local API and the tray).

`usage-guard install --disabled` installs switched off. Add
`--no-integrations` to also leave Claude and Codex settings and plugins
untouched; run `usage-guard install` later to add them.

## Tray app

`tray/` is a Tauri 2 app over the local API, for Linux, Windows and macOS. See
[tray/README.md](tray/README.md) to build it.

```bash
systemctl --user enable --now usage-guard-serve   # Linux: start the local API
usage-guard-tray &                                 # or: usage-guard serve, then the tray
```

To start it at login on Linux, add a desktop entry to `~/.config/autostart/`
whose `Exec=` is the path to `usage-guard-tray`.

On a Mac:

1. Run `usage-guard install` (or `setup`). Besides the monitor, it adds a login
   service, `sh.agentlayer.usage-guard.serve`, that keeps the tray's local API
   running; `usage-guard uninstall` removes it.
2. Download `usage-guard-tray-macos.dmg` from the latest
   [release](https://github.com/agent-layer-mcp/usage-guard/releases/latest)
   (one build for Apple Silicon and Intel) and drag **Usage Guard** to
   Applications.
3. The app is not signed, so the first time, right-click it in Applications
   and choose **Open**, then **Open** again. After that it opens normally.
4. To start it at login: System Settings → General → Login Items → add
   **Usage Guard**.

It lives in the menu bar only (no Dock icon). A left click opens the panel.
The `.dmg` is built by the `Mac tray` GitHub workflow when a release is
published; run that workflow by hand to get one as a build artifact.

- **Label:** `UG off` when switched off, `UG offline` when the local API is not
  running; otherwise each lane's use of today's share.
- **Opening the panel:** on Linux, clicking the icon opens a menu; choose
  **Show details**. On Windows and macOS a left click opens it.
- **Panel:** four tabs. **Overview** shows the next-job route, the On/Off and
  pause switches, and one compact row each for Claude, Codex and Hermes with
  today and week bars. **Models** holds the Hermes model picker and your plan's
  model ladders. **History** lists recent decisions and the Codex banked reset.
  **Settings** sets the Hermes daily spend cap and explains how it works and the
  privacy boundary.
- The dashboard has the same four tabs, but its On/Off switch is read-only.
- The Codex banked-reset button only opens Codex's usage page after you
  confirm. Usage Guard never spends a banked reset.

## Routing jobs across providers

`usage-guard route --kind code|review|plan|bulk [--json]` picks the lane for
the next job:

- `plan` and `review` stay on Claude while its daily share allows, then Codex.
  They never go to a pay-as-you-go lane.
- `code` and `bulk` go to the subscription lane with the most daily share left.
  When one subscription is spent and the other has under a quarter of today's
  share left, or both are spent, the pay-as-you-go Hermes (OpenRouter) lane
  takes the job with `hermesModel` while it is under `payAsYouGoDailyCapUsd` (default
  `$5`). That lane needs `OPENROUTER_API_KEY` (or the same line in
  `~/.usage-guard/openrouter.env`, which you write yourself); today's spend is read from
  OpenRouter's key endpoint (UTC day). Keep that file `chmod 600` and never
  commit it. The route gives the Hermes command to
  run it with (`hermes -p dstest --provider openrouter ...`), a profile that pins
  hosts and denies data collection, and says to run it from a scratch directory
  or worktree. The tray's model picker lists OpenRouter models that support tool
  calling, with prices and context length (`GET /api/models`, cached a day).
- Lean on Codex: `usage-guard config codexFirstUntilLeftPercent 70` sends `code`
  and `bulk` to Codex while Codex has a fresh reading and at least 70% of its
  week left, ignoring Codex's daily share (the weekly reserve still applies).
  Below the line, or with a stale or missing reading, the normal rules apply and
  the reason says so. Planning and review are unchanged. Hermes-first kinds
  (below) still go to Hermes ahead of this rule while Hermes is open. `usage-guard config codexFirstUntilLeftPercent null` turns it off.
- Nothing left: the lane is `wait`, with the time the next daily share starts.
- `{"routingPaused": true}` stops routing; a banked provider reset is never
  spent automatically.
- Hermes job kinds (`code`, `bulk`, `lint-format`, `test-write`, `test-triage`,
  `doc-update`, `rename-mechanical`, `file-scan`) go to Hermes first, all day,
  while it is under the cap, but only for repos listed in `hermesRepos` (none by
  default). Hermes does the dev work; Claude keeps planning and review. Pass
  `--repo <path>` (default: the current folder) and `--failed <n>`; after two
  failed Hermes attempts the job escalates to Claude or Codex. See
  [docs/hermes-jobs.md](docs/hermes-jobs.md).
- Task fit: `--difficulty easy|medium|hard` (default `medium`) sets the model
  rung on Claude and Codex: hard = rung 1, medium = rung 2, easy = rung 4 (Haiku
  5.5, gpt-6-luna). Quota can only make the pick cheaper. Pass `--role` for
  protected work (planning, architecture, review, sensitive): it stays at rung 2
  or stronger and, like `hard`, never goes to Hermes. Each failed attempt after
  Hermes moves one rung stronger, never past what quota allows; a lane that
  can't go stronger is skipped, then the route waits. The MCP tool
  `usage_guard_route` takes the same inputs.
- When the route says `hermes`, the agent runs the task with the MCP tool
  `usage_guard_hermes_job` (kind, full task text, repo, optional check command)
  instead of a Claude sub-agent, then reviews the returned worktree diff before
  applying it. To make that happen without relying on the agent remembering,
  Claude's PreToolUse hook stops a general-purpose sub-agent once per 30 minutes
  per session when Hermes is open for that repo, and says to use the Hermes
  tool. Starting the sub-agent again goes through, so hard or protected work is
  never stuck. Planning, review and sensitive prompts, read-only agents such as
  Explore, and repos outside `hermesRepos` are not stopped. A Hermes job can take
  up to 20 minutes; raise the client's MCP tool timeout if it gives up sooner.
- `usage-guard outcome --lane <lane> --model <id> --kind <kind> --difficulty <d>
  --result pass|fail|unchecked|lane-error` (or `usage_guard_outcome`) records
  how a routed task went; no task text is stored. `status` and the History tab
  show pass rates per model and task type for the last 14 days.
- `usage-guard hermes-job --kind <type> --task-file <file> --repo <path>` runs one
  such job: it refuses planning and review, tasks that mention secrets, auth,
  billing, children, Godot or demos, repos not opted in, and repos with committed
  secret-like files. It runs `hermes` in a scratch worktree of committed files
  under `~/.usage-guard/jobs/`, keeps the full log there and prints a short
  summary. Nothing is applied to the repo; review the worktree diff first.
  `--check "<test command>"` runs the check in the worktree afterwards, with
  Hermes's stripped environment and the repo's `node_modules` linked in, and
  records the result (`pass`, `fail`, `unchecked`, or `lane-error` for a timeout
  or no credit).
- `usage-guard test-run -- <command>` runs a test suite with no model, saves the
  full log in `~/.usage-guard/test-runs/` and prints only failing test names and
  short errors. It exits with the suite's exit code.
- Change the Hermes lane with `usage-guard config hermesModel <openrouter-model-id>`
  and `usage-guard config payAsYouGoDailyCapUsd 5`, or in the tray.

Pass `--claude-used <pct> --claude-hours <h> [--claude-5h <pct>]` when the
plan limits come from the host (for example Claude Desktop's usage tool) rather
than the status line. `GET /api/route?kind=code` on the local dashboard returns
the same preview without logging it. Third-party lanes must never receive `.env`
files, secrets, user data or children's data; Usage Guard only routes, it never
proxies subscription tokens or cookies.

## Policy states

| State | Behavior |
| --- | --- |
| `safe` | Work normally; avoid duplicate context. |
| `watch` | Reuse evidence, compact at safe boundaries, and bound parallel work. |
| `protect` | Use one active path, preserve strong planning/review, and stop speculative branches. |
| `queue` | Pause new prompts and tool calls at the reserve; save a quota-only handover when model stepping is active. |
| `missing` / `stale` | Refresh the meter; never block from uncertain data. |

Default reserves are 8% for windows up to six hours and 5% for longer windows. Change them locally with `usage-guard config`.

### Daily budget

Weekly windows are also split into equal daily shares, so a heavy day cannot
spend the rest of the week:

```
today's share = (100 − weekly reserve − % used when today began) ÷ days left until the weekly reset
```

Days are counted fractionally, so a short last day before the reset gets a
matching short share.
A day starts at `dayStartTime` (default `08:00`) in `dayTimeZone` (default: the
system time zone; set it with `install --day-time-zone` or
`usage-guard config dayTimeZone Australia/Brisbane`). The starting figure is the
last reading at or before the day start; readings from before Usage Guard was
installed are filled in from Codex session logs and Claude Desktop's local
usage cache. Unspent share rolls into later days automatically. If a weekly
meter falls by more than 2 points mid-period, Usage Guard treats it as a
provider reset and counts today's share from the reading after the drop
(`src/daily-budget.mjs`). Once
today's share is spent the provider moves to `protect` (never `queue`), the
reason says how much was borrowed from later days, model stepping drops
one rung, and `route` sends new work to another lane. It never asks for approval or denies a tool. Only the weekly reserve blocks work. Turn it off with
`{"dailyBudget": false}`.

The background timer ticks every two minutes. A lane whose daily share is spent
is re-read on every tick; other lanes every 10 minutes (`pollDue` in
`src/monitor.mjs`). Claude also refreshes at most once a minute while a Claude
Code session is working.

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
  aggregate five-hour/weekly cache ingestion, and background macOS or Linux
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
- Linux: `usage-guard install` adds a systemd user timer
  (`usage-guard-monitor.timer`) that runs the monitor on the timings above, and
  alerts use `notify-send`. Claude Desktop's aggregate cache is read from
  `~/.config/Claude` (or `$XDG_CONFIG_HOME/Claude`); it has no reset time, so the
  Claude daily share appears once the Claude Code status line has reported one.
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

The Hermes (OpenRouter) lane is the one path that sends work to a third party:
when you run the routed `hermes` command, its prompt and any files it reads go
to OpenRouter and the model host. Usage Guard itself only reads the key's spend
total and the public model list from OpenRouter; it does not store prompts. Never
give that lane `.env` files, secrets, user data or children's data.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Remove

```bash
usage-guard uninstall
npm uninstall --global @agent-layer/usage-guard
```

The uninstall command removes both plugin integrations and restores the prior status-line settings without replacing unrelated current settings.
On macOS it also unloads the Usage Guard background monitor and removes the
native notification helper and Screenshot Memory gateway. Claude's prior
`ANTHROPIC_BASE_URL` is restored. On Linux it stops and removes the systemd
units.

It leaves behind `~/.usage-guard` (readings history, backups, install record)
and anything `deploy-local.sh` or you added: `~/.local/bin/usage-guard`,
`~/.local/bin/usage-guard-tray`, `~/.local/share/usage-guard`, and any tray
autostart entry. Delete those by hand if you want them gone.

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
