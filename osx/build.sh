#!/usr/bin/env bash
# Build signed, headless osx/build/PA.app. Usage: osx/build.sh [signing identity]
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
BIN="$(swift build -c release --arch arm64 --show-bin-path)/pa"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
cp "$BIN" "$APP/Contents/MacOS/pa"
codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" "$APP"
codesign --verify --strict "$APP"

echo "Built $APP ($(codesign -dv "$APP" 2>&1 | grep -E '^Authority=' | head -1))"
echo "Run via LaunchServices so TCC attributes to PA.app, not Terminal:"
echo "  open -W --stdout \$(tty) --stderr \$(tty) $PWD/$APP --args test-capture"
