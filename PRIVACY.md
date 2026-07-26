# Privacy

Usage Guard is designed to make a useful promise that can be verified from the source: quota governance stays on the user's machine.

## Data processed

Usage Guard processes the following provider-supplied fields:

- provider and opaque quota-bucket identifier
- quota percentage used
- window duration and reset timestamp
- observation timestamp and signal source
- model and reasoning/effort label, when supplied
- aggregate context-window percentage, when supplied
- an opaque local session identifier used to keep parallel context windows
  separate

On macOS, Claude Desktop's local Code surface does not currently invoke its
configured custom status-line command. Usage Guard may read Claude Desktop's
user-only aggregate plan history at
`~/Library/Application Support/Claude/plan-usage-history.json`. From that cache
it accepts only:

- the aggregate sample timestamp
- `fh`, observed as the five-hour usage percentage
- `sd`, observed as the weekly all-model usage percentage

Usage Guard uses the latest valid sample. It does not persist the cache's
organization identifier, ignores unknown fields such as `xu`, and treats an
absent or changed schema as a missing signal.

If the separately installed pxpipe proxy has a local
`~/.pxpipe/events.jsonl` ledger, Usage Guard may read recent successful
`/v1/messages` event metadata to show:

- model label
- baseline context-token count
- image count
- input and output token counts
- five-minute, one-hour, or unclassified cache-creation token counts
- cache-read token count

Usage Guard returns only these allowlisted numeric diagnostics, does not persist
the ledger rows, and treats missing or old rows as unavailable. It does not
install or configure pxpipe and does not send this metadata to Agent Layer.

Prompt text may be inspected transiently by a deterministic task classifier so Usage Guard can distinguish quality-sensitive work from mechanical work. Prompt text is never written to the database, logs, decisions, or network.

When Screenshot Memory is enabled, its localhost gateway transiently parses
outbound Claude request JSON in memory. A screenshot remains byte-for-byte in
the request for five later user turns. After that point, the gateway replaces
the base64 image block in future outbound requests with bounded text derived
from the original user's text and the first immediately following assistant
response. It does not use a model to produce this memory.

The original conversation and attachment are not edited. Prompt text,
assistant text, image bytes, authorization headers, and transformed request
bodies are not written to disk or logs. The only persistent Screenshot Memory
data is numeric operational status:

- number of eligible requests observed
- number of images replaced
- approximate image bytes removed
- update timestamp, configured retention turns, and upstream URL

## Data not accessed or stored

- source files, diffs, repository contents, or command output
- transcript bodies (Usage Guard does not parse Claude session JSONL)
- screenshot or image payloads
- cookies or browser sessions
- Claude or OpenAI auth files and access tokens
- API keys
- personally identifying account information
- Claude Desktop organization identifiers
- unknown fields from Claude Desktop's aggregate plan history

## Storage

Normalized quota observations, per-session aggregate context observations, and
decisions are stored in SQLite at `~/.usage-guard/usage-guard.sqlite3`.
Installation backups, absolute local runtime paths, and the rollback record are
stored below `~/.usage-guard/` with user-only directory permissions where the
operating system supports them.

Screenshot Memory stores its numeric status at
`~/.usage-guard/screenshot-memory-status.json` with user-only permissions.

Use `usage-guard reset` to delete quota observations, decisions, and local alert
or notice state. Use `usage-guard uninstall` to remove provider integrations, unload the
macOS background monitor, and restore prior settings.

## Network behavior

Usage Guard has no Agent Layer telemetry or hosted API. The local dashboard
binds to `127.0.0.1` only. Screenshot Memory also binds only to localhost,
accepts Claude requests at `127.0.0.1:47822`, and forwards them to the Claude
upstream that was configured before installation. This can be Anthropic
directly or another local proxy such as pxpipe. Authorization headers pass
through in memory and are not persisted.

Codex synchronization starts the locally installed Codex app-server, which uses
the user's existing Codex session through official Codex behavior. Claude quota
data arrives through Claude Code's local status-line process or, for the macOS
Desktop local Code surface, from the local aggregate plan history described
above.

Optional pxpipe request diagnostics are read from its existing local ledger.
No request is made to pxpipe or Agent Layer to obtain them.

The package manager and provider marketplace commands may access their normal public registries during installation and updates.
