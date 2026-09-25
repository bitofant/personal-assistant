#!/usr/bin/env bash
# Pick the mic pa records from; persisted by `pa set-mic`. Usage: osx/pick-mic.sh
# bash 3.2 compatible (macOS /bin/bash): no mapfile, no associative arrays.
set -euo pipefail
cd "$(dirname "$0")"

# Bare binary is fine: listing devices / writing config needs no TCC grant.
PA=build/PA.app/Contents/MacOS/pa
[[ -x $PA ]] || { echo "No $PA — run osx/build.sh first." >&2; exit 1; }

uids=() names=() flags=()
while IFS=$'\t' read -r uid name flag; do
  uids+=("$uid") names+=("$name") flags+=("${flag:-}")
done < <("$PA" mics)
[[ ${#uids[@]} -gt 0 ]] || { echo "No input devices found." >&2; exit 1; }

# No device selected (or selected one unplugged) = system default in use.
default_mark='  [selected]'
for f in "${flags[@]}"; do
  if [[ $f == *selected* ]]; then default_mark=; fi
done

echo "Microphones:"
printf '  %2d) System default input%s\n' 0 "$default_mark"
for i in "${!uids[@]}"; do
  printf '  %2d) %s%s\n' $((i + 1)) "${names[$i]}" "${flags[$i]:+  [${flags[$i]}]}"
done

read -rp "Use which mic? [0-${#uids[@]}] " n
[[ $n =~ ^[0-9]+$ ]] && ((n <= ${#uids[@]})) || { echo "Not a valid choice: $n" >&2; exit 1; }

if ((n == 0)); then
  "$PA" set-mic --default
else
  "$PA" set-mic "${uids[$((n - 1))]}"
fi
