# Architecture

Usage Guard is a local Node.js tool with these entry surfaces:

1. The CLI renders status, configuration, installation, and the localhost dashboard.
2. Claude's status-line command ingests provider-exposed quota windows and
   per-session aggregate context pressure, then renders a compact line.
3. On macOS, Claude Desktop hooks defensively ingest its local aggregate plan
   history because the Desktop Code surface does not run the custom status-line
   command.
4. Claude and Codex lifecycle hooks ask the policy engine for a decision before
   each prompt; Claude also rechecks before tool calls and after tool batches.
5. A macOS LaunchAgent checks Claude's aggregate cache once per minute and shows
   a local notification when policy escalates.
6. The MCP server exposes status and decisions to provider desktop sessions.
7. A `/bin/sh` bootstrap reads the installer-recorded Node path before either
   plugin router starts, avoiding dependence on the desktop process `PATH`.
8. A localhost Screenshot Memory gateway keeps recent Claude screenshots
   visually live, then replaces old base64 image blocks on future requests with
   bounded contextual text.
9. Claude's native proactive compaction runs at 40% by default. `PostCompact`
   saves the provider-generated summary in a private project-keyed handoff, and
   a different `SessionStart` receives it as continuity context.
10. Model stepping derives protected-main and routine-subagent recommendations
    from usable quota, rapid burn, and optional quiet hours. SQLite keeps
    per-window recovery latches and a separate recommendation history.

## Data flow

```text
Claude status-line JSON ----------> quota + context normalizer --+
                                                                  |
Claude Desktop aggregate cache --> quota allowlist + normalizer ---+--> local SQLite
                                                                  |
Codex app-server response --------> quota normalizer --------------+
                                                                  |
transient task class ---------------------------------------------+--> policy engine
                                                               |
                 +---------------------------------------------+------------------+
                 |                                             |                  |
             CLI status                                lifecycle notice      MCP tools
             dashboard                                 or protected pause    for desktop
```

The task classifier returns only `high-reasoning`, `standard`, `mechanical`, or `unknown`. The input text is discarded after the decision and never reaches SQLite.

The stepping classifier separately returns a bounded role label: planning,
architecture, review, sensitive, routine, or standard. The role, but never the
description, may be retained for later hooks in the same session. Protected
roles never fall below rung 2; only routine work can reach the floor.

Claude's request path is independent of the quota policy path:

```text
Claude local session
        |
        v
Screenshot Memory (127.0.0.1:47822)
  - keeps last five user turns of images
  - replaces older image blocks in memory
  - persists numeric counters only
        |
        v
previous ANTHROPIC_BASE_URL
  - pxpipe on 127.0.0.1:47821 in the common diagnostic setup
  - or Anthropic directly
```

The transform is stateless with respect to conversation text: every request
already contains the relevant message history. It counts later user turns,
preserves pinned screenshots, and builds memory from text already present in
that request. It never edits the provider's saved conversation.

## Control boundary

Usage Guard can:

- preserve a reserve by blocking a new prompt
- stop a Claude agentic run at a tool boundary after the reserve is reached
- stop a Claude loop after a completed tool batch before the next model request
- retain the legacy `PROTECT` permission decision when quality lock is on
- show local macOS notifications while Claude Desktop is working
- inject pacing guidance into a turn
- configure Claude and Codex status-line surfaces
- suggest bounded context and concurrency
- advise a safe handoff/compaction boundary for a pressured Claude session
- configure Claude's supported proactive compaction threshold and carry its
  compact summary into a fresh local session
- provide a reset-aware explanation

Usage Guard recommends model changes; the host agent applies them only between
tasks through its exposed session control or an explicitly configured subagent.
Claude Desktop's session-management model/effort tools are used only when
available. The governor never claims an unconfirmed switch. Quality lock
overrides stepping and restores the legacy provider/hook behavior.

An authoritative Codex refresh records the active set of quota buckets as well
as observations. Retired Spark-era buckets remain in history but leave the live
view. `config/read` supplies the configured model/effort when a hook did not
supply session-specific metadata; bucket labels are not model choices.

Reserve hooks save an allowlisted quota-only handover before stopping. This
contains no prompts, code, tool arguments, or conversation summaries and is
separate from the optional compaction-summary handoff.

Claude context observations are keyed by local session ID so parallel desktop
sessions do not contaminate each other. Context pressure can elevate guidance
to `watch` or `protect`, but never to `queue`. Claude Desktop and Codex expose
native context meters to their host UIs but not through every stable Usage Guard
hook path. Usage Guard relies on host auto-compaction in those surfaces and
does not read transcript contents to estimate context.

Compaction handoffs do not inspect transcripts either. Claude supplies
`compact_summary` directly to `PostCompact`; Usage Guard writes that bounded
summary below its private state directory. Git's common directory is used as
the project identity so separate Desktop worktrees can share the same handoff
without writing an untracked file into the repository.

The Claude Desktop cache adapter does not need a reset timestamp to enforce the
reserve or detect rapid burn. It never infers a reset from aggregate percentage
changes. Without authoritative reset evidence, it projects minutes until the
reserve directly from recent burn and escalates at configurable 90-minute watch
and 30-minute protect thresholds.

## Forecasting

The policy engine compares observed quota burn with the burn that can be sustained until reset after preserving the configured reserve:

```text
usable = max(0, 100 - used - reserve)
sustainable burn = usable / minutes until reset
pace ratio = observed burn / sustainable burn
```

When reset is unknown:

```text
minutes until reserve = usable / observed burn
```

The most pressured live quota bucket controls reserve enforcement. Fresh
per-session context pressure can elevate guidance, but only a fresh quota bucket
at reserve can block a new prompt. Missing or stale data produces a refresh
request, never a protected pause.
