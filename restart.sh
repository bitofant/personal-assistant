#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

SERVICE=personal-assistant
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${SERVICE}.service"

# Run rebuild+restart in a transient unit so it survives if invoked from inside the service's cgroup.
if [ -f "$UNIT" ] && command -v systemd-run >/dev/null; then
  systemd-run --user --collect --quiet \
    --unit="${SERVICE}-restart" \
    --description="rebuild + restart ${SERVICE}" \
    --working-directory="$PWD" \
    -- bash -c "
      set -o pipefail
      ./rebuild.sh || exit 1
      systemctl --user reset-failed '${SERVICE}' 2>/dev/null || true
      systemctl --user restart '${SERVICE}'
      # Safety net: confirm it really came back, and start it if it didn't.
      for _ in \$(seq 1 20); do
        systemctl --user is-active --quiet '${SERVICE}' && exit 0
        sleep 1
      done
      systemctl --user reset-failed '${SERVICE}' 2>/dev/null || true
      systemctl --user start '${SERVICE}'
    "
  echo "rebuild + restart handed to ${SERVICE}-restart.service (detached)."
  echo "  watch:  journalctl --user -u ${SERVICE}-restart -f"
  exit 0
fi

# --- Fallbacks: no systemd-run, or the service isn't installed -------------
./rebuild.sh
if [ -f "$UNIT" ]; then
  systemctl --user restart "$SERVICE"
  echo "personal-assistant restarted (systemctl --user restart $SERVICE)"
else
  ./stop.sh
  ./start.sh
fi
