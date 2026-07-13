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

Prompt text may be inspected transiently by a deterministic task classifier so Usage Guard can distinguish quality-sensitive work from mechanical work. Prompt text is never written to the database, logs, decisions, or network.

## Data not accessed or stored

- source files, diffs, repository contents, or command output
- transcript bodies
- cookies or browser sessions
- Claude or OpenAI auth files and access tokens
- API keys
- personally identifying account information

## Storage

Normalized observations and decisions are stored in SQLite at `~/.usage-guard/usage-guard.sqlite3`. Installation backups and the rollback record are stored below `~/.usage-guard/` with user-only directory permissions where the operating system supports them.

Use `usage-guard reset` to delete quota observations and decisions. Use `usage-guard uninstall` to remove provider integrations and restore prior settings.

## Network behavior

Usage Guard has no Agent Layer telemetry or hosted API. The local dashboard binds to `127.0.0.1` only. Codex synchronization starts the locally installed Codex app-server, which uses the user's existing Codex session through official Codex behavior. Claude quota data arrives through Claude Code's local status-line process.

The package manager and provider marketplace commands may access their normal public registries during installation and updates.
