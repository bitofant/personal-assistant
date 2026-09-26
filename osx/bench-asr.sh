#!/bin/bash
# Transcription spike: FluidAudio's own CLI (Parakeet v3 ASR + offline diarization) on a `pa test-capture` recording.
# usage: osx/bench-asr.sh [capture-dir] [stamp]   (default ~/pa-test-capture, newest recording)
# Output: <capture-dir>/bench-<stamp>/ (JSON, logs, transcripts) + summary.txt. First run = model download (cold);
# re-run for warm timings. bash 3.2 (stock macOS).
set -euo pipefail

FA_TAG=v0.17.4  # keep in sync with Package.swift
dir=${1:-$HOME/pa-test-capture}
stamp=${2:-}
cache="$HOME/Library/Caches/com.bitofant.pa/FluidAudio-$FA_TAG"

if [ -z "$stamp" ]; then
  # Newest pa-<yyyyMMdd-HHmmss>-*.wav; stamps sort lexically = chronologically.
  stamp=$(ls "$dir" | sed -nE 's/^pa-([0-9]{8}-[0-9]{6})-(system|mic)\.wav$/\1/p' | sort | tail -1)
  [ -n "$stamp" ] || { echo "no pa-*-{system,mic}.wav in $dir" >&2; exit 1; }
fi

if [ ! -x "$cache/.build/release/fluidaudiocli" ]; then
  echo "building fluidaudiocli $FA_TAG (once) → $cache"
  [ -d "$cache" ] || git clone -q --depth 1 --branch "$FA_TAG" https://github.com/FluidInference/FluidAudio "$cache"
  (cd "$cache" && swift build -c release --product fluidaudiocli)
fi
cli="$cache/.build/release/fluidaudiocli"

out="$dir/bench-$stamp"
mkdir -p "$out"
summary="$out/summary.txt"
{
  echo "FluidAudio $FA_TAG | $(sw_vers -productVersion) | $(sysctl -n machdep.cpu.brand_string)"
  echo "recording $stamp"
} > "$summary"

# plutil reads JSON; missing key → "—" (unknown, not 0).
get() { plutil -extract "$2" raw -o - "$1" 2>/dev/null || echo "—"; }

for kind in mic system; do
  wav="$dir/pa-$stamp-$kind.wav"
  [ -f "$wav" ] || { echo "$kind: no WAV" >> "$summary"; continue; }
  echo "== ASR $kind"
  t0=$(date +%s)
  "$cli" transcribe "$wav" --word-timestamps --output-json "$out/$kind-asr.json" > "$out/$kind-asr.log" 2>&1 \
    || { echo "$kind ASR FAILED (see $kind-asr.log)" | tee -a "$summary"; continue; }
  wall=$(( $(date +%s) - t0 ))
  get "$out/$kind-asr.json" text > "$out/$kind.txt"
  echo "$kind ASR: audio $(get "$out/$kind-asr.json" durationSeconds)s, processing $(get "$out/$kind-asr.json" processingTimeSeconds)s, RTFx $(get "$out/$kind-asr.json" rtfx), wall ${wall}s (incl. model load), words $(wc -w < "$out/$kind.txt" | tr -d ' ')" >> "$summary"
done

wav="$dir/pa-$stamp-system.wav"
if [ -f "$wav" ]; then
  echo "== diarization system"
  t0=$(date +%s)
  if "$cli" process "$wav" --mode offline --output "$out/system-diar.json" > "$out/system-diar.log" 2>&1; then
    wall=$(( $(date +%s) - t0 ))
    echo "system diarization: speakers $(get "$out/system-diar.json" speakerCount), processing $(get "$out/system-diar.json" processingTimeSeconds)s, RTF $(get "$out/system-diar.json" realTimeFactor), wall ${wall}s" >> "$summary"
  else
    echo "system diarization FAILED (see system-diar.log)" | tee -a "$summary"
  fi
fi

echo "---"
cat "$summary"
echo "transcripts: $out/{mic,system}.txt — read them against the audio for accuracy/language"
