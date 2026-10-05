#!/usr/bin/env bash
# Build signed osx/build/PA.app (headless daemon) + osx/build/PAMenu.app (menu bar). Usage: osx/build.sh [signing identity]
set -euo pipefail
cd "$(dirname "$0")"

IDENTITY="${1:-PA Local Signing}"
BUNDLE_ID="com.bitofant.pa"
APP="build/PA.app"

# No -v: an untrusted self-signed cert is "invalid" to find-identity but signs fine.
if ! security find-identity -p codesigning | grep -qF "\"$IDENTITY\""; then
  cat >&2 <<EOF
No code-signing identity "$IDENTITY" in your keychain.
Create one (once): Keychain Access → Certificate Assistant → Create a Certificate…
  Name: $IDENTITY, Identity Type: Self Signed Root, Certificate Type: Code Signing.
A stable identity keeps TCC grants across rebuilds (ad-hoc signing re-prompts every build).
EOF
  exit 1
fi

swift build -c release --arch arm64
BINDIR="$(swift build -c release --arch arm64 --show-bin-path)"

# bundle <app> <plist> <executable> <bundle id>
bundle() {
  rm -rf "$1"
  mkdir -p "$1/Contents/MacOS"
  cp "$2" "$1/Contents/Info.plist"
  cp "$BINDIR/$3" "$1/Contents/MacOS/$3"
  codesign --force --sign "$IDENTITY" --identifier "$4" "$1"
  codesign --verify --strict "$1"
  echo "Built $1 ($(codesign -dv "$1" 2>&1 | grep -E '^Authority=' | head -1))"
}
bundle "$APP" Info.plist pa "$BUNDLE_ID"
# Own bundle id: LSUIElement (status item) only here; PA.app stays LSBackgroundOnly + keeps its TCC grants.
bundle build/PAMenu.app MenuInfo.plist pa-menu "$BUNDLE_ID.menu"

echo "Run via LaunchServices so TCC attributes to PA.app, not Terminal:"
echo "  open -W --stdout \$(tty) --stderr \$(tty) $PWD/$APP --args test-capture"
