#!/usr/bin/env bash
#
# Install personal-assistant as a systemd *user* service.
#
# User service: node lives in per-user paths; lingering keeps it up after logout.
#
# Usage: ./install-service.sh
#
set -euo pipefail

SERVICE_NAME="personal-assistant"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/${SERVICE_NAME}.service"
BACKUP_UNIT="$UNIT_DIR/${SERVICE_NAME}-backup.service"
BACKUP_TIMER="$UNIT_DIR/${SERVICE_NAME}-backup.timer"

# --- Sanity checks ---------------------------------------------------------
NPM_BIN="$(command -v npm || true)"
if [[ -z "$NPM_BIN" ]]; then
  echo "error: npm not found on PATH" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/config.json" ]]; then
  echo "error: $APP_DIR/config.json missing — run ./config-gen.sh first" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/dist/web" ]]; then
  echo "note: dist/web not found — building production frontend..."
  ( cd "$APP_DIR" && npm run build )
fi

# PATH incl. wherever node/npm live for this user.
SERVICE_PATH="$(dirname "$NPM_BIN")"
for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" /usr/local/bin /usr/bin /bin; do
  case ":$SERVICE_PATH:" in
    *":$d:"*) ;;                       # already present
    *) [[ -d "$d" ]] && SERVICE_PATH="$SERVICE_PATH:$d" ;;
  esac
done

# --- Write the unit --------------------------------------------------------
mkdir -p "$UNIT_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=personal-assistant — meeting transcripts server
After=network-online.target
Wants=network-online.target
# Never stop retrying: default start limit leaves the service dead after a transient crash-loop.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PATH=$SERVICE_PATH
ExecStart=$NPM_BIN start
Restart=always
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF

echo "wrote $UNIT_FILE"

# Nightly DB snapshots (npm run backup → config.json backup.dir, keeps backup.keep). Persistent = catch up after downtime.
cat > "$BACKUP_UNIT" <<EOF
[Unit]
Description=personal-assistant — snapshot SQLite databases

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
Environment=PATH=$SERVICE_PATH
ExecStart=$NPM_BIN run --silent backup
EOF

cat > "$BACKUP_TIMER" <<EOF
[Unit]
Description=personal-assistant — nightly SQLite snapshot

[Timer]
OnCalendar=*-*-* 03:30
Persistent=true

[Install]
WantedBy=timers.target
EOF

echo "wrote $BACKUP_UNIT, $BACKUP_TIMER"

# --- Enable & start --------------------------------------------------------
# Keep the service alive across logout (no-op if already enabled).
loginctl enable-linger "$USER" >/dev/null 2>&1 || \
  echo "warning: could not enable linger — service may stop when you log out"

systemctl --user daemon-reload
systemctl --user enable --now "${SERVICE_NAME}.service"
systemctl --user enable --now "${SERVICE_NAME}-backup.timer"

echo
echo "personal-assistant installed and started."
echo "  status:  systemctl --user status ${SERVICE_NAME}"
echo "  logs:    journalctl --user -u ${SERVICE_NAME} -f"
echo "  stop:    systemctl --user stop ${SERVICE_NAME}"
echo "  restart: systemctl --user restart ${SERVICE_NAME}"
echo "  backup:  systemctl --user start ${SERVICE_NAME}-backup   (nightly: ${SERVICE_NAME}-backup.timer)"
