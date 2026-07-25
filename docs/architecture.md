# Architecture

Usage Guard is one local Node.js process with four entry surfaces:

1. The CLI renders status, configuration, installation, and the localhost dashboard.
2. Claude's status-line command ingests provider-exposed quota windows and
   per-session aggregate context pressure, then renders a compact line.
3. Claude and Codex lifecycle hooks ask the policy engine for a decision before each prompt.
4. The MCP server exposes status and decisions to provider desktop sessions.

## Data flow

```text
Claude status-line JSON -----> quota + context normalizer --+
                                                             |
Codex app-server response ---> quota normalizer --------------+--> local SQLite
                                                                  |
transient task class ---------------------------------------------+--> policy engine
                                                               |
                 +---------------------------------------------+------------------+
                 |                                             |                  |
             CLI status                                lifecycle notice      MCP tools
             dashboard                                 or protected pause    for desktop
```

The task classifier returns only `high-reasoning`, `standard`, `mechanical`, or `unknown`. The input text is discarded after the decision and never reaches SQLite.

## Control boundary

Usage Guard can:

- preserve a reserve by blocking a new prompt
- inject pacing guidance into a turn
- configure Claude and Codex status-line surfaces
- suggest bounded context and concurrency
- advise a safe handoff/compaction boundary for a pressured Claude session
- provide a reset-aware explanation

Usage Guard does not mutate the host's active main-thread model or reasoning setting. Plugin APIs do not currently provide one portable, documented way to make that change across both products, and silent mutation would violate the quality contract.

Claude context observations are keyed by local session ID so parallel desktop
sessions do not contaminate each other. Context pressure can elevate guidance
to `watch` or `protect`, but never to `queue`. Codex exposes its native context
meter to the host UI but not through the stable Usage Guard hook payload, so
Usage Guard relies on Codex auto-compaction and does not read transcript
contents to estimate it.

## Forecasting

The policy engine compares observed quota burn with the burn that can be sustained until reset after preserving the configured reserve:

```text
usable = max(0, 100 - used - reserve)
sustainable burn = usable / minutes until reset
pace ratio = observed burn / sustainable burn
```

The most pressured live quota bucket controls reserve enforcement. Fresh
per-session context pressure can elevate guidance, but only a fresh quota bucket
at reserve can block a new prompt. Missing or stale data produces a refresh
request, never a protected pause.
