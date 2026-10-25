# Task-fit Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each delegated task to a model that fits its difficulty, never more expensive than quota allows, with a free check, escalation and recorded outcomes.

**Architecture:** A pure rung function (`src/task-fit.mjs`) combines difficulty, quota rung, role and failure count. `routeJob` uses it to pick each subscription lane's model from the existing ladders and to keep hard/protected work off Hermes. Outcomes go to a new SQLite table; `hermes-job` gains an optional check and records its own outcome.

**Tech Stack:** Node ESM (`.mjs`), `node:sqlite` via `GuardStore`, `node --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-task-fit-routing-design.md`

## Global Constraints

- No new dependencies; match surrounding code style and comment density.
- No `--difficulty` means `medium`. Medium = rung 2 (deliberate change, Ryan 2026-10-25); hard = 1; easy = 4.
- Quota can only push cheaper, except the existing protected clamp: protected roles are never cheaper than `protectedMaxRung` (2).
- Protected = kinds `plan`/`review`, or role `planning`, `architecture`, `review`, `sensitive`. Protected `easy` counts as `medium`.
- `hard` and protected work never go to Hermes, first or as fallback.
- Never store task text, prompts or code. Outcome rows hold lane, model, kind, difficulty, result, created_at only.
- Outcome rows prune at 14 days alongside decisions.
- `src/ui/*.js` changes are mirrored byte-for-byte into `tray/ui/` (same files exist in both).
- Deploy only with `scripts/deploy-local.sh`; commit, never push.

## Review Focus

1. Stale or missing quota reading (`quotaRung` null): routing must fall back to today's lane fields, not crash or pick rung 1 → pinned in Task 2 (`stale lane keeps old model fields`).
2. Model stepping off or quality lock on: no task-fit rewrite; lanes keep the decision's own model → pinned in Task 2.
3. `--failed` large (e.g. 9) on easy work: rung never below 1, and lanes that can't go stronger are skipped, ending in `wait` → pinned in Task 1 and Task 2.
4. Hermes job in a repo with no `node_modules`, or a check command that is missing: result is `fail`, job not crashed, worktree kept for inspection → pinned in Task 4.
5. Invalid `--difficulty` or `--role` values from the CLI/MCP: clear `TypeError`, no silent default → pinned in Task 2 and Task 5.

---

### Task 1: Task-fit rung function

**Files:**
- Create: `src/task-fit.mjs`
- Test: `test/task-fit.test.mjs`

**Interfaces:**
- Produces: `DIFFICULTIES = ["easy", "medium", "hard"]`, `PROTECTED_ROLES` (moved here from `model-stepping.mjs`, re-imported there), and
  `taskFitRung({ difficulty = "medium", quotaRung, protectedRole = false, protectedMaxRung = 2, subscriptionFailures = 0 }) -> { rung: 1-4, capped: boolean }`.
  `capped` is true when `subscriptionFailures > 0` and the rung equals the rung for `subscriptionFailures - 1` (this lane cannot go any stronger).

- [ ] **Step 1: Write the failing tests** (`test/task-fit.test.mjs`)

```js
const r = (o) => taskFitRung({ quotaRung: 1, ...o }).rung;
test("difficulty sets the rung when quota is healthy", () => {
  assert.equal(r({ difficulty: "easy" }), 4);
  assert.equal(r({ difficulty: "medium" }), 2);
  assert.equal(r({}), 2);
  assert.equal(r({ difficulty: "hard" }), 1);
});
test("quota only pushes cheaper", () => {
  assert.equal(r({ difficulty: "hard", quotaRung: 3 }), 3);
  assert.equal(r({ difficulty: "easy", quotaRung: 2 }), 4);
});
test("protected work is at least medium and never cheaper than rung 2", () => {
  assert.equal(r({ difficulty: "easy", protectedRole: true }), 2);
  assert.equal(r({ difficulty: "hard", protectedRole: true, quotaRung: 4 }), 2);
  assert.equal(r({ difficulty: "hard", protectedRole: true }), 1);
});
test("failures step stronger down to the quota rung, then cap", () => {
  assert.deepEqual(taskFitRung({ difficulty: "easy", quotaRung: 1, subscriptionFailures: 2 }), { rung: 2, capped: false });
  assert.deepEqual(taskFitRung({ difficulty: "medium", quotaRung: 2, subscriptionFailures: 1 }), { rung: 2, capped: true });
  assert.equal(r({ difficulty: "easy", subscriptionFailures: 9 }), 1);
});
test("unknown difficulty throws", () => {
  assert.throws(() => taskFitRung({ difficulty: "trivial", quotaRung: 1 }), TypeError);
});
```

- [ ] **Step 2: Run** `node --test test/task-fit.test.mjs` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `taskFitRung` per the interface: task rung `{hard:1, medium:2, easy:4}` (protected easy → medium); `want = max(1, taskRung - failures)`; `rung = max(want, quotaRung)`; protected → `min(rung, protectedMaxRung)`; clamp to 1–4. Move `PROTECTED_ROLES` here and import it in `src/model-stepping.mjs`.
- [ ] **Step 4: Run** `node --test test/task-fit.test.mjs && npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `git add src/task-fit.mjs src/model-stepping.mjs test/task-fit.test.mjs && git commit -m "Add task-fit rung function"`

### Task 2: Route by difficulty

**Files:**
- Modify: `src/route.mjs` (`routeJob`, `subscriptionLane`, `hermesJobGate`)
- Modify: `bin/usage-guard.mjs` (`route` command: `--difficulty`, `--role`)
- Modify: `bin/usage-guard.mjs:326` (`formatRoute`): print difficulty and rung
- Test: `test/route.test.mjs`, `test/hermes-jobs.test.mjs`

**Interfaces:**
- Consumes: `taskFitRung`, `DIFFICULTIES`, `PROTECTED_ROLES` (Task 1); `TASK_ROLES` from `model-stepping.mjs`.
- Produces: `routeJob(store, kind, { difficulty?, role?, failedAttempts?, repo?, payAsYouGo?, now?, config?, record? })`. Route result adds `difficulty`, `rung` (null for Hermes/wait) and each lane adds `rung` and `capped`. Throws `TypeError` for a difficulty not in `DIFFICULTIES` or a role not in `TASK_ROLES`.

Rules (from the spec):
- `protectedRole = kind === "plan" || kind === "review" || PROTECTED_ROLES.has(role)`.
- Lane quota rung = `decision.routineRung` for `ROUTINE_KINDS`, else `decision.quotaRung`. If that is null (stale, stepping off, quality lock), keep today's model fields and set `rung: null`.
- Lane model/effort = `config.modelLadders[provider][rung - 1]`.
- Hermes candidate = Hermes kind, not `hard`, not protected, kind in `hermesJobKinds`, repo allowed. `subscriptionFailures = candidate ? max(0, failed - HERMES_MAX_ATTEMPTS) : failed`.
- `hard` or protected: no Hermes, first or fallback; the reason says so.
- When `subscriptionFailures > 0`, skip lanes with `capped: true`; if none remain, lane `wait` with reason "No lane can take a stronger model for this task within its quota."

- [ ] **Step 1: Write failing tests** in `test/route.test.mjs` (reuse its `fixture` helper; healthy quota on both):
  - `easy file-scan on Claude picks Haiku`: with Hermes closed (`payAsYouGo` capped), `routeJob(store, "file-scan", { difficulty: "easy", repo: tmp })` → rung 4: model `claude-haiku-5-5` if lane `claude`, `gpt-6-luna` effort `medium` if lane `codex`.
  - `untagged code picks rung 2`: model `claude-sonnet-5-5`, effort `high` (or `gpt-6.1-sol` `medium` when Codex wins).
  - `hard code picks rung 1 and never Hermes`: Hermes open, repo allowed → lane not `hermes`, rung 1.
  - `role sensitive keeps easy code off Hermes and at rung 2`.
  - `failed on a capped lane switches lane, then waits`: medium, quota rung 2 on both, `failedAttempts: 1` → `wait`.
  - `stale lane keeps old model fields`: stale Claude reading → `rung: null`, model equals the decision's `recommendedModel`.
  - `bad difficulty or role throws TypeError`.
  - In `test/hermes-jobs.test.mjs`: `easy code goes to Hermes, hard code does not`; after 2 Hermes failures, `failedAttempts: 2` routes to a subscription at the task rung (rung 2 for medium), `failedAttempts: 3` → rung 1.
- [ ] **Step 2: Run** `node --test test/route.test.mjs test/hermes-jobs.test.mjs` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** the rules above in `routeJob`/`subscriptionLane`; add `--difficulty` and `--role` to the `route` CLI using `stringOption`; show `difficulty` and `rung` in `formatRoute`.
- [ ] **Step 4: Run** `npm test`. Existing tests that asserted rung-1 models for untagged standard work now see rung 2: update those assertions only, each with a one-line comment "medium = rung 2 (task-fit routing)". Expected: all pass.
- [ ] **Step 5: Commit** `git commit -am "Route by task difficulty on top of quota"`

### Task 3: Outcome store and CLI

**Files:**
- Modify: `src/store.mjs` (table, `recordOutcome`, `outcomeRates`, prune)
- Modify: `bin/usage-guard.mjs` (`outcome` command)
- Test: `test/outcomes.test.mjs`

**Interfaces:**
- Produces: `OUTCOME_RESULTS = ["pass", "fail", "unchecked", "lane-error"]` (export from `src/store.mjs`);
  `store.recordOutcome({ lane, model, kind, difficulty, result, createdAt })`;
  `store.outcomeRates(now, maxAgeMs = 14 days) -> [{ lane, model, kind, difficulty, pass, fail, total, rate }]` where `total = pass + fail` and `rate = pass / total` (null when total is 0); `unchecked` and `lane-error` are excluded from `total`.
  `pruneDecisions` also deletes `route_outcomes` older than its cutoff.
- CLI: `usage-guard outcome --lane <claude|codex|hermes> --model <id> --kind <route kind> --difficulty <d> --result <pass|fail|unchecked|lane-error>`; validates every field, prints one confirmation line.

- [ ] **Step 1: Write failing tests**: record 3 pass + 1 fail + 1 unchecked for (claude, claude-haiku-5-5, file-scan, easy) → `{ pass: 3, fail: 1, total: 4, rate: 0.75 }`; a row 15 days old is gone after `pruneDecisions(now)`; `recordOutcome` with `result: "maybe"` throws `TypeError`.
- [ ] **Step 2: Run** `node --test test/outcomes.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** table `route_outcomes(id, lane, model, kind, difficulty, result, created_at)` with index on `created_at`, the methods and the CLI command.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `git commit -am "Record routed task outcomes"`

### Task 4: Hermes job check and self-recorded outcome

**Files:**
- Modify: `src/hermes-job.mjs` (`runHermesJob`)
- Modify: `bin/usage-guard.mjs` (`hermes-job`: `--check "<cmd>"`, `--difficulty`)
- Test: `test/hermes-jobs.test.mjs`

**Interfaces:**
- Consumes: `runTests(command, { cwd, env })` from `src/test-run.mjs`; `hermesEnv`; `store.recordOutcome` (Task 3); `routeJob` difficulty (Task 2).
- Produces: `runHermesJob(store, { ..., check?: string[], difficulty? })`; summary gains `check: { exitCode, logFile } | null` and `result` (one of `OUTCOME_RESULTS`).

Rules: after Hermes runs, if the source repo has `node_modules`, symlink it into the worktree (after the secret scan); run `check` with `cwd: worktree, env: hermesEnv(env)`. `result`: timeout or no credit → `lane-error`; Hermes failed → `fail`; no check → `unchecked`; check exit 0 → `pass`, else `fail`. Keep `ok` = `result === "pass" || result === "unchecked"` for existing callers. Record the outcome with lane `hermes`, model `config.hermesModel`.

- [ ] **Step 1: Write failing tests** (fake `hermesBin` scripts as the existing tests do): check `true` → `result: "pass"` and one `pass` row; check `false` → `fail`; no check → `unchecked`; missing check command (`["/no/such/bin"]`) → `fail` without throwing; check sees no `ANTHROPIC_API_KEY` even when the parent env has one (check script exits 1 if `$ANTHROPIC_API_KEY` is set); a repo with `node_modules/x/index.js` → the check can `test -e node_modules/x/index.js`.
- [ ] **Step 2: Run** `node --test test/hermes-jobs.test.mjs` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** per the rules. Catch a spawn error from `runTests` (missing binary) as `fail`.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `git commit -am "Check Hermes jobs and record their outcome"`

### Task 5: MCP tools for route and outcome

**Files:**
- Modify: `src/mcp.mjs`
- Test: `test/mcp.test.mjs`

**Interfaces:**
- Produces: `usage_guard_route` (input `kind` required, `difficulty`, `role`, `failed`, `repo`; returns the `routeJob` result with `record: true`) and `usage_guard_outcome` (same fields as the CLI). Enums in the schemas come from `ROUTE_KINDS`, `DIFFICULTIES`, `TASK_ROLES`, `OUTCOME_RESULTS`; `additionalProperties: false`.

- [ ] **Step 1: Write failing tests**: tools are listed; `usage_guard_route { kind: "file-scan", difficulty: "easy" }` returns a `lane`; `usage_guard_outcome` with `difficulty: "trivial"` returns an error result, not a crash.
- [ ] **Step 2: Run** the MCP test file — Expected: FAIL.
- [ ] **Step 3: Implement** both tools following `usage_guard_decision`'s pattern; route reads OpenRouter spend the same way the CLI does.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `git commit -am "Expose route and outcome over MCP"`

### Task 6: Show success rates

**Files:**
- Modify: `src/service.mjs` (`completeStatus` adds `outcomeRates`)
- Modify: `src/presentation.mjs` (`formatStatusText`: up to 5 rows, worst rate first, "N more" after)
- Modify: `src/ui/panel.js`, `src/ui/render.js` (History card "Model results, last 14 days"); mirror into `tray/ui/`
- Test: status/presentation tests that already cover `formatStatusText`; UI render test if one exists for `decisionsHtml`

**Interfaces:**
- Consumes: `store.outcomeRates` (Task 3).
- Produces: `outcomeRatesHtml(rows) -> string` in `src/ui/render.js` (escapes with `esc`; empty state "No checked results yet.").

- [ ] **Step 1: Write failing tests**: `formatStatusText` with 7 rate rows shows 5 and "2 more"; `outcomeRatesHtml([])` contains "No checked results yet."; a model name with `<` is escaped.
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement**; copy the changed `src/ui` files into `tray/ui`.
- [ ] **Step 4: Run** `npm test && diff -q src/ui/render.js tray/ui/render.js && diff -q src/ui/panel.js tray/ui/panel.js` — Expected: pass, no diff output.
- [ ] **Step 5: Commit** `git commit -am "Show model success rates"`

### Task 7: Guidance, docs and deploy

**Files:**
- Modify: `src/model-stepping.mjs` (`switchingInstructions`: one added sentence)
- Modify: `plugins/usage-guard/skills/usage-guard/SKILL.md`, `README.md` (routing section), `docs/hermes-jobs.md` (`--check`, results)
- Test: the existing test that asserts `switchingInstructions` text, if any

Copy for the added sentence (both the hook and SKILL.md):
"Before delegating, tag each sub-task easy, medium or hard and get its model from usage_guard_route (or `usage-guard route --kind <kind> --difficulty <d>`); pass role for protected work; after its check, report the result with usage_guard_outcome."

- [ ] **Step 1:** Add the sentence; add the difficulty guide from the spec (§1) to SKILL.md in two lines; document `--difficulty`, `--role`, `outcome`, `--check` in README and hermes-jobs.md.
- [ ] **Step 2: Run** `npm test && npm run check` — Expected: all pass.
- [ ] **Step 3: Commit** `git commit -am "Tell agents to tag difficulty and report outcomes"`
- [ ] **Step 4: Deploy** `bash scripts/deploy-local.sh`, then `usage-guard route --kind file-scan --difficulty easy --repo /tmp` and `usage-guard route --kind code --difficulty hard` — Expected: the first shows a rung-4 model (or Hermes closed → Haiku/Luna), the second rung 1 or the quota rung, never Hermes.
