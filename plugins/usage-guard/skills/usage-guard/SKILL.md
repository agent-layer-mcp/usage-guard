---
name: usage-guard
description: Use when the user asks about Claude Code or Codex usage, quota, five-hour or weekly limits, pacing, uninterrupted sessions, or why Usage Guard changed the timing or concurrency of work.
---

# Usage Guard

Use the `usage_guard_status` MCP tool before answering quota questions or planning a long, expensive task.

## Quality contract

- Never silently lower the active model or reasoning effort.
- Preserve strong reasoning for architecture, difficult debugging, security, migrations, and final review.
- Reduce duplicate context, speculative work, and excess concurrency before changing task timing.
- At high context, finish the coherent step, update a durable handoff, and compact or start fresh before another large phase.
- When the protected reserve is reached, queue quota-heavy work until reset instead of weakening it.
- Keep tests, verification, and diff review intact.
- Explain every intervention in plain language: what changed, why, and the controlling reset.

## Decision behavior

- `safe`: work normally and avoid obvious duplicate context.
- `watch`: reuse evidence, compact only at a safe boundary, and bound parallel work.
- `protect`: use one active implementation path and retain strong-model planning and review.
- `queue`: do not start quota-heavy work; preserve the request for the reset. Deterministic local checks may continue.
- `missing` or `stale`: refresh the provider meter before making a quota claim.

Do not claim that Usage Guard can create unlimited included quota. Continuity beyond the provider allowance requires waiting for reset or an explicitly enabled paid overflow path.

Do not claim every provider snapshot includes both a short and weekly window.
Use only the windows the provider actually exposes. Context pressure alone may
change guidance but must never hard-block a prompt.
