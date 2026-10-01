#!/bin/bash
# Install/remove the `pa run` LaunchAgent: osx/install.sh [--uninstall]. bash 3.2 (stock macOS).
# Runs osx/build/PA.app in place (rebuilds apply on restart: `launchctl kickstart -k gui/$UID/com.bitofant.pa`).
# Grant permissions first (prompts only show for an interactive launch): osx/pa calendars, osx/pa test-capture --seconds 5.
set -euo pipefail

label=com.bitofant.pa
here=$(cd "$(dirname "$0")" && pwd)
bin="$here/build/PA.app/Contents/MacOS/pa"
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/$label.log"
domain="gui/$(id -u)"

# bootout of a not-loaded agent fails → ignore.
launchctl bootout "$domain/$label" 2>/dev/null || true

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$plist"
  echo "Removed $label (recordings/queue in ~/Library/Application Support/$label kept)."
  exit 0
fi
[ -x "$bin" ] || { echo "No $bin — run osx/build.sh first." >&2; exit 1; }

mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
# KeepAlive: crash/kill → restart (throttled by launchd to 10s). SIGTERM (logout, bootout) = clean stop.
# AssociatedBundleIdentifiers: Login Items + TCC show it as PA, not a bare binary.
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$bin</string><string>run</string></array>
  <key>AssociatedBundleIdentifiers</key><string>$label</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
plutil -lint "$plist" >/dev/null
launchctl bootstrap "$domain" "$plist"
echo "Installed $label → $plist"
echo "Log: tail -f $log"
echo "Stop: osx/install.sh --uninstall   Restart after a rebuild: launchctl kickstart -k $domain/$label"
