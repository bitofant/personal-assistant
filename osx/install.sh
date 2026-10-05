#!/bin/bash
# Install/remove the LaunchAgents: `pa run` (com.bitofant.pa) + menu bar app (com.bitofant.pa.menu).
# osx/install.sh [--uninstall]. bash 3.2 (stock macOS).
# Runs osx/build/{PA,PAMenu}.app in place (rebuilds apply on restart: `launchctl kickstart -k gui/$UID/<label>`).
# Grant permissions first (prompts only show for an interactive launch): osx/pa calendars, osx/pa test-capture --seconds 5.
set -euo pipefail

label=com.bitofant.pa
menu_label=$label.menu
here=$(cd "$(dirname "$0")" && pwd)
bin="$here/build/PA.app/Contents/MacOS/pa"
menu_bin="$here/build/PAMenu.app/Contents/MacOS/pa-menu"
domain="gui/$(id -u)"

plist_of() { echo "$HOME/Library/LaunchAgents/$1.plist"; }

# bootout of a not-loaded agent fails → ignore.
for l in "$label" "$menu_label"; do launchctl bootout "$domain/$l" 2>/dev/null || true; done

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$(plist_of "$label")" "$(plist_of "$menu_label")"
  echo "Removed $label + $menu_label (recordings/queue in ~/Library/Application Support/$label kept)."
  exit 0
fi
[ -x "$bin" ] || { echo "No $bin — run osx/build.sh first." >&2; exit 1; }

# install_agent <label> <program args as <string>…> <KeepAlive value XML>
install_agent() {
  local plist log
  plist=$(plist_of "$1")
  log="$HOME/Library/Logs/$1.log"
  mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
  # AssociatedBundleIdentifiers: Login Items + TCC show it as PA, not a bare binary.
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key>
  <array>$2</array>
  <key>AssociatedBundleIdentifiers</key><string>$1</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>$3
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
  plutil -lint "$plist" >/dev/null
  launchctl bootstrap "$domain" "$plist"
  echo "Installed $1 → $plist (log: $log)"
}

# Daemon — KeepAlive: crash/kill → restart (throttled by launchd to 10s). SIGTERM (logout, bootout) = clean stop.
install_agent "$label" "<string>$bin</string><string>run</string>" "<true/>"
# Menu — crash → restart, but "Quit PA menu" (exit 0) stays quit until next login.
if [ -x "$menu_bin" ]; then
  install_agent "$menu_label" "<string>$menu_bin</string>" "<dict><key>SuccessfulExit</key><false/></dict>"
else
  echo "No $menu_bin → menu bar app not installed (rebuild with osx/build.sh)."
fi
echo "Log: tail -f $HOME/Library/Logs/$label.log"
echo "Stop: osx/install.sh --uninstall   Restart after a rebuild: launchctl kickstart -k $domain/$label (and $menu_label)"
