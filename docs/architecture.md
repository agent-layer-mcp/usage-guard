# Architecture

Usage Guard is one local Node.js process with four entry surfaces:

1. The CLI renders status, configuration, installation, and the localhost dashboard.
2. Claude's status-line command ingests documented quota windows and renders a compact line.
3. Claude and Codex lifecycle hooks ask the policy engine for a decision before each prompt.
4. The MCP server exposes status and decisions to provider desktop sessions.

## Data flow

```text
Claude status-line JSON -----> provider normalizer --+
                                                   |
Codex app-server response ---> provider normalizer --+--> local SQLite
                                                          |
transient task class -------------------------------------+--> policy engine
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
- provide a reset-aware explanation

Usage Guard does not mutate the host's active main-thread model or reasoning setting. Plugin APIs do not currently provide one portable, documented way to make that change across both products, and silent mutation would violate the quality contract.

## Forecasting

The policy engine compares observed quota burn with the burn that can be sustained until reset after preserving the configured reserve:

```text
usable = max(0, 100 - used - reserve)
sustainable burn = usable / minutes until reset
pace ratio = observed burn / sustainable burn
```

The most pressured live bucket controls the provider decision. Missing or stale data produces a refresh request, never a protected pause.
