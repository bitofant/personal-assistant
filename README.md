# personal-assistant

Self-hosted meeting assistant. A headless macOS agent records and transcribes your meetings on-device and uploads the transcripts. A Linux server then stores, summarizes and searches them using a local (or opt-in paid) LLM.

- `server/`: Node/TypeScript backend (plain `node:http`, SQLite); also serves the web UI
- `web/`: React + Vite frontend
- `shared/`: wire types (`api.ts`) + JSON fixtures shared with the Swift client
- `osx/`: headless Swift CLI `pa` (early spike: audio capture test)

Status: early. The server supports:
- web accounts (sign up, then an admin enables the account)
- pairing a Mac as a device (you approve it with a 6-digit code)
- transcript upload from a paired device
- a web UI to browse transcripts
- LLM summaries of uploaded transcripts, made in a background job queue and shown on the transcript page (with progress, retry-after-outage and failure status, and a re-summarize button); `GET /api/llm/status` shows whether each LLM task is reachable. Jobs of disabled users wait until they're re-enabled.

Search isn't built yet. See `AGENTS.md` for the design and roadmap.

Data lives in `data/` (gitignored): `app.db` holds accounts, sessions, devices and the job queue, and `users/<id>.db` holds one user's transcripts.

## Server setup (Linux)

Requirements: Node 22+.

```sh
npm install
./config-gen.sh        # writes config.json (gitignored); see config.example.json
npm run dev            # http://localhost:4200, Vite HMR on the same port
```

All configuration is in `config.json`. There are no env vars.

- `users`: usernames allowed to log in. Anyone can register, but an account is disabled until it's listed here. The server reloads `config.json` automatically, so you don't need to restart it. Removing a username logs that user out right away and blocks their devices.
- `llm.providers`: OpenAI-compatible endpoints (local vLLM/llama.cpp, OpenRouter, …).
- `llm.tasks`: routes `summary` / `search` / `embed` to a provider+model. If a task isn't routed, that feature is off. Jobs that need it wait in the queue until you route it.

### Production (systemd user service)

```sh
./install-service.sh   # builds dist/web if missing, installs + starts the unit
./restart.sh           # rebuild frontend (atomic swap) + restart
./start.sh dev / ./stop.sh   # run the dev server outside systemd
```

## Development

```sh
npm test               # pure unit tests (fast; no network/processes)
npm run test:e2e       # HTTP flow on an in-process server, plus live tests that skip themselves if the server/LLM is down
npm run typecheck      # must pass before a PR
```

## macOS agent (`osx/`)

Requirements: Apple Silicon, macOS 26, Command Line Tools (`xcode-select --install`). You don't need Xcode.

One-time setup: create a self-signed code-signing certificate named `PA Local Signing`. In Keychain Access, go to Certificate Assistant → Create a Certificate…, then pick Identity Type "Self Signed Root" and Certificate Type "Code Signing". Permission grants stick to this signing identity, so they survive rebuilds.

```sh
cd osx
swift test             # pure unit tests
./build.sh             # → build/PA.app (signed, headless)
open -W --stdout $(tty) --stderr $(tty) build/PA.app --args test-capture --seconds 30
```

`test-capture` records all system audio through a global Core Audio tap, plus your mic, into two WAVs in `~/pa-test-capture/`. It then prints peak/RMS levels for each stream. If a stream is flagged "all zeros", the permission was probably denied. Check System Settings → Privacy & Security → Microphone / Screen & System Audio Recording. It prints a progress line every second, so you can see when a stream stops advancing. To isolate a problem, use `--no-mic` or `--no-system` to record one stream only.

To record from a mic other than the system default, run `osx/pick-mic.sh`. It lists the input devices, lets you pick one by number, and saves the choice to `~/Library/Application Support/com.bitofant.pa/config.json`, where later runs pick it up. Choose `0` to go back to the system default. If the saved mic is unplugged, `pa` falls back to the system default.

Launch it with `open` as shown. If you run the binary directly from a terminal, macOS attributes the permission prompts to the terminal app instead of PA.
