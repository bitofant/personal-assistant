#!/usr/bin/env bash
# Interactive generator for config.json (gitignored; no env vars). Shape: config.example.json.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG_FILE="config.json"

ask() {
  local prompt="$1" default="$2" reply
  read -r -p "$prompt [$default] " reply || true
  echo "${reply:-$default}"
}
ask_yn() {
  local prompt="$1" default="$2" reply hint="[y/N]"
  [ "$default" = "y" ] && hint="[Y/n]"
  read -r -p "$prompt $hint " reply || true
  case "${reply:-$default}" in [Yy]*) echo true ;; *) echo false ;; esac
}
json_str() {
  local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"
}
json_list() { # comma-separated -> JSON array of trimmed strings
  local out="" item
  IFS=',' read -ra items <<< "$1"
  for item in "${items[@]}"; do
    item="$(printf '%s' "$item" | sed 's/^ *//;s/ *$//')"
    [ -z "$item" ] && continue
    out="${out:+$out, }$(json_str "$item")"
  done
  printf '[%s]' "$out"
}

if [ -f "$CONFIG_FILE" ] && [ "$(ask_yn "$CONFIG_FILE exists. Overwrite?" n)" != true ]; then
  echo "Aborted; kept existing $CONFIG_FILE."; exit 0
fi

echo "personal-assistant setup -> $CONFIG_FILE"
PORT="$(ask "Server port" 4200)"
# Loopback = only a local HTTPS proxy/tunnel reaches it (docs/remote-access.md).
HOST="$(ask "Bind address (127.0.0.1; 172.17.0.1 = nginx in Docker; 0.0.0.0 = whole network, plain HTTP)" 127.0.0.1)"
USERS="$(ask "Enabled usernames (comma-separated)" "")"

echo
echo "Local (free) OpenAI-compatible LLM, e.g. vLLM :8000 or llama.cpp :8080"
LOCAL_URL="$(ask "  Base URL" "http://localhost:8000/v1")"
CHAT_MODEL="$(ask "  Chat model (summaries/search)" "")"
EMBED_MODEL="$(ask "  Embedding model" "")"
PROVIDERS="{ \"id\": \"local\", \"baseUrl\": $(json_str "$LOCAL_URL"), \"apiKey\": null, \"models\": $(json_list "$CHAT_MODEL,$EMBED_MODEL") }"

# Paid providers are never the default; optionally offered as a user-selectable summary model.
SUMMARY_ALTS=""
while [ "$(ask_yn "Add a paid provider (openai/openrouter/baseten…)?" n)" = true ]; do
  PID="$(ask "  Provider id" "openrouter")"
  PURL="$(ask "  Base URL" "https://openrouter.ai/api/v1")"
  read -r -s -p "  API key: " PKEY; echo
  PMODELS="$(ask "  Models (comma-separated)" "")"
  PROVIDERS="$PROVIDERS,
      { \"id\": $(json_str "$PID"), \"baseUrl\": $(json_str "$PURL"), \"apiKey\": $(json_str "$PKEY"), \"models\": $(json_list "$PMODELS") }"
  PFIRST="$(printf '%s' "${PMODELS%%,*}" | sed 's/^ *//;s/ *$//')"
  if [ -n "$PFIRST" ] && [ "$(ask_yn "  Let users pick $PID/$PFIRST for summaries?" y)" = true ]; then
    SUMMARY_ALTS="$SUMMARY_ALTS, { \"provider\": $(json_str "$PID"), \"model\": $(json_str "$PFIRST") }"
  fi
done

TASKS=""
if [ -n "$CHAT_MODEL" ]; then
  # List = user-selectable models; first = default.
  TASKS="\"summary\": [{ \"provider\": \"local\", \"model\": $(json_str "$CHAT_MODEL") }$SUMMARY_ALTS],
      \"search\": { \"provider\": \"local\", \"model\": $(json_str "$CHAT_MODEL") }"
fi
if [ -n "$EMBED_MODEL" ]; then
  TASKS="${TASKS:+$TASKS,
      }\"embed\": { \"provider\": \"local\", \"model\": $(json_str "$EMBED_MODEL") }"
fi

umask 077 # holds API keys
cat > "$CONFIG_FILE" <<EOF
{
  "server": { "host": $(json_str "$HOST"), "port": $PORT },
  "users": $(json_list "$USERS"),
  "llm": {
    "providers": [
      $PROVIDERS
    ],
    "tasks": {
      $TASKS
    }
  }
}
EOF
echo "Wrote $CONFIG_FILE."
