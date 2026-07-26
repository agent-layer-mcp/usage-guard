#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DESTINATION="${1:-"$ROOT/.build/Usage Guard.app"}"
CONTENTS="$DESTINATION/Contents"
MACOS="$CONTENTS/MacOS"

rm -rf "$DESTINATION"
mkdir -p "$MACOS"
cp "$ROOT/native/Info.plist" "$CONTENTS/Info.plist"

xcrun swiftc \
  -O \
  -target "$(uname -m)-apple-macosx13.0" \
  "$ROOT/native/UsageGuardNotifier.swift" \
  -o "$MACOS/UsageGuardNotifier"

codesign --force --sign - --timestamp=none "$DESTINATION"
codesign --verify --deep --strict "$DESTINATION"

printf '%s\n' "$DESTINATION"
