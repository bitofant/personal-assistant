# Mac run checklist

First live run of everything that has only been built/tested on Linux. Goal: first real transcript on the server.

## Before you start

- Headphones, a YouTube video with speech (or a call), ~30 min
- `git pull`
- Server account enabled in the server's `config.json` `users`; web UI open in a browser
- Signing identity `PA Local Signing` (Keychain Access → Certificate Assistant → Create a Certificate…,
  Self Signed Root, Code Signing). The script checks and tells you if it's missing.

## Run

```sh
# on the home LAN (the server is LAN-only, see docs/remote-access.md):
osx/mac-check.sh --server https://assistant.riuna.com --account <you>
# --tunnel <devbox-ssh-host> forwards to the box's localhost:4200 → only works while server.host = 127.0.0.1
```

It walks through every step, and stops when you need to do something ("start the video, press a key", "type the
code in the web UI", "revoke the device") or judge something (it plays the recordings back, shows transcripts;
answer `y` / `n` + a note / `s` skip). Everything it can check itself it checks.

Stages: `prereqs build capture bench transcribe pair upload queue daemon live`. `q` or Ctrl-C quits (report still written).

- **Next Mac session** (stages up to `queue` done 2026-09-30): `--only build`, then `--only queue` (410 drop step
  wasn't exercised), then `--only daemon` (~15 min; needs a call or any app using the mic, plus audio playing).
  Uninstall the LaunchAgent first if you installed it (`osx/install.sh --uninstall`). Then `--only live` (~10 min,
  same call setup + a browser on the web UI): live preview while recording; the summary gets the measured lag
  (`lag p50 … p95 …`, target ≤10 s). New uncompiled code: `Sources/pa/LiveEngine.swift` (+ sink plumbing in
  `WavWriter` / `MicCapture` / `SystemAudioTap` / `CaptureRecorder`).
- **Build fails** (expected: the `pa run` daemon code has never been compiled; errors in `Sources/pa/Run.swift` /
  `Calendars.swift` / `Signals.swift` / `CaptureRecorder.swift`): fix, note each fix + why, then
  `osx/mac-check.sh --only build …`
- After `daemon` passes: `osx/install.sh` (LaunchAgent, starts at login; log `~/Library/Logs/com.bitofant.pa.log`).
- Redo one stage: `--only capture`, `--only queue`, …; longer recording: `--seconds 600`
- Other mic: `osx/pick-mic.sh`
- `--tunnel` = the script runs `ssh -L 4200:localhost:4200 <host>` and cuts it for the outage test; without it,
  it asks you to make the server unreachable and back.

## Bring back to the dev box

- `~/pa-test-capture/report-<stamp>.tgz` (summary with every ✓/✗ + your notes, per-step logs, bench summary,
  `osx.diff` = your compile fixes)
- Anything surprising about FluidAudio's API
- Optional: `~/pa-test-capture/pa-<stamp>-transcript.json` of a real meeting (not in the tgz: private; scrub it)
