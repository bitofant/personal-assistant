# personal-assistant

Self-hosted meeting assistant. A headless macOS agent records and transcribes your meetings on-device and uploads the transcripts. A Linux server then stores, summarizes and searches them using a local (or opt-in paid) LLM.

- `server/`: Node/TypeScript backend (plain `node:http`, SQLite); also serves the web UI
- `web/`: React + Vite frontend
- `shared/`: wire types (`api.ts`) + JSON fixtures shared with the Swift client
- `osx/`: headless Swift CLI `pa`: `pa run` daemon records meetings (calendar + mic detection), transcribes on-device, uploads to the server

Status: early. The server supports:
- web accounts (sign up while `auth.signup` is on, then an admin enables the account)
- pairing a Mac as a device (you approve it with a 6-digit code)
- transcript upload from a paired device
- a web UI to browse transcripts, and to delete one (with its summary and search entries). A deleted transcript can't be uploaded again: the server answers `410 Gone`. Existing backups keep it until they rotate out.
- LLM summaries of uploaded transcripts, made in a background job queue and shown on the transcript page (with progress, retry-after-outage and failure status, and a re-summarize button); `GET /api/llm/status` shows whether each LLM task is reachable. Jobs of disabled users wait until they're re-enabled.
- summary settings page: pick the summary model (e.g. local or a paid remote one, from those the admin configured) and write custom instructions per recurring series, per meeting type, or as your default. The most specific ones win. The meeting type (1:1, stand-up, interview, external, meeting, ad-hoc) comes from the calendar event: no event means ad-hoc, title keywords decide next, and 2 attendees means 1:1. When those rules can't tell, a recurring meeting reuses the type of its earlier occurrences, and otherwise the LLM classifies it.
- keyword search (search box in the nav bar, `GET /api/search?q=`) over titles, attendee names/emails and what was said. Every word must appear somewhere in the meeting; words match as prefixes, `"quoted phrases"` match exactly, and case and accents are ignored. Results show the best matching lines highlighted; click a timestamp to jump to that line. Filter by date range and by people (name or email, comma-separated; all must have attended). Filters work without a query too, listing matching meetings newest first. Semantic (embedding) search isn't built yet; see `AGENTS.md`.

- speaker names: on a transcript page, open Speakers and name the diarization labels ("Speaker 2" → "Bob"). People from the calendar invite are offered as suggestions. Names show in the transcript and in search results, and the next summary uses them (the current summary is marked out of date).
- account page: download everything stored for you as one JSON file, or delete your account. Deleting needs your password and removes your transcripts, summaries, devices and sessions, plus your copies in every backup. The admin should then remove the username from `config.json` `users`.

Data lives in `data/` (gitignored): `app.db` holds accounts, sessions, devices and the job queue, and `users/<id>.db` holds one user's transcripts, search index, summaries, speaker names, custom instructions and settings.

## Server setup (Linux)

Requirements: Node 22+.

```sh
npm install
./config-gen.sh        # writes config.json (gitignored); see config.example.json
npm run dev            # http://localhost:4200, Vite HMR on the same port
```

All configuration is in `config.json`. There are no env vars.

- `server`: `{"host": "127.0.0.1", "port": 4200}`. `host` must be an IP address (not a hostname); see Production below.
- `users`: usernames allowed to log in. A registered account stays disabled until it's listed here. The server reloads `config.json` automatically, so you don't need to restart it. Removing a username logs that user out right away and blocks their devices.
- `auth.signup` (default `false`): whether the login page offers Sign up and the server accepts new accounts. To add a user: set it to `true`, let them register, set it back to `false`, then list them in `users`. Login + signup attempts are limited to one per second across all clients (429 otherwise).
- `llm.providers`: OpenAI-compatible endpoints (local vLLM/llama.cpp, OpenRouter, …).
- `llm.tasks`: routes `summary` / `search` / `embed` to a provider+model. If a task isn't routed, that feature is off. Jobs that need it wait in the queue until you route it.
  - A task can also take a list of routes. The first is the default. For `summary`, each user can pick any listed route in the web UI, e.g. `[{local}, {openrouter}]` to offer a paid remote model. Users can only pick routes you list here.
  - Optional `contextTokens` per route = the model's context window (vLLM: `max_model_len` in `/v1/models`). Meetings too long for it are summarized in parts (notes per part, then one combined summary). Without it, the whole transcript is tried first and split only if the model replies that it's too long.
- `backup` (optional): `{"dir": "data/backups", "keep": 14}`, see Backups below.

### Production (systemd user service)

```sh
./install-service.sh   # builds dist/web if missing, installs + starts the unit
./restart.sh           # rebuild frontend (atomic swap) + restart
./start.sh dev / ./stop.sh   # run the dev server outside systemd
```

The server speaks plain HTTP and by default listens on `127.0.0.1` only (`server.host` in `config.json`). To reach it from elsewhere, put an HTTPS proxy or tunnel in front of it rather than binding it to `0.0.0.0`. Use `172.17.0.1` if the proxy is nginx in Docker. Changing `server.host` or `server.port` takes a restart. [`docs/remote-access.md`](docs/remote-access.md) covers giving the Mac permanent HTTPS access (Tailscale `serve` recommended; LAN-only nginx as the fallback).

### Backups

`npm run backup` writes a consistent snapshot of every database to `backup.dir/<yyyyMMdd-HHmmss>Z/` (`app.db` + `users/<id>.db`) and keeps the newest `backup.keep` snapshots. It's safe to run while the server is running. `./install-service.sh` also installs a systemd timer that runs it nightly at 03:30 (and catches up after downtime). Check it with `systemctl --user list-timers` and `journalctl --user -u personal-assistant-backup`.

The default `data/backups` is on the same disk as the data, so it guards against mistakes and corruption but not against losing the disk. Point `backup.dir` at another disk or a synced folder for that.

To restore: `./stop.sh`, move `data/` aside, copy the snapshot's `app.db` and `users/` into a fresh `data/`, then start again. Each snapshot file is self-contained (no `-wal` files needed).

## Development

```sh
npm test               # pure unit tests (fast; no network/processes)
npm run test:e2e       # HTTP flow on an in-process server, plus live tests that skip themselves if the server/LLM is down
npm run typecheck      # must pass before a PR
```

## macOS agent (`osx/`)

Requirements: Apple Silicon, macOS 26, Command Line Tools (`xcode-select --install`). You don't need Xcode.

First time on a Mac? Run `osx/mac-check.sh --server <url> --account <you>` (see `osx/CHECKLIST.md`). It guides you through build → capture → ASR bench → transcribe → pair → upload → upload-queue tests, pauses when you need to act, and writes a report to `~/pa-test-capture/report-<stamp>.tgz`.

One-time setup: create a self-signed code-signing certificate named `PA Local Signing`. In Keychain Access, go to Certificate Assistant → Create a Certificate…, then pick Identity Type "Self Signed Root" and Certificate Type "Code Signing". Permission grants stick to this signing identity, so they survive rebuilds.

```sh
cd osx
swift test             # pure unit tests (on the Linux dev box: osx/test-linux.sh, needs Docker)
./build.sh             # → build/PA.app (signed, headless)
./pa test-capture --seconds 30   # wrapper: runs build/PA.app/Contents/MacOS/pa from anywhere
```

`test-capture` records all system audio through a global Core Audio tap, plus your mic, into two WAVs in `~/pa-test-capture/`. It then prints peak/RMS levels for each stream. If a stream is flagged "all zeros", the permission was probably denied. Check System Settings → Privacy & Security → Microphone / Screen & System Audio Recording. It prints a progress line every second, so you can see when a stream stops advancing. To isolate a problem, use `--no-mic` or `--no-system` to record one stream only.

To record from a mic other than the system default, run `osx/pick-mic.sh`. It lists the input devices, lets you pick one by number, and saves the choice to `~/Library/Application Support/com.bitofant.pa/config.json`, where later runs pick it up. Choose `0` to go back to the system default. If the saved mic is unplugged, `pa` falls back to the system default.

To pair the Mac with your server account (the account must be enabled in the server's `config.json`), run:

```sh
./pa pair https://your-server alice   # shows a 6-digit code, waits
```

Sign in to the web UI, open Devices, and type in the code. `pa` stores the token in the Keychain and the server URL in `config.json`. `pa status` asks the server for the device's pairing state. `pa upload file.json` uploads a transcript in the `TranscriptUpload` format (see `shared/api.ts` and `shared/fixtures/transcript-upload.json`). Plain `http://` is only accepted for `localhost`.

To transcribe a recording on the Mac (Parakeet v3 speech-to-text + speaker diarization via [FluidAudio](https://github.com/FluidInference/FluidAudio); models download on first run):

```sh
./bench-asr.sh           # FluidAudio's own CLI on the newest capture: speed + raw transcripts
./pa transcribe          # newest capture → ~/pa-test-capture/pa-<stamp>-transcript.json
./pa transcribe --upload # …and queue it for upload to the paired server (tries once now)
./pa queue               # recordings not yet transcribed + pending/failed uploads
```

`pa transcribe` labels the mic stream as you (`--me NAME`, default: your macOS full name) and splits the system stream into `Speaker 1`, `Speaker 2`, …. Use `--stamp yyyyMMdd-HHmmss` to pick an older recording and `--no-diarize` to skip speaker separation. Re-running on the same recording keeps its id, so a re-upload replaces the transcript instead of duplicating it. Uploads go through a queue on disk (`~/Library/Application Support/com.bitofant.pa/upload-queue/`): if the server is unreachable, `pa run` retries with backoff; a revoked or unpaired device pauses the queue until you `pa pair` again; uploads the server rejects as invalid move to `failed/`. If you deleted that transcript in the web UI, the upload is refused (and dropped from the queue); delete the `-transcript.json` file to transcribe it again as a new transcript.

### Daemon (`pa run`)

`pa run` records meetings by itself. Every 5 s it checks whether another app is using the mic, whether a meeting app (Zoom, Teams, Webex, FaceTime, Slack, or a browser) is running, and which work-calendar events are near. It starts recording when the mic comes on, or when a meeting app is open during an invited work event (from 5 min before the start until 10 min after the end). It stops after 2 min without activity, and discards recordings that were active for less than 1 min. When it stops, it transcribes the recording, queues it for upload, and deletes the audio.

```sh
./pa calendars           # Source/Name of every calendar (first run asks for Calendar access)
./pa run                 # foreground, through PA.app (asks for the mic); Ctrl-C stops cleanly
./install.sh             # LaunchAgent: starts at login, restarts on crash; log ~/Library/Logs/com.bitofant.pa.log
./install.sh --uninstall
```

Settings live in `~/Library/Application Support/com.bitofant.pa/config.json`. `pa run` re-reads the file every minute:

- `workCalendars`: calendars whose events label recordings, as `Name` or `Source/Name` (copy them from `pa calendars`). If this is empty, every recording is ad-hoc, so titles from personal events never reach the server.
- `ignoreMicApps`: bundle ids whose mic use doesn't mean "in a call". The log names the processes holding the mic whenever that changes.
- `keepAudioDays`: keep the audio this many days after transcription, in `recordings/kept/`. Off by default.

Recordings sit in `recordings/` (`<id>-mic.wav`, `<id>-system.wav`, `<id>.json`) until they are transcribed. If `pa` is killed mid-recording, the next start transcribes what was saved. A transcription that fails 3 times is left there and listed by `pa queue`. Only one `pa run` records at a time: a second one waits until the first exits. `pa run --no-record` only uploads the queue.

Grant permissions before installing the LaunchAgent, because macOS only prompts for an interactive launch: run `./pa calendars` and `./pa test-capture --seconds 5`, then `./pa run` once.

`osx/pa` launches `test-capture`, `run` and `calendars` through `open`, so the permission prompts belong to PA. If you run the binary directly from a terminal, macOS attributes them to the terminal app instead. Under `open`, `osx/pa` always exits 0, so read the output for errors.
