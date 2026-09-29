# Model stepping defaults and example

These defaults are exported by `src/config.mjs` in Usage Guard 0.5.0. All fields
can be changed through `usage_guard_configure`. Thresholds use quota remaining
after the reserves, in percentage points of the whole allowance.

## Default configuration

```json
{
  "enforcement": "protect",
  "modelStepping": true,
  "qualityLock": false,
  "modelLadders": {
    "claude": [
      {
        "model": "claude-opus-5-5",
        "effort": "high"
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high"
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "medium"
      },
      {
        "model": "claude-haiku-4-5-20251001",
        "effort": "default"
      }
    ],
    "codex": [
      {
        "model": "gpt-6-astra",
        "effort": "high"
      },
      {
        "model": "gpt-6-sol",
        "effort": "high"
      },
      {
        "model": "gpt-6-sol",
        "effort": "medium"
      },
      {
        "model": "gpt-6-luna",
        "effort": "high"
      }
    ]
  },
  "fiveHourStepDownThresholds": [
    40,
    25,
    12
  ],
  "weeklyStepDownThresholds": [
    30,
    10
  ],
  "stepUpMarginPercent": 10,
  "rapidBurnStepDown": true,
  "quietHours": null,
  "routineStepDownRungs": 1,
  "protectedMaxRung": 2,
  "overnightSummaryHours": 12,
  "fiveHourReservePercent": 8,
  "weeklyReservePercent": 5,
  "rapidBurnWatchMinutes": 90,
  "rapidBurnProtectMinutes": 30,
  "contextWatchPercent": 70,
  "contextProtectPercent": 85,
  "compactionHandoffEnabled": true,
  "staleAfterMinutes": 15,
  "dashboardPort": 4765
}
```

## Example status

This is a simulated review task, not live account usage. The five-hour meter
has 28% remaining (20% usable); weekly has 13% remaining (8% usable). Weekly
pressure puts routine work on the floor, while the review stays on Sonnet 5.5
with high effort. Time and reset text are illustrative. The status excerpt
omits unrelated context and request diagnostics but retains the complete
switching instructions and model-step record.

```json
{
  "generatedAt": 1790683200000,
  "providers": [
    {
      "provider": "claude",
      "state": "protect",
      "blocked": false,
      "taskRole": "review",
      "modelStepping": true,
      "recommendedModel": "claude-sonnet-5-5",
      "recommendedEffort": "high",
      "routineModel": "claude-haiku-4-5-20251001",
      "routineEffort": "default",
      "recommendedRung": 2,
      "routineRung": 4,
      "quotaRung": 4,
      "modelReason": "5-hour usable 20.0%, weekly usable 8.0%; main rung 2, routine rung 4; review stays at rung 2.",
      "instructions": "Model stepping is on: follow the role-specific recommendation for new tasks. Use one active agent, avoid speculative branches, and keep the strongest appropriate reasoning for planning and final review. The controlling window resets in 1d 2h. Model stepping is on and already authorized: use claude-sonnet-5-5 with high effort for new review work. Use claude-haiku-4-5-20251001 with default effort for routine subagents only. Planning, architecture, finished-work reviews, and money, security, children's data or production work must use the protected main-thread recommendation (never below rung 2). Recheck usage_guard_decision with that role before delegation. Finish the current edit and its checks before switching; switch only between tasks. In Claude Desktop, when available, use mcp__ccd_session_mgmt__set_session_model and mcp__ccd_session_mgmt__set_session_effort with their declared schemas for this session. Claude Code needs version 2.1.284 or newer for this default ladder. Report an applied switch only after the host confirms success. Otherwise launch new work as a subagent with the exact recommended model and effort using the host's supported model/effort parameters. If a host only accepts aliases, resolve them against its verified model mapping first. For default effort, omit the effort parameter and clear any inherited effort override. Never use max or xhigh on a stepped-down rung. If the exact model or effort cannot be selected, keep work queued and report the limitation; do not guess an ID, substitute another model, or ask for stepping authorization again. Usage Guard recommends these changes; it does not itself switch a running host session."
    }
  ],
  "recentDecisions": [
    {
      "provider": "claude",
      "type": "model-step",
      "direction": "down",
      "action": "model-step-down",
      "state": "protect",
      "createdAt": 1790683200000,
      "reason": "5-hour usable 20.0%, weekly usable 8.0%; protected main rung 2, routine rung 4.",
      "taskClass": "high-reasoning",
      "taskRole": "planning",
      "fromRung": 1,
      "rung": 4,
      "recommendedRung": 2,
      "routineRung": 4,
      "recommendedModel": "claude-sonnet-5-5",
      "recommendedEffort": "high",
      "routineModel": "claude-haiku-4-5-20251001",
      "routineEffort": "default",
      "applied": false,
      "rapidBurn": false,
      "quietHours": false,
      "resetAt": 1790769600000,
      "quota": [
        {
          "key": "five-hour",
          "windowMinutes": 300,
          "usedPercent": 72,
          "remainingPercent": 28,
          "usablePercent": 20,
          "reservePercent": 8,
          "resetsAt": 1790686800000,
          "observedAt": 1790683200000,
          "paceRatio": null,
          "minutesUntilReserve": null
        },
        {
          "key": "weekly",
          "windowMinutes": 10080,
          "usedPercent": 87,
          "remainingPercent": 13,
          "usablePercent": 8,
          "reservePercent": 5,
          "resetsAt": 1790769600000,
          "observedAt": 1790683200000,
          "paceRatio": null,
          "minutesUntilReserve": null
        }
      ]
    }
  ],
  "overnightSummary": "Last 12 hours: 1 model recommendation(s) down, 0 up. Changes take effect when the host agent applies them between tasks.",
  "privacy": {
    "promptStored": false,
    "sourceCodeStored": false,
    "credentialsStored": false,
    "telemetryEnabled": false,
    "compactionSummaryStoredLocally": true
  }
}
```

`default` effort means omit the effort parameter and clear inherited overrides.
The governor records recommendations with `applied: false`; the host must
confirm any actual session-model change. Use `role: "review"`, `"planning"`,
`"architecture"`, `"sensitive"`, `"standard"`, or `"routine"` for task-specific
recommendations. Role classification inspects descriptions in memory only.

## Quiet hours example

Send this patch to `usage_guard_configure`:

```json
{
  "quietHours": {
    "start": "22:00",
    "end": "07:00",
    "timeZone": "Australia/Brisbane",
    "extraRungs": 1
  }
}
```

Omit `timeZone` or set it to null to use the machine's local time. Quiet hours
are off by default. Restore the old fixed-quality behavior with
`{"qualityLock": true}`. To re-enable stepping, send
`{"qualityLock": false, "modelStepping": true}`.

## Verified model and host references

- [Claude Code model IDs and compatibility](https://code.claude.com/docs/en/model-config)
- [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
- [Claude Haiku 4.5, including its unsupported effort parameter](https://platform.claude.com/docs/en/models/haiku-4-5/overview)
- [Claude subagent model and effort selection](https://code.claude.com/docs/en/sub-agents)
- [Codex models](https://learn.chatgpt.com/docs/models)
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

The installed Codex app-server's read-only `model/list` also confirmed
`gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna` and their high/medium settings.
Claude Desktop's installed session-management tool declarations were checked
for `mcp__ccd_session_mgmt__set_session_model` and
`mcp__ccd_session_mgmt__set_session_effort`. Availability remains host-specific;
use the exposed schema, and do not call an unavailable tool or claim a switch
that has not succeeded. Claude Code needs 2.1.284+ for the default 5.5 ladder.
