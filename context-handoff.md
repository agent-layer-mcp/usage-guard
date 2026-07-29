# Usage Guard Context Handoff

Last updated: 2026-07-30 (Australia/Brisbane)

## Start here

Repository:

```text
/Users/ryanjones/Documents/usage-guard
```

Usage Guard is a local-first quota governor for Claude Code, Claude Desktop
Code, Codex CLI, and Codex Desktop. It preserves a protected quota reserve
without silently lowering the selected model or reasoning effort.

Release `0.4.0` is implemented, verified, installed locally, and committed with
the subject `feat: enforce Claude usage and compact early`.

## Why 0.4.0 was needed

The user exhausted Claude usage twice in less than an hour without seeing an
intervention. The investigation found three product assumptions that were too
weak:

1. Claude `PreToolUse` enforcement existed in code and tests but was not
   registered in the shipped plugin.
2. The post-response `Stop` hook's `systemMessage` was treated as a reliable
   visible Desktop footer. It is not a dependable enforcement surface in the
   observed Desktop build.
3. `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` was treated as proof that
   Claude Desktop used Screenshot Memory. Desktop has a separate supported
   Third-Party Inference configuration, so settings-file routing proves only
   the Claude CLI path.

The background monitor also notified only when the provider-wide severity
increased. A newly pressured short window could therefore become controlling
without a second notification when the weekly window had already placed the
provider at the same severity.

## Supported controls confirmed

Claude's supported local Code controls provide:

- `UserPromptSubmit` blocking before a new turn.
- `PreToolUse` permission decisions, including visible `ask` and `deny`.
- `PostToolBatch` blocking before the next model request.
- `SessionStart` context injection.
- Native proactive compaction through
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.
- `PostCompact` with Claude's provider-generated `compact_summary`.

Claude Desktop does not expose a supported way for a plugin to silently create,
submit, and switch to a fresh Code session. `claude://code/new` can prefill a
composer, but supplying a folder still requires confirmation. The reliable
fully automatic path is therefore native compaction inside the current session,
with a durable handoff available if the user starts a fresh session.

## What 0.4.0 implements

### Active-run enforcement

The Claude plugin now registers both `PreToolUse` and `PostToolBatch`.

- At `PROTECT`, the first tool boundary in a session returns the documented
  `permissionDecision: "ask"`, which creates a visible approval gate.
- At `QUEUE`, `PreToolUse` returns `permissionDecision: "deny"` plus the
  universal stop fields.
- At `QUEUE`, `PostToolBatch` independently blocks before another model request.
- Missing or stale quota evidence still fails open.

The `Stop` footer remains a best-effort host message for compatible surfaces,
not part of the safety boundary.

### Earlier compaction without reducing quality

The installer configures Claude's native proactive compaction at 40% of the
active model window by default:

```text
CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40
```

Claude performs the summary using its own active-session compaction machinery.
Usage Guard does not substitute a smaller model, lower reasoning effort, or
invent a summary. The threshold can be changed during installation with:

```bash
usage-guard install --auto-compact-percent 50
```

The installer records and restores the user's prior values exactly.

### Durable compaction handoff

After a manual or automatic compaction, `PostCompact` stores Claude's supplied
compact summary at:

```text
~/.usage-guard/handoffs/<project-key>/context-handoff.md
```

Properties:

- keyed by the Git common directory so worktrees share project continuity
- stored outside the repository
- private directories and mode `0600` files
- atomic write
- raw transcript is never read
- summary is bounded to 40,000 characters
- fresh-session injection carries the full bounded summary and is capped at
  48,000 characters including the handoff wrapper
- the same session does not receive its own handoff
- a different session for the same project receives it through `SessionStart`
- handoffs older than seven days are deleted when encountered
- `usage-guard reset` deletes all handoffs
- `usage-guard config compactionHandoffEnabled false` disables the feature

The handoff can contain conversation facts because it is Claude's compact
summary. This is disclosed in `PRIVACY.md`, CLI privacy output, and MCP status.

### Notification correction

The one-minute macOS monitor now notifies when a newly pressured quota window
becomes controlling at the same or a higher overall severity. This fixes the
case where an already-pressured weekly window masked a fast five-hour
escalation.

### Honest Desktop gateway diagnosis

`usage-guard doctor` now reports Claude Desktop gateway routing as `WAIT` unless
it can be verified separately. A normal claude.ai subscriber Desktop session
remains direct. Users with a credentialed Third-Party Inference gateway can
configure the localhost Screenshot Memory route intentionally, but Usage Guard
does not claim that settings-file environment variables configure Desktop.

## Verified local installation

Installed on 2026-07-30:

```text
Usage Guard source:       0.4.0
Claude CLI:               2.1.220
Codex CLI:                0.146.0
Native early compact:     40%
Auto-compact window:      1,000,000
Claude plugin:            installed and enabled
Codex plugin:             installed and enabled
Desktop monitor:          enabled, one-minute interval
Native notifications:     enabled
Screenshot Memory:        enabled for Claude CLI, five-user-turn visual tail
Claude Desktop gateway:   deliberately unverified
Quality lock:             enabled
```

The installed status-line command and hook bootstrap use absolute Node and
Usage Guard paths, so they do not depend on a GUI process inheriting Terminal's
`PATH`.

A direct native notification smoke test exited successfully after installation
with the message:

```text
Early compaction is active at 40%. Claude is currently WATCH:
8% five-hour, 70% weekly.
```

The live percentages will naturally change. At verification time:

```text
Claude: WATCH — five-hour 8%, weekly 70%, weekly reset in about 1d 2h
Codex:  SAFE  — weekly 6%, reset in about 6d 7h
```

The real `PreToolUse` hook was also exercised against the installed state and
returned the expected `WATCH` context. The visible `PROTECT` ask and `QUEUE`
deny paths are covered by deterministic integration tests without consuming
additional Claude quota.

## Verification completed

```text
npm run check
  Checked 35 JavaScript modules.

npm test
  67 passed, 0 failed.

npm pack --dry-run
  Passed prepack checks and included the new handoff module.

claude plugin validate ./plugins/usage-guard
  Passed.

node bin/usage-guard.mjs doctor
  All installed controls passed.
  Claude Desktop gateway correctly reported WAIT/unverified.
```

## Key files changed

```text
src/compaction-handoff.mjs
  Private project identity, bounded handoff writes/reads, retention, reset.

src/hooks.mjs
  SessionStart handoff injection, PostCompact storage, PreToolUse ask/deny,
  PostToolBatch circuit breaker.

plugins/usage-guard/hooks/hooks.json
  Registers PreToolUse, PostToolBatch, and PostCompact.

src/install.mjs
  Native 40% auto-compaction configuration, exact rollback, honest doctor.

src/monitor.mjs
  Alerts when the controlling quota window changes under equal severity.

src/config.mjs
src/mcp.mjs
src/policy.mjs
src/presentation.mjs
  Configuration and privacy/status exposure.

README.md
PRIVACY.md
SECURITY.md
docs/architecture.md
CHANGELOG.md
  Supported-control and data-boundary documentation.
```

## Remaining acceptance check

Do not spend Claude quota solely to test the UI while Claude is pressured.
During the next normal fresh Claude Desktop Code task:

1. Confirm the Usage Guard hooks are trusted/enabled if Desktop prompts.
2. Let the session run normally.
3. If policy reaches `PROTECT`, confirm the next tool call shows a Usage Guard
   approval gate.
4. If a compaction occurs, confirm a private handoff appears below
   `~/.usage-guard/handoffs/`.
5. Start a fresh task for the same repository only when naturally useful and
   confirm continuity from the compact summary.

No product work should attempt to fake an automatic clear/new-task action until
Claude Desktop exposes a supported session-creation API.

## Commands

```bash
cd /Users/ryanjones/Documents/usage-guard

node bin/usage-guard.mjs status
node bin/usage-guard.mjs doctor
node bin/usage-guard.mjs config

npm run check
npm test
npm pack --dry-run

claude plugin validate ./plugins/usage-guard
```

## Next action

Use the next normal Claude Desktop task as the UI acceptance test. Do not
revive the old assumptions that a `Stop` `systemMessage` must be visible or
that `ANTHROPIC_BASE_URL` in Claude settings controls Desktop.
