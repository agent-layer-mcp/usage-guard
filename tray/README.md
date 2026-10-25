# Usage Guard tray

A Tauri 2 tray app over the local Usage Guard API (`usage-guard serve`, port 4765,
or `USAGE_GUARD_PORT`).

- Tray label: each lane's use of today's share (`C 26% · X 0% · D $1.20`).
- Panel: per-lane today vs budget, week bar with the reserve, reset countdown,
  the current routing choice and reason, recent decisions, a pause toggle, and a
  Codex banked-reset button that only opens Codex's usage page after you confirm.
  Usage Guard never spends a banked reset.
- On/Off switch at the top of the panel and in the menu; it runs
  `usage-guard enable|disable`.
- Linux tray icons only show a menu, so open the panel with **Show details**. On
  Windows and macOS a left click toggles it.

The webview never talks to the API directly: a few whitelisted Rust commands
(status, route preview, pause) do, so the API stays closed to other origins.

## Build

Needs Rust, plus WebKitGTK 4.1, libsoup 3 and libayatana-appindicator on Linux
(WebView2 on Windows).

```bash
cd tray && cargo build --release
./target/release/usage-guard-tray
```

`cargo tauri build` (with the Tauri CLI) produces installers for the current
platform.

On a Mac, the `Mac tray` GitHub workflow builds one universal `.dmg` (Apple
Silicon and Intel) and attaches it to each published release as
`usage-guard-tray-macos.dmg`. To build it yourself on a Mac:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm install --global @tauri-apps/cli@2
cd tray && tauri build --target universal-apple-darwin --bundles dmg
```

The app is unsigned: right-click → **Open** on first launch.
