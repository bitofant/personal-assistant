# AGENTS.md

This file provides guidance to coding agents (Claude Code, pi, …) when working with code in this repository.

**Everything in AGENTS.md must be extremely terse: bulleted lists, not paragraphs, as concise and token-efficient as possible.**

**Keep this file correct: update it when details change, and add genuinely important architectural decisions as they're made.**

**Code comments must be extremely terse too: short one-liners explaining *why*, never restating the code. No prose blocks, no redundant JSDoc.**


## Personal Agent
The repo has a few components:
- server:
  - intended to run on linux
  - multi-tenant
    - have a gitignored `config.json` that stores names of enabled accounts
    - registration is fine, but account is disabled initially
    - admin must add username to config.json before a new user can sign in
    - every user has their own set of data; no data is shared between users
  - nodejs (typescript) backend, serves frontend
  - connects to configurable LLM (openAI-like; assume there is a "free" local model in vLLM or llama.cpp, and allow configuring additional paid APIs, e.g. openAI, baseten, openrouter)
  - provides a way to access raw transcripts
  - adds summaries for transcripts
    - allow adding custom instructions for types of meetings (e.g. 1on1 meetings) or specific recurring meetings
  - makes transcripts "searchable" (TBD what that means, maybe vector search, and then ask the LLM to read the first )
  - may add features like 
- osx:
  - background task for MacOS
  - targeting apple silicon (e.g. MacBook M5 Pro)
  - pairs with an account in the backend
    - asks for an account name
    - generate bearer token
    - call special server POST endpoint with account name as payload and bearer token header
    - server stores bearer token (with timestamp)
  - reads work calendar to be aware of meeting times and participants
  - transcribes all meetings, tries to identify speakers
  - uploads transcripts to server, with info like calendar name, participants, ...

## Project state
- Spec only; nothing scaffolded yet.
- Monorepo: `server/` (Node backend), `web/` (React frontend), `shared/` (TS wire types), `osx/` (headless Swift CLI).
- Linux dev box can't build `osx/`; osx work is built/tested on the Mac.
- `README.md` = user/contributor onboarding; `AGENTS.md` = agent guidance. Keep both current.

## Commands (planned)
- `npm run dev` (tsx watch + Vite middleware), `npm run build` (frontend → `dist/web`), `npm start`.
- `npm test`, `npm run test:watch`, `npm run test:e2e`, `npm run typecheck`.
- osx: `swift build` / `swift test` in `osx/`; `osx/build.sh` (signed `.app` bundle); `osx/install.sh` (LaunchAgent).

## Working practices
- **AGENTS.md hygiene:** record settled decisions + their *why*; mark sections `(settled)` / `(planned, not built)`. Non-obvious fix → note the bug it prevents + "don't regress/simplify". Facts about external tools/APIs checked by running them → say "verified live"; don't trust docs alone.
- **Git:** one branch + PR per change, squash-merged (`Title (#N)`), imperative titles. Never commit on the default branch directly. Commit/push only when asked.
- Scratch notes (`plan.md`, `research.md`, `temp.md`, `pr-description.md`) are gitignored — use them freely, never commit.
- **Config:** everything in gitignored `config.json`; shape in `config.example.json`; `./config-gen.sh` = interactive generator. **No env vars, no `.env`.** Secrets live only in `config.json` (server) / Keychain (osx).
- `data/` (SQLite, uploads) and `dist/` gitignored.
- **Tests:**
  - `npm test` = pure + fast: no processes, network, LLM tokens. Co-located `*.test.ts`.
  - Anything needing a live endpoint/process = `*.e2e.test.ts` via `npm run test:e2e`; self-skips when endpoint down; runs serially (one local LLM).
  - **Pure parse ⟂ impure I/O:** logic as pure functions (`parseX`, `buildPrompt`, `resolveInstructions`) unit-tested; thin `readX`/`fetchX` wrappers covered by e2e.
  - **TDD for new contracts** (API endpoints, wire types, job types): draft test → implement → run live, adjust test to real behavior → only then build UI.
  - Mutation-check key tests: break the code, confirm the test fails.
  - LLM tests: deterministic assertions (our parsing/plumbing) are the hard gate; model-quality checks are soft.
- `npm run typecheck` must pass before PR; test files excluded from typecheck (Vitest runs them).
- **Single source of truth:** shared types in `shared/`; one render/format function used everywhere (UI + logs) so they can't drift.
- **Boundaries:** vendor-specific code (LLM providers, ASR engines) behind one interface; core never branches on vendor. Leakage = design smell.
- **Canonical identities:** normalize (emails, names, paths, ids) at the persistence boundary, never per call site.
- **Missing ≠ zero:** unknown values are `null` and render as `—`, never fake 0.
- **Optional features fail safe:** LLM/embedding outage degrades features, never blocks ingest or loses data.
- **Agents never restart/redeploy the running service** (`restart.sh`, `systemctl`); ask the user.

## Server tech (borrowed from `../agent-remote`)
- TypeScript everywhere, ESM (`"type":"module"`).
- Server **never compiled**: `tsx server/index.ts`; `tsx watch` for dev. Only frontend built (Vite → `dist/web`).
- Frontend: React + Vite, served by the same Node process on one port (Vite middleware in dev via `--dev` flag).
- HTTP: plain `node:http` (+ `ws` only if live updates needed). No framework unless it earns its keep.
- DB: SQLite via `better-sqlite3` (sync, simple, single file, no daemon).
- Tests: Vitest (see Working practices).
- Deploy: systemd **user** service; `install-service.sh`, `start.sh`/`stop.sh`/`restart.sh`/`rebuild.sh`. `Restart=always`, `StartLimitIntervalSec=0`. Rebuild stages to `dist/web.next` then atomic swap.
- Server resilience: `uncaughtException`/`unhandledRejection` log-and-continue; static serving try/catch → 503.
- Markdown rendering: `marked`, raw HTML escaped.

## Server design
- **Auth (web):** `server/auth.ts` owns all of it; rest of server only calls `authedUser(req)`.
  - scrypt (`salt:hash`), server-side sessions in SQLite, HttpOnly cookie.
  - Signup allowed; login refused unless username in `config.json` `users` (enabled list). Re-read config on change.
- **Multi-tenancy = per-user DB file.** `data/app.db` (users, auth sessions, devices) + `data/users/<userId>.db` (all user content). Isolation by construction, not by `WHERE user_id`. Easy per-user export/delete.
- **Device pairing (osx):**
  - Client generates random bearer token, `POST /api/devices/pair {account, deviceName}` with `Authorization: Bearer`.
  - Server stores **sha256 of token** (never plaintext) + created/last-used timestamps.
  - ⚠️ Pairing is **pending until approved** in the web UI (short code shown on both sides) — otherwise anyone knowing a username could push data into that account.
  - Device tokens only authorize device API (`/api/device/*`), never the web UI. Revocable from web UI.
- **Transcript ingest:** `POST /api/device/transcripts`, idempotent on client-generated `id` (uuid; re-upload = upsert).
  - Payload: meeting meta (`calendarName`, `eventId`, `seriesId` for recurring, title, start/end, organizer, attendees `{name,email}`), segments `[{start,end,speaker,text}]`, asr/diarization model ids, device id.
  - Raw transcript stored verbatim; derived data (summary, chunks, embeddings) regenerable from it.
- **LLM:** `server/llm.ts`, OpenAI-compatible only (`/v1/chat/completions`, `/v1/embeddings`).
  - `config.json` `llm.providers[]` `{id, baseUrl, apiKey?, models[]}`; default = local vLLM/llama.cpp (free).
  - Per-task routing `llm.tasks {summary, search, embed} → provider/model`; paid providers opt-in per task.
  - Best-effort/fail-safe: health via `/models`, unavailable → job stays queued, never lost.
- **Background jobs:** SQLite-backed queue (summarize, chunk+embed), retried with backoff; survives restart.
- **Summaries:** custom instructions resolved most-specific-wins: recurring series (`seriesId`) > meeting type (e.g. `1on1`) > default. Meeting type by rule first (2 attendees → 1on1), LLM classify fallback. Store which instructions/model produced each summary; re-summarize on demand.
- **Search:** hybrid — SQLite FTS5 (keywords/names) + `sqlite-vec` (embeddings of ~1-min transcript chunks) → merge/rerank → optional LLM answer citing chunks (RAG).
- **Wire contract:** `shared/api.ts` is source of truth; Swift `Codable` mirrors it. JSON fixtures in `shared/fixtures/` decoded by tests on both sides to catch drift.

## osx tech (decisions)
- **Headless — no UI.** Swift 6 CLI `pa`; runs as a background process. Swift because audio taps, EventKit, CoreML ASR are native-only.
- Min **macOS 26**, Apple Silicon only (arm64).
- **Toolchain: Command Line Tools only** (`xcode-select --install`); no Xcode project/IDE. SwiftPM package in `osx/` (`Package.swift`).
- **Minimal `.app` bundle, still headless** — why: TCC (mic/system audio/calendar) grants attach to a signed bundle id + `Info.plist` usage strings; bare binaries under launchd get flaky/misattributed prompts.
  - `osx/build.sh`: `swift build -c release` → assemble `PA.app/Contents/{Info.plist,MacOS/pa}` → codesign.
  - `Info.plist`: `LSBackgroundOnly`=true (no Dock/menu bar/window); `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, `NSCalendarsFullAccessUsageDescription`.
  - **Sign with a stable self-signed code-signing cert** (Keychain Access → Certificate Assistant). Ad-hoc signing changes identity every build → TCC re-prompts/stale grants. No paid Apple dev account.
- **CLI subcommands:** `pa pair <server> <account>` (prompts, shows pairing code), `pa status`, `pa run` (daemon mode), `pa test-capture` (spike, below).
- **Autostart:** LaunchAgent `~/Library/LaunchAgents/<bundle id>.plist` (`RunAtLoad`, `KeepAlive`) running `PA.app/Contents/MacOS/pa run`; installed by `osx/install.sh`. **First run manually** so TCC prompts appear.
- **Calendar:** EventKit (reads whatever accounts macOS Calendar syncs: Exchange/Google/iCloud). Config picks which calendars are "work". No direct Graph/Google API.
- **Audio capture — two streams, kept separate** (no BlackHole/virtual driver):
  - Mic: `AVAudioEngine`, **voice processing on** (`setVoiceProcessingEnabled`) for echo cancellation.
  - System audio: Core Audio **process taps** (`AudioHardwareCreateProcessTap`, macOS 14.2+). Permission = "System Audio Recording Only" (not Screen Recording); no public API to pre-check — prompt fires on first tap.
  - Tap scope: meeting-app processes (Zoom). Browser meetings: audio comes from browser helper processes → tap whole browser; global tap as fallback (picks up notification sounds/music).
  - Mic = local user (free speaker ID). ⚠️ On laptop speakers, mic also hears remotes → duplicate text attributed to me; AEC + dropping mic segments that duplicate system-stream text.
  - Status: **not verified live yet.** First osx milestone = `pa test-capture` spike: 30s Zoom tap + mic → two WAVs; confirms permissions + bundle/signing approach before building on it.
- **Meeting detection:** calendar event window AND (mic in use via `kAudioDevicePropertyDeviceIsRunningSomewhere` OR meeting app running: Zoom/Teams/Webex/browser Meet). Ad-hoc calls without event still recorded (no calendar meta).
- **Transcription:** on-device, behind a `Transcriber` protocol.
  - Default: **FluidAudio** (CoreML/ANE) Parakeet TDT v3 (multilingual, fast).
  - Fallback/alt: Apple `SpeechAnalyzer`/`SpeechTranscriber` (macOS 26); WhisperKit if accuracy on a language demands it.
- **Speaker ID:** FluidAudio diarization on system stream → clusters. Naming: per-user voice embeddings of known speakers (labeled in web UI), matched against calendar attendees; unknown → `Speaker N`. Server-side LLM may propose names from context; never overwrite a user label.
- **Storage/queue:** audio + pending uploads in `~/Library/Application Support/<bundle id>/`; persistent upload queue with retry (offline-safe). Raw audio deleted after successful upload (configurable retention).
- **Secrets:** bearer token in Keychain; non-secret settings (server URL, work calendars, retention) in `~/Library/Application Support/<bundle id>/config.json`.
- Networking: `URLSession`, HTTPS only (except localhost).
- Logging: `os.Logger` (subsystem = bundle id) + log file in `~/Library/Logs/`.
- Tests: Swift Testing (`swift test`); decode `shared/fixtures/` JSON.
