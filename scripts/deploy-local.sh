#!/usr/bin/env bash
# Install a fixed copy of this checkout for daily use, so switching branches in
# the repo does not change the live tool.
#   ~/.local/share/usage-guard/app         symlink to the live release (one fixed path,
#                                          so installed hooks and services keep working)
#   ~/.local/share/usage-guard/app.prev    symlink to the previous release, for rollback
#   ~/.local/share/usage-guard/releases/   the packed copies (live + previous kept)
#   ~/.local/bin/usage-guard -> app/bin/usage-guard.mjs
#   ~/.local/bin/usage-guard-tray (copied, if tray/target/release has a build)
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
root="${USAGE_GUARD_DEPLOY_ROOT:-$HOME/.local/share/usage-guard}"
bin="${USAGE_GUARD_BIN_DIR:-$HOME/.local/bin}"
version="$(node -p "require('$repo/package.json').version")-$(git -C "$repo" rev-parse --short HEAD)"
release="$root/releases/$version-$(date +%s)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$repo" && npm pack --silent --pack-destination "$work" >/dev/null)
mkdir -p "$release"
tar -xzf "$work"/*.tgz -C "$release" --strip-components=1
cp "$repo/package-lock.json" "$release/"
(cd "$release" && npm ci --omit=dev --ignore-scripts --silent)
chmod +x "$release/bin/usage-guard.mjs"
echo "$version" > "$release/DEPLOYED_VERSION"

# app is a symlink to a release dir; switching it with rename(2) is atomic.
# First run on an old layout: app is a real directory, so move it into releases/ once.
# The old app.prev was a real directory too: replace it with a link to the moved copy, so rollback still works.
if [[ -d "$root/app" && ! -L "$root/app" ]]; then
  legacy="$root/releases/legacy-$(date +%s)"
  mv "$root/app" "$legacy"
  [[ -d "$root/app.prev" && ! -L "$root/app.prev" ]] && rm -rf "$root/app.prev"
  ln -sfn "$legacy" "$root/app.prev"
fi
old="$(readlink "$root/app" 2>/dev/null || true)"
# rename(2) via node: macOS mv has no -T, and plain mv would move into the linked dir.
swap() { node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$1" "$2"; }
ln -sfn "$release" "$root/app.tmp"
swap "$root/app.tmp" "$root/app"
if [[ -n "$old" && "$old" != "$release" ]]; then
  ln -sfn "$old" "$root/app.prev.tmp"
  swap "$root/app.prev.tmp" "$root/app.prev"
fi
# Keep only the live and previous releases.
keep_a="$(readlink "$root/app")"; keep_b="$(readlink "$root/app.prev" 2>/dev/null || true)"
for d in "$root"/releases/*/; do
  d="${d%/}"
  [[ "$d" == "$keep_a" || "$d" == "$keep_b" ]] || rm -rf "$d"
done
mkdir -p "$bin"
ln -sfn "$root/app/bin/usage-guard.mjs" "$bin/usage-guard"
if [[ -x "$repo/tray/target/release/usage-guard-tray" ]]; then
  install -m 755 "$repo/tray/target/release/usage-guard-tray" "$bin/usage-guard-tray"
fi
# The server keeps old code in memory until restarted.
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet usage-guard-serve 2>/dev/null; then
  systemctl --user restart usage-guard-serve || echo "warning: could not restart usage-guard-serve" >&2
elif [[ "$(uname)" == Darwin ]] && launchctl print "gui/$(id -u)/sh.agentlayer.usage-guard.serve" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/sh.agentlayer.usage-guard.serve" || echo "warning: could not restart the serve service" >&2
fi
echo "Installed Usage Guard $version at $root/app (previous copy: $root/app.prev)"
