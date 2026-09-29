---
name: usage-guard
description: Use for Claude Code or Codex quota, five-hour or weekly limits, model stepping, role-aware delegation, pacing, or why Usage Guard paused work.
---

# Usage Guard

Use the `usage_guard_status` MCP tool before answering quota questions or planning a long, expensive task.

## Model stepping and quality contract

- Read the effective config. Model stepping is on by default and is already authorized; do not ask for confirmation on every step.
- When `qualityLock` is true, never lower the active model or reasoning effort. This overrides stepping.
- When stepping is active, use the main `recommendedModel`/`recommendedEffort` for new main-thread work and `routineModel`/`routineEffort` for routine subagents. These are recommendations, not proof of a completed switch.
- Planning, architecture, finished-work reviews, money, security, children's data, and production must never go below rung 2. Before delegating protected work, call `usage_guard_decision` with its role or a transient task description; do not use the routine floor for that work.
- Searches, test runs, file reading, mechanical edits, and summaries step down first. Never use max or xhigh on a stepped-down rung.
- Finish the current edit and its checks, then switch between tasks. In Claude Desktop, use `mcp__ccd_session_mgmt__set_session_model` and `mcp__ccd_session_mgmt__set_session_effort` only when exposed, with their declared schemas. Otherwise use a supported session control or a new subagent with explicit model and effort. Verify success before claiming a switch.
- Use exact model IDs from the recommendation. If the host cannot select that model/effort, report the limitation and queue that work; do not guess or substitute. Claude Code needs 2.1.284+ for the default 5.5 ladder. `default` effort means omit effort and clear inherited overrides, particularly for Haiku 4.5.
- Reduce duplicate context, speculative work, and excess concurrency before changing task timing.
- At high context, finish the coherent step, update a durable handoff, and compact or start fresh before another large phase.
- When a protected reserve is reached, pause new prompts, tools, and subagents. Save only quota/model metadata in a local handover, never prompts or code; cheaper models cannot bypass the pause.
- Keep tests, verification, and diff review intact.
- Explain every intervention in plain language: what changed, why, and the controlling reset.

## Decision behavior

- `safe`: work normally and avoid obvious duplicate context.
- `watch`: reuse evidence, compact only at a safe boundary, and bound parallel work.
- `protect`: use one active implementation path and retain strong-model planning and review.
- `queue`: stop new work; the hook saves a quota-only handover before blocking. Independent local checks outside the paused run are unaffected.
- `missing` or `stale`: refresh the provider meter before making a quota claim.

Do not claim that Usage Guard can create unlimited included quota. Continuity beyond the provider allowance requires waiting for reset or an explicitly enabled paid overflow path.

Do not claim every provider snapshot includes both a short and weekly window.
Use only the windows the provider actually exposes. Context pressure alone may
change guidance but must never hard-block a prompt.

Inspect `recentDecisions` for model-step recommendations, timestamps, and quota
triggers; `overnightSummary` covers the last 12 hours by default. Do not say a
model was changed merely because a recommendation was recorded. Do not store
task descriptions or source code in this history.
