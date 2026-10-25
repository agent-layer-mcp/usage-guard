# Task-fit routing (design)

Status: draft for approval. Owner: Ryan. Date: 2026-10-25.
Related: `src/route.mjs`, `src/model-stepping.mjs`, `src/hermes-job.mjs`,
[docs/hermes-jobs.md](../../hermes-jobs.md), ruflo review (2026-10-25 session).

## Why

Usage Guard already paces Claude and Codex so neither runs out before its
weekly reset. It picks models by quota only: an easy rename gets the same model
as a normal feature. Ryan wants more work done in parallel on the same daily
and weekly allowance. The way to get it is to send easy work to smaller models
(Hermes, Haiku 5.5, gpt-6-luna) while pacing stays in charge.

## Goals

- The same daily/weekly share finishes noticeably more tasks.
- Usage first: quota can always make a pick cheaper, never more expensive.
- A cheap model's failed work is caught by a free check and retried one step
  up, so a botch costs one retry, not a mess.
- Success and failure per model and task type is recorded, so the lines can be
  tuned from real results later.

## Non-goals

- No extra model call per task to decide routing. The main session (already on
  a strong model) tags each sub-task as it delegates.
- No learned or bandit routing in this version (ruflo's keyword scorer was 55%
  right, barely above "always strong"; its learned routers were only tested on
  synthetic tasks). Record outcomes now, tune by hand later.
- No change to quota pacing, reserves, daily shares or the Hermes never-list.

## Anti-goals (a failure even if it works)

- Spending more quota than today for the same work.
- Planning, review, or protected work (money, security, auth, children's data,
  production) going below rung 2, or to Hermes.
- Never-list topics reaching Hermes.

## How it works

### 1. The main session tags difficulty

When delegating, the main session gives each sub-task a kind (existing route
kinds) and a difficulty:

- `easy`: mechanical, a small known area, a clear pass/fail check (lint, rename,
  docs, file scans, small well-specified edits, tests for finished code).
- `medium`: normal feature or fix work. The default when no difficulty is given.
  This is a deliberate change (Ryan, 2026-10-25): with healthy quota, untagged
  standard work moves from rung 1 (Opus / Sol high) to rung 2 (Sonnet high /
  Sol medium). Only `hard` gets rung 1.
- `hard`: design, cross-cutting changes, debugging an unknown cause, anything
  protected.

It calls `usage-guard route --kind <kind> --difficulty <easy|medium|hard>`
(and the MCP equivalent) and uses the returned lane, model and effort.

### 2. Usage Guard combines difficulty with quota

Each lane's ladder is unchanged (rung 1 strongest, rung 4 cheapest).

- Task rung: `hard` → 1, `medium` → 2, `easy` → 4.
- Quota rung: today's quota rung, plus `routineStepDownRungs` for routine kinds
  (as today).
- Final rung = the cheapest of the task rung and the quota rung, then clamped so
  protected roles are never cheaper than `protectedMaxRung` (2). This replaces
  today's "standard work caps at rung 3" rule for routed work.
- Protected work: `plan` and `review` kinds, and any route call with
  `--role planning|review|sensitive`, are protected. A protected `easy` tag is
  treated as `medium`. `route` never sees task text (privacy rule), so outside
  plan/review the main session must pass the role; the guidance says so.
- Lane: `easy` and `medium` code/bulk/Hermes kinds go to Hermes first (as
  shipped in d8be60e). `hard` and protected work never go to Hermes, neither
  first nor as the last-resort fallback.

Example with today's ladders: easy file scan on Claude → Haiku 5.5; medium code
on Codex → gpt-6.1-sol medium; hard design on Claude with healthy quota → Opus.

### 3. Check, then escalate

- `usage-guard hermes-job` gains an optional `--check "<test command>"`. After
  Hermes runs, the check runs in the scratch worktree via the existing
  `test-run`, with the same stripped environment Hermes gets (`hermesEnv`), so
  model-written code never sees secrets. The worktree has no `node_modules`:
  if the source repo has one, symlink it into the worktree after the secret
  scan. The job is `ok` only if Hermes exited cleanly and the check passed.
- For subscription lanes, the main session runs the check itself and reports
  the result (step 4).
- On failure the caller routes again with `--failed <n>` (one counter for the
  task). Hermes keeps its rule: two failures go to a subscription lane, which
  starts at the task rung. Each failure after that moves the pick one rung
  stronger: rung = max(quota rung, task rung − subscription failures). Already
  at the quota rung: try the other subscription lane at its own rung; if it has
  no share, `wait`.

### 4. Record outcomes

- New table `route_outcomes`: lane, model, kind, difficulty, result, created_at.
  `result` is `pass`, `fail`, `unchecked` (no check was run) or `lane-error`
  (timeout, 402/no credit). Only pass/fail count in success rates. No task text,
  prompts or code are stored.
- `hermes-job` records its own outcome. Other lanes record with
  `usage-guard outcome --lane --model --kind --difficulty --ok|--failed`
  (and an MCP tool).
- `usage-guard status` and the dashboard History tab show success rate per
  model × kind × difficulty over the last 14 days. Rows older than 14 days are
  pruned with the existing decision pruning.

### 5. Guidance to the main session

The hook context and the plugin skill (`plugins/usage-guard/skills/usage-guard/SKILL.md`)
tell the main session to tag difficulty, call route per sub-task, run a check
and report the outcome. They stay short; the difficulty guide above goes there
in one or two lines.

## Constraints

- Plain Node, no new dependencies; matches existing code style.
- Backwards compatible: no `--difficulty` means `medium`, today's behaviour.
- Every new branch has a test (route rung math, escalation cap, outcome record).
- Local deploy with `scripts/deploy-local.sh`; nothing pushed without Ryan.

## Left to the builder

- Exact CLI flag and MCP field names.
- Where the success table sits in the History tab.
- Whether `--check` defaults to the repo's `npm test` when present (only once the
  `node_modules` link works).

## Calls made in this design (not yet confirmed by Ryan)

- `hard` and protected work never go to Hermes, first or as fallback.
- Escalation never goes stronger than the quota rung; it switches lane or waits.
- Protection outside plan/review relies on the main session passing `--role`.
- Checks run with Hermes's stripped environment; `node_modules` is symlinked in.
- Unchecked jobs and lane errors (timeouts, no credit) don't count as model results.
- Outcomes are shown, not used for automatic tuning, in this version.
