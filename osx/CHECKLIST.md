# Mac run checklist

First live run of everything that has only been built/tested on Linux. Goal: first real transcript on the server.
Tick boxes, paste errors/output into notes as you go; bring the "Report back" list to the dev box.

All commands from the repo root on the Mac. `pa` = `osx/build/PA.app/Contents/MacOS/pa` (bare binary is fine
for everything except `test-capture`, which needs TCC → launch via `open`).

## 0. Prerequisites

- [ ] macOS 26, Apple Silicon: `sw_vers -productVersion`, `uname -m` → `arm64`
- [ ] Command Line Tools: `xcode-select -p`; Swift 6: `swift --version`
- [ ] Signing identity `PA Local Signing` exists (`security find-identity -p codesigning`); else `osx/build.sh` prints how to make one
- [ ] Headphones on (no echo handling by design)
- [ ] Repo up to date: `git pull`

## 1. Build (FluidAudio code has never been compiled)

- [ ] `cd osx && swift test` — PACore tests pass on macOS too
- [ ] `osx/build.sh` — expect first-time compile errors in `Sources/pa/FluidEngines.swift` / `Transcribe.swift`
      (written against FluidAudio v0.17.4 source). Note every fix + why.
- [ ] `codesign -dv osx/build/PA.app` shows identifier `com.bitofant.pa`

## 2. Capture (global tap: never run live)

- [ ] Start a real call or play a YouTube video with speech + talk into the mic yourself
- [ ] `open -W --stdout $(tty) --stderr $(tty) osx/build/PA.app --args test-capture --seconds 60`
- [ ] First run: "System Audio Recording Only" + mic prompts appear and are attributed to **PA** (not Terminal)
- [ ] Per-second progress: both streams non-zero; no "all-zero stream" warning
- [ ] Listen to `~/pa-test-capture/pa-<stamp>-{system,mic}.wav`: system = everything the Mac played, mic = you only, no gaps/speed-up
- [ ] Optional: record ≥10 min of a real meeting (Zoom and a browser call) for the ASR bench + summary tuning

## 3. ASR bench (FluidAudio CLI, independent of `pa`)

- [ ] `osx/bench-asr.sh` (first run clones + builds fluidaudiocli, downloads models)
- [ ] Re-run for warm timings
- [ ] `~/pa-test-capture/bench-<stamp>/summary.txt`: speed (RTF), transcript readable, Dutch + English OK, speaker count plausible

## 4. Pair (never run on the Mac)

- [ ] Server reachable. Only https, or `http://localhost`: e.g. `ssh -N -L 4200:localhost:4200 <devbox>` → use `http://localhost:4200`
- [ ] Account enabled in the server's `config.json` `users`
- [ ] `pa pair <server-url> <account>` → 6-digit code shows immediately (not only at exit)
- [ ] Web UI → Devices → type the code → `pa pair` finishes on its own
- [ ] Device name in the web UI = the Mac's name (`Host` lookup)
- [ ] Keychain: any "pa wants to access…" prompt? (note it) — re-run `pa status` → `active`, no prompt
- [ ] `pa pair` again with same server + account → same device (reuses token), no duplicate in the web UI

## 5. Transcribe + upload (first real end-to-end)

- [ ] `pa transcribe --no-diarize` → `~/pa-test-capture/pa-<stamp>-transcript.json`; note wall time vs recording length
- [ ] `pa transcribe` (with diarization) → speakers `Speaker 1..N` on system audio, you on mic; note wall time
- [ ] Spot-check the JSON: words right? segments sensibly split? timestamps line up with the WAV?
- [ ] `pa transcribe --upload` → transcript appears in the web UI
- [ ] Re-run `pa transcribe --upload` → still one transcript (same id, upsert)
- [ ] Summary appears (ad-hoc type, no calendar yet); read it critically
- [ ] Search finds a word you said

## 6. Upload queue + `pa run` (never compiled/run)

- [ ] `pa queue` → `queue empty (…/upload-queue)`
- [ ] Server down (or stop the ssh tunnel), `pa transcribe --upload` → "retry after …", "still queued"; `pa queue` shows it `pending` with the error
- [ ] `pa run` in a terminal; bring the server back → uploaded within the backoff (≤ a few min), log lines timestamped + flushed
- [ ] Revoke the device in the web UI while `pa run` runs, then `pa transcribe --upload` → `pa run` logs "stopped until re-paired", then one "pairing check" line per change (not every minute)
- [ ] `pa pair` again (same server/account) + approve → `pa run` logs "resumed" and uploads without a restart
- [ ] Delete a transcript in the web UI, re-run `pa transcribe --upload` for that recording → "dropped … (deleted on server)", gone from `pa queue`
- [ ] Ctrl-C `pa run` → exits promptly

## Report back (to the dev box)

- Compile fixes (diff) + anything surprising about FluidAudio's API
- `bench-<stamp>/summary.txt`, and a real `pa-<stamp>-transcript.json` (scrub it if private)
- Timings: capture length vs ASR / diarization wall time, cold vs warm
- TCC + Keychain prompt behaviour (who they were attributed to, any repeats)
- Summary quality notes on a real meeting (language, speaker labels, misheard words)
- Upload queue: log output of the outage / revoke / re-pair runs
- Anything to record in AGENTS.md as "verified live"
