# Hermes job types (spec)

Status: route kinds, escalation, `test-run` and `hermes-job` built; review check not built. Owner: Ryan. Last reviewed: 2026-10-20.
Related: [README routing section](../README.md#routing-jobs-across-providers),
`src/route.mjs`.

## Goal

Slow down daily use of the Claude and Codex subscriptions by sending a few
small, easily checked kinds of work to the pay-as-you-go Hermes (OpenRouter)
lane all day, while it is under `payAsYouGoDailyCapUsd` (default `$5`). Today
Hermes only takes work once the subscriptions are nearly spent; these job types
would go to Hermes first.

Evidence: routing studies (RouteLLM; 2026 coding-agent routing guides) agree
that cheap models suit bounded, verifiable jobs and that planning and review
belong on the strong model. The main failure is misjudging difficulty, so every
Hermes job is checked by a test or diff rule and escalates on failure.

## Never to Hermes

These never go to Hermes, whatever the kind or budget:

- planning and review;
- auth, billing, payments and pricing code;
- secrets, `.env` files, keys, tokens or anything that reads them;
- Godot game work and demo-critical work;
- anything holding real user data or children's data (names, voices, images,
  worksheets, stories), including logs and test output that contain it.

`route` returns the subscription lane for these, and the job's own kind cannot
override this.

## Scratch-worktree rule (all Hermes jobs)

A Hermes job runs only in a scratch git worktree that:

- has no `.env*`, key or credential files (checked before the job starts; any
  match refuses the job);
- has no real user or children's data; fixtures are fake only;
- is listed in the `hermesRepos` allowlist (opt-in per repo);
- is run with the `dstest` Hermes profile (pinned hosts, no data collection).

Only the files named in the job's inputs are given to the model.

## Job types

| Kind | Trigger (request that matches) | Lane | Inputs allowed | Output |
|---|---|---|---|---|
| `test-run` | "run the tests", "full test run", any post-feature check | plain script, no model | the repo's test command | pass/fail and a failure summary (test name, error, up to 20 trace lines each) |
| `code` | feature and fix work | Hermes | the files the task names | a diff; tests must pass; Claude reviews it |
| `bulk` | large, repetitive edits | Hermes | the files the task names | a diff; tests must pass; Claude reviews it |
| `lint-format` | fix lint or formatting errors | Hermes | lint output; the files it names | a diff; lint must then pass |
| `test-write` | write unit tests for finished, reviewed code | Hermes | the target source files; existing tests nearby; fake fixtures | new or changed test files only |
| `test-triage` | a `test-run` failed: is the test or the code wrong? | Hermes | the failure summary; the failing test file; the code under test | a verdict (`test-bug` / `code-bug` / `unclear`) with one line of reason; for `test-bug`, a test-only diff |
| `doc-update` | update README, docs or comments after a change | Hermes | the diff of the change; the doc files | a docs-only diff |
| `rename-mechanical` | renames, moves, import fixes, other mechanical edits | Hermes | the rename map; the files it touches | a diff; type check and tests must pass |
| `file-scan` | find files, list usages, first-pass sweeps | Hermes | file paths and contents in the allowlisted repo | a list of findings (path, line, one-line note); no edits |

### `test-run` (no model)

`usage-guard test-run -- <test command>` runs the command, saves the full log
locally, and prints only the summary. A model reads the summary, never the full
log. This is the largest saving: most test-run usage today is a model watching
output.

### Escalation (all Hermes kinds)

One retry. If the result fails its check (lint, type check, tests, or the
reviewer rejects it) after the second attempt, the job moves to the subscription
lane `route` picks for `code`, with the Hermes attempt attached as context.
`test-triage` verdicts of `code-bug` or `unclear` always go to Claude or Codex;
Hermes never fixes product code found broken by a test.

`hermes-job --check "<test command>"` runs the check in the scratch worktree
after Hermes finishes, with the same stripped environment Hermes gets and the
repo's `node_modules` linked in for the check only. The job records its result:
`pass`, `fail`, `unchecked` (no check given) or `lane-error` (timeout, no
credit; not the model's fault). Only pass and fail count in success rates.

### Review rule

Every test diff Hermes produces (`test-write`, `test-triage` fixes,
`rename-mechanical` touching tests) gets a short Claude review before it lands,
to catch tests weakened to pass. The review rejects:

- deleted or commented-out assertions;
- loosened assertions (exact values turned into `toBeTruthy`, wider tolerances);
- new `skip`, `only`, `xfail` or `todo` markers;
- snapshot updates the change does not explain.

A simple diff check (count of assertions before and after) runs first and flags
any drop for the reviewer.

## How a job reaches Hermes

It is not automatic from the prompt text. The main agent (Claude or Codex)
decides the kind at a task boundary, then asks Usage Guard:

1. The agent splits the work and labels each piece with a kind, following the
   Usage Guard skill and the project's CLAUDE.md rule.
2. It runs `usage-guard route --kind <kind>` (or `balance.mjs --kind <kind>`).
3. Usage Guard checks the never-list, the worktree rule and the cap, then
   answers with the lane and the exact command.
4. The agent runs that command and checks the result.

A hook that guesses the kind from the prompt is left for later; a wrong guess
here is the failure mode the research warns about.

## Settings (proposed)

- `hermesJobKinds`: the kinds above that go to Hermes first (default: all of them).
- `hermesRepos`: repo paths allowed to send work to Hermes (default: none).
- `payAsYouGoDailyCapUsd`: existing, default `5`. Once spent, these kinds fall
  back to the subscription lanes.

## Not in scope yet

Built: the route kinds, `hermesJobKinds`, `hermesRepos`, the two-attempt
escalation, `usage-guard test-run` and `usage-guard hermes-job` (never-list
check on the task text, opt-in repo, scratch worktree of committed files,
secret-file scan). Not built: the assertion-count check and the automatic Claude
review; the agent does the review step by hand. The task-text check is a keyword
filter and cannot detect children's data inside the repo; the opt-in list is the
real guard. `hermes-job` refuses while Usage Guard is off.

The worktree is not a sandbox: Hermes's tools can read files under HOME.
