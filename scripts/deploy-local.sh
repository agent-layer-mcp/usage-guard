#!/usr/bin/env bash
# Install a fixed copy of this checkout for daily use, so switching branches in
# the repo does not change the live tool.
#   ~/.local/share/usage-guard/app/        the packed CLI (one fixed path, so
#                                          installed hooks and services keep working)
#   ~/.local/share/usage-guard/app.prev/   the previous copy, for rollback
#   ~/.local/bin/usage-guard -> app/bin/usage-guard.mjs
#   ~/.local/bin/usage-guard-tray (copied, if tray/target/release has a build)
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
root="${USAGE_GUARD_DEPLOY_ROOT:-$HOME/.local/share/usage-guard}"
bin="${USAGE_GUARD_BIN_DIR:-$HOME/.local/bin}"
version="$(node -p "require('$repo/package.json').version")-$(git -C "$repo" rev-parse --short HEAD)"
release="$root/app.new"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$repo" && npm pack --silent --pack-destination "$work" >/dev/null)
rm -rf "$release" && mkdir -p "$release"
tar -xzf "$work"/*.tgz -C "$release" --strip-components=1
cp "$repo/package-lock.json" "$release/"
(cd "$release" && npm ci --omit=dev --ignore-scripts --silent)
chmod +x "$release/bin/usage-guard.mjs"
echo "$version" > "$release/DEPLOYED_VERSION"
rm -rf "$root/app.prev"
[[ -d "$root/app" ]] && mv "$root/app" "$root/app.prev"
mv "$release" "$root/app"
mkdir -p "$bin"
ln -sfn "$root/app/bin/usage-guard.mjs" "$bin/usage-guard"
if [[ -x "$repo/tray/target/release/usage-guard-tray" ]]; then
  install -m 755 "$repo/tray/target/release/usage-guard-tray" "$bin/usage-guard-tray"
fi
echo "Installed Usage Guard $version at $root/app (previous copy: $root/app.prev)"
