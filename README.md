# personal-assistant

Self-hosted meeting assistant. A headless macOS agent records and transcribes your meetings on-device and uploads the transcripts. A Linux server then stores, summarizes and searches them using a local (or opt-in paid) LLM.

- `server/`: Node/TypeScript backend (plain `node:http`, SQLite); also serves the web UI
- `web/`: React + Vite frontend
- `shared/`: wire types (`api.ts`) + JSON fixtures shared with the Swift client
- `osx/`: headless Swift CLI `pa` (early spike: audio capture test)

Status: early scaffold. Right now the server only answers `GET /api/health` and serves the web shell. See `AGENTS.md` for the design and roadmap.

## Server setup (Linux)

Requirements: Node 22+.

```sh
npm install
./config-gen.sh        # writes config.json (gitignored); see config.example.json
npm run dev            # http://localhost:4200, Vite HMR on the same port
```

All configuration is in `config.json`. There are no env vars.

- `users`: usernames allowed to log in. Anyone can register, but an account is disabled until it's listed here.
- `llm.providers`: OpenAI-compatible endpoints (local vLLM/llama.cpp, OpenRouter, …).
- `llm.tasks`: routes `summary` / `search` / `embed` to a provider+model. If a task isn't routed, that feature is off.

### Production (systemd user service)

```sh
./install-service.sh   # builds dist/web if missing, installs + starts the unit
./restart.sh           # rebuild frontend (atomic swap) + restart
./start.sh dev / ./stop.sh   # run the dev server outside systemd
```

## Development

```sh
npm test               # pure unit tests (fast; no network/processes)
npm run test:e2e       # live tests against a running server/LLM; they skip themselves if it's down
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

`test-capture` records Zoom audio through a Core Audio process tap, plus your mic, into two WAVs in `~/pa-test-capture/`. It then prints peak/RMS levels for each stream. Use `--app <bundle-id-prefix>` to tap another app (e.g. `com.google.Chrome`), or `--global` to tap all system audio. If a stream is flagged "all zeros", the permission was probably denied. Check System Settings → Privacy & Security → Microphone / Screen & System Audio Recording.

Launch it with `open` as shown. If you run the binary directly from a terminal, macOS attributes the permission prompts to the terminal app instead of PA.
