#!/bin/bash
# Guided first-Mac run = all of osx/CHECKLIST.md: runs every step, pauses when you need to act, asks y/n where only
# a human can judge, logs everything to ~/pa-test-capture/report-<stamp>/ (+ .tgz) to bring to the dev box.
# usage: osx/mac-check.sh [--from STAGE | --only STAGE] [--seconds N] [--server URL] [--account NAME] [--tunnel SSH_HOST]
# stages: prereqs build capture bench transcribe pair upload queue
# --tunnel: script runs `ssh -L 4200:localhost:4200 HOST` itself (server = http://localhost:4200) and can cut it
# for the outage test. bash 3.2 (stock macOS).
set -uo pipefail

STAGES="prereqs build capture bench transcribe pair upload queue"
from= only= seconds=30 server= account= tunnel=
while [ $# -gt 0 ]; do
  case "$1" in
    --from) from=${2:-}; shift ;;
    --only) only=${2:-}; shift ;;
    --seconds) seconds=${2:-}; shift ;;
    --server) server=${2:-}; shift ;;
    --account) account=${2:-}; shift ;;
    --tunnel) tunnel=${2:-}; shift ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
for s in $from $only; do
  case " $STAGES " in *" $s "*) ;; *) echo "unknown stage: $s (stages: $STAGES)" >&2; exit 2 ;; esac
done
case "$seconds" in ''|*[!0-9]*) echo "--seconds needs a number" >&2; exit 2 ;; esac

osx=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$osx")
pa="$osx/pa"
bin="$osx/build/PA.app/Contents/MacOS/pa"
captures="$HOME/pa-test-capture"
report="$captures/report-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$report"
summary="$report/summary.txt"
fails=0 run_pid= sock="$report/.tunnel.sock"
stamp=

b=$(tput bold 2>/dev/null || true) r=$(tput sgr0 2>/dev/null || true)
note() { echo "$*" | tee -a "$summary"; }
pass() { note "  ✓ $*"; }
fail() { note "  ✗ $*"; fails=$((fails + 1)); }

# pause "instructions" → any key continues, q quits.
pause() {
  echo; echo "${b}▶ $*${r}"
  printf '  [any key = continue, q = quit] '
  local k; read -rsn1 k </dev/tty; echo
  [ "$k" = q ] && finish
}

# ask "question" → y/n (+ optional note on n) / s = skip; logged as a check.
ask() {
  local k n
  while true; do
    printf '%s? %s [y/n/s] ' "$b" "$*$r"
    read -rsn1 k </dev/tty; echo "$k"
    case "$k" in
      y|Y) pass "$*"; return 0 ;;
      s|S) note "  - $* (skipped)"; return 0 ;;
      n|N) read -rp "  what's wrong? (Enter = nothing to add) " n </dev/tty
           fail "$*${n:+ — $n}"; return 1 ;;
    esac
  done
}

# run NAME CMD… → live output + NAME.log, ✓/✗ + wall time.
run() {
  local name=$1; shift
  echo "${b}\$ ${*#$osx/}${r}"
  local t0; t0=$(date +%s)
  "$@" 2>&1 | tee "$report/$name.log"
  local rc=${PIPESTATUS[0]} wall=$(( $(date +%s) - t0 ))
  if [ "$rc" -eq 0 ]; then pass "$name (${wall}s)"; else fail "$name (exit $rc, ${wall}s) → $name.log"; fi
  return "$rc"
}

# expect NAME PATTERN DESC → grep NAME.log (ERE).
expect() {
  if grep -qE "$2" "$report/$1.log"; then pass "$3"; else fail "$3 (no /$2/ in $1.log)"; return 1; fi
}

# wait_for SECONDS DESC CMD… → poll until CMD succeeds (e.g. a line shows up in a growing log).
wait_for() {
  local max=$1 desc=$2 i=0; shift 2
  printf '  waiting ≤%ss for: %s ' "$max" "$desc"
  while [ $i -lt "$max" ]; do
    if "$@" 2>/dev/null; then echo; pass "$desc (${i}s)"; return 0; fi
    sleep 2; i=$((i + 2)); printf .
  done
  echo; fail "$desc (not within ${max}s)"; return 1
}
# after_line FILE A B → B appears on a line after the first A (ERE).
after_line() { awk -v a="$2" -v b="$3" '$0 ~ a {f=1; next} f && $0 ~ b {x=1} END {exit !x}' "$1"; }

newest_stamp() {
  ls "$captures" 2>/dev/null | sed -nE 's/^pa-([0-9]{8}-[0-9]{6})-(system|mic)\.wav$/\1/p' | sort | tail -1
}

need_build() {
  [ -x "$bin" ] && return 0
  fail "no $bin — fix the build, then: osx/mac-check.sh --from build"; finish
}

need_stamp() {
  [ -n "$stamp" ] || stamp=$(newest_stamp)
  [ -n "$stamp" ] && return 0
  fail "no recording in $captures — run: osx/mac-check.sh --only capture"; finish
}

need_server() {
  if [ -n "$tunnel" ]; then server=${server:-http://localhost:4200}; tunnel_up; fi
  if [ -z "$server" ]; then
    echo "Server URL: https://…, or http://localhost:<port> via your own ssh tunnel (or re-run with --tunnel HOST)."
    read -rp "  server URL: " server </dev/tty
  fi
  [ -n "$account" ] || read -rp "  account (enabled in the server's config.json users): " account </dev/tty
  note "  server $server, account $account${tunnel:+, tunnel via $tunnel}"
}

tunnel_up() {
  [ -S "$sock" ] && return 0
  # -f after auth (password prompt still works); -M/-S = control socket so we can close exactly this tunnel.
  ssh -f -N -M -S "$sock" -o ExitOnForwardFailure=yes -L 4200:localhost:4200 "$tunnel" \
    || { fail "ssh tunnel to $tunnel"; finish; }
}
tunnel_down() { [ -S "$sock" ] && ssh -S "$sock" -O exit "$tunnel" 2>/dev/null; }

transcript_json() { echo "$captures/pa-$stamp-transcript.json"; }

finish() {
  [ -n "$run_pid" ] && kill -TERM "$run_pid" 2>/dev/null
  [ -n "$tunnel" ] && tunnel_down
  git -C "$repo" diff -- osx > "$report/osx.diff"
  [ -s "$report/osx.diff" ] && note "local osx changes (compile fixes?) → osx.diff" || rm -f "$report/osx.diff"
  local new; new=$(git -C "$repo" ls-files --others --exclude-standard -- osx | tr '\n' ' ')
  [ -z "$new" ] || note "new untracked osx files (not in osx.diff): $new"
  tar -czf "$report.tgz" -C "$captures" "$(basename "$report")"
  echo; echo "${b}=== summary${r}"; cat "$summary"
  echo; echo "$fails problem(s). Bring $report.tgz to the dev box (the transcript JSON is not in it: private)."
  exit $(( fails > 0 ))
}
trap 'echo; note "interrupted"; finish' INT

want() {
  if [ -n "$only" ]; then [ "$1" = "$only" ]; return; fi
  if [ -n "$from" ]; then case " ${STAGES#*$from} " in *" $1 "*) ;; *) [ "$1" = "$from" ] || return 1 ;; esac; fi
  return 0
}

stage() {
  echo; echo "${b}━━━ $1: $2${r}" | tee -a "$summary"
}

# ── stages ──────────────────────────────────────────────────────────────────────────────────────────────────────────

st_prereqs() {
  local v; v=$(sw_vers -productVersion)
  if [ "${v%%.*}" -ge 26 ]; then pass "macOS $v"; else fail "macOS $v (need 26+)"; fi
  if [ "$(uname -m)" = arm64 ]; then pass "arm64"; else fail "$(uname -m) (need arm64)"; fi
  if xcode-select -p >/dev/null 2>&1; then pass "developer tools"; else fail "no developer tools: xcode-select --install"; fi
  v=$(swift --version 2>&1 | head -1)
  case "$v" in *"Swift version 6"*) pass "$v" ;; *) fail "Swift 6 missing: $v" ;; esac
  if security find-identity -p codesigning | grep -qF '"PA Local Signing"'; then pass "signing identity PA Local Signing"
  else fail "no signing identity \"PA Local Signing\" (osx/build.sh explains how to create one)"; fi
  note "  $(sysctl -n machdep.cpu.brand_string), $(( $(sysctl -n hw.memsize) / 1073741824 )) GB, repo $(git -C "$repo" rev-parse --short HEAD)"
}

st_build() {
  run swift-test bash -c "cd '$osx' && swift test"
  # First compile of the FluidAudio code: expect errors in Sources/pa/FluidEngines.swift / Transcribe.swift.
  run build "$osx/build.sh" || { echo "Fix the errors (note each fix + why), then: osx/mac-check.sh --from build"; finish; }
  if codesign -dv "$osx/build/PA.app" 2>&1 | grep -q '^Identifier=com.bitofant.pa$'; then pass "signed as com.bitofant.pa"
  else fail "PA.app not signed as com.bitofant.pa"; fi
}

st_capture() {
  need_build
  local mic; mic=$("$bin" mics 2>/dev/null | awk -F'\t' '$3 ~ /selected/ {print $2; f=1} END {if (!f) print "system default"}')
  pause "Put on headphones. Start a YouTube video with speech (or a call) and keep it playing.
  Recording ${seconds}s from mic: $mic (other mic: osx/pick-mic.sh). TALK into the mic the whole time.
  First run: macOS asks for Microphone + System Audio Recording — allow both."
  run capture "$pa" test-capture --seconds "$seconds"
  stamp=$(newest_stamp)
  expect capture 'bundle: com\.bitofant\.pa' "ran as PA.app (TCC attributed to PA)"
  if grep -q 'all zeros' "$report/capture.log"; then fail "a stream is all zeros (permission denied / nothing playing) → capture.log"
  else pass "both streams have signal"; fi
  ask "Permission prompts (if any) named PA, not Terminal"
  echo "  Playing 8s of the system stream…"; afplay -t 8 "$captures/pa-$stamp-system.wav"
  ask "System stream = the video/call, clean (no gaps, not sped up)"
  echo "  Playing 8s of the mic stream…"; afplay -t 8 "$captures/pa-$stamp-mic.wav"
  ask "Mic stream = your voice only (video not audible), clean"
}

st_bench() {
  need_stamp
  run bench "$osx/bench-asr.sh" "$captures" "$stamp" || return
  local d="$captures/bench-$stamp"
  cp "$d/summary.txt" "$report/bench-summary.txt"
  for k in mic system; do [ -f "$d/$k.txt" ] && { echo "  ${b}$k:${r} $(head -c 400 "$d/$k.txt")…"; }; done
  ask "FluidAudio transcripts readable, right language (Dutch/English)"
}

st_transcribe() {
  need_build; need_stamp
  run transcribe-no-diarize "$pa" transcribe --stamp "$stamp" --no-diarize
  run transcribe "$pa" transcribe --stamp "$stamp" || return
  ask "Words mostly right, segments split sensibly"
  ask "Speakers: you on mic, Speaker 1..N on system audio"
}

st_pair() {
  need_build; need_server
  "$pa" status > "$report/status-before.log" 2>&1
  pause "pa pair will show a 6-digit code. Open $server/#/devices (signed in as $account) and type it in; pa finishes on its own.
  Watch for a Keychain dialog (\"pa wants to use…\")."
  run pair "$pa" pair "$server" "$account" || return
  expect pair 'Paired:|Already paired' "paired"
  ask "Device name in the web UI = this Mac's name"
  ask "No Keychain dialog (n = there was one; describe it)"
  run status "$pa" status && expect status ': active$' "status active"
  run pair-again "$pa" pair "$server" "$account" && expect pair-again 'Already paired' "re-pair reuses the token"
  ask "Still one device for this Mac in the web UI"
}

st_upload() {
  need_build; need_stamp
  [ -n "$server" ] || need_server
  run upload "$pa" transcribe --stamp "$stamp" --upload || return
  expect upload '^(uploaded|replaced) ' "uploaded"
  run upload-again "$pa" transcribe --stamp "$stamp" --no-diarize --upload
  expect upload-again '^replaced ' "re-upload replaced (same id, no duplicate)"
  pause "Open $server — the transcript is listed. Open it and wait for the summary (a few seconds to a minute)."
  ask "Transcript visible in the web UI"
  ask "Summary appeared and is sensible (n = note what's off: language, speakers, misheard words)"
  ask "Search ($server nav box) finds a word you said"
}

st_queue() {
  need_build; need_stamp
  [ -n "$server" ] || need_server
  local log="$report/pa-run.log"
  run queue-empty "$pa" queue && expect queue-empty '^queue empty' "queue empty"

  # Outage: enqueue while unreachable, then pa run delivers it once the server is back.
  if [ -n "$tunnel" ]; then tunnel_down; echo "  tunnel closed (server unreachable)"
  else pause "Make the server unreachable for this Mac (stop your ssh tunnel / the server)."; fi
  run outage-upload "$pa" transcribe --stamp "$stamp" --no-diarize --upload
  expect outage-upload 'still queued' "kept in queue during outage"
  run outage-queue "$pa" queue && expect outage-queue '^pending ' "pa queue shows it pending"
  "$bin" run > "$log" 2>&1 & run_pid=$!
  echo "  pa run started (pid $run_pid, log pa-run.log)"
  sleep 5
  if [ -n "$tunnel" ]; then tunnel_up; echo "  tunnel restored"
  else pause "Make the server reachable again."; fi
  wait_for 180 "pa run uploads after the outage" grep -qE ' (uploaded|replaced) ' "$log"

  # Revoke → halt → re-pair → resume without restarting pa run.
  pause "In $server/#/devices, REVOKE this Mac's device."
  run revoked-upload "$pa" transcribe --stamp "$stamp" --no-diarize --upload
  wait_for 90 "pa run halts on revoke" grep -q 'stopped until re-paired' "$log"
  pause "Next: pa pair again → type the new code in the web UI."
  run repair "$pa" pair "$server" "$account"
  wait_for 90 "pa run resumes after re-pair (no restart)" grep -q 'resumed' "$log"
  wait_for 90 "pa run uploads after resume" after_line "$log" 'resumed' ' (uploaded|replaced) '
  [ "$(grep -c 'pairing check' "$log")" -le 4 ] && pass "pairing checks logged per change only" \
    || fail "pairing check logged $(grep -c 'pairing check' "$log")× (expected once per change)"

  # Delete on server → tombstone → queue drops it.
  pause "Delete this transcript in the web UI (open it → Delete transcript)."
  run deleted-upload "$pa" transcribe --stamp "$stamp" --no-diarize --upload
  expect deleted-upload '^dropped .*deleted on server' "upload of a deleted transcript is dropped"
  run final-queue "$pa" queue && expect final-queue '^queue empty' "queue empty again"
  # Its id is tombstoned now → next run gets a fresh id.
  mv "$(transcript_json)" "$captures/pa-$stamp-transcript.deleted-$(date +%s).json"

  # TERM, not INT: background jobs start with SIGINT ignored. TERM = what launchd sends anyway.
  kill -TERM "$run_pid"; local i=0
  while kill -0 "$run_pid" 2>/dev/null && [ $i -lt 10 ]; do sleep 1; i=$((i + 1)); done
  if kill -0 "$run_pid" 2>/dev/null; then fail "pa run ignores SIGTERM (>10s)"; kill -KILL "$run_pid"; else pass "pa run exits on SIGTERM (${i}s)"; fi
  run_pid=
}

note "mac-check $(date '+%Y-%m-%d %H:%M:%S %z') → $report"
want prereqs && { stage prereqs "Mac + toolchain"; st_prereqs; }
want build && { stage build "swift test + build.sh (first compile of the FluidAudio code)"; st_build; }
want capture && { stage capture "record ${seconds}s: system audio + mic"; st_capture; }
want bench && { stage bench "FluidAudio CLI speed + accuracy (first run downloads models)"; st_bench; }
want transcribe && { stage transcribe "pa transcribe with and without diarization"; st_transcribe; }
want pair && { stage pair "pair this Mac with the server"; st_pair; }
want upload && { stage upload "first real transcript on the server"; st_upload; }
want queue && { stage queue "upload queue + pa run: outage, revoke, re-pair, delete"; st_queue; }
finish
