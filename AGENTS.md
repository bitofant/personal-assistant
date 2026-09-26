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
- Server scaffold (settled): config loading/validation, `GET /api/health`, static/Vite serving, systemd scripts.
- Server (built): SQLite store, web auth, device pairing + approval, transcript ingest/list/detail, minimal web UI, LLM client + job queue, summaries (+ web view with job status).
- osx: `pa test-capture` spike runs on the Mac; Zoom tap + mic (no VP) record (verified live).
- Everything else below = planned, not built.
- Default port **4200** (4000/4100 taken on the dev box by other services).
- Monorepo: `server/` (Node backend), `web/` (React frontend), `shared/` (TS wire types), `osx/` (headless Swift CLI).
- Linux dev box can't build `osx/`; osx work is built/tested on the Mac.
- `README.md` = user/contributor onboarding; `AGENTS.md` = agent guidance. Keep both current.

## Roadmap (next up, in order)
- Order = riskiest unknowns first, then thinnest end-to-end slice (Mac audio → server transcript), then value-add. Tick off / reorder as done.
1. **osx: finish `pa test-capture` on the Mac** — Zoom tap + mic done (verified live); still: global tap (now the only mode) live run, listen to WAVs. Record findings "verified live".
2. **osx: transcription spike** — FluidAudio Parakeet v3 + diarization on spike WAVs → `[{start,end,speaker,text}]`; check speed/accuracy. Behind `Transcriber` protocol.
3. **osx: `pa pair` / `pa status`** — Keychain token, app-support `config.json`, poll `/api/device/me`; Swift `Codable` mirrors of `shared/api.ts` + fixture decode tests.
4. **osx: `pa upload <wav-dir>`** — manual transcribe + upload → first real end-to-end transcript on server.
5. ~~**server: LLM client + job queue**~~ — done (see Server design → LLM / Background jobs).
6. **server: summaries** — built: summarize job on upload, 1on1 rule, built-in per-type instructions, stored model/instructions, stale flag, re-summarize API, web summary panel. Left: custom instructions (series > type > default; table + API + web UI), LLM classify fallback, long-transcript chunking (map-reduce) if context overflows.
7. **server: search v1** — FTS5 over segments/titles/attendees; web search page. Then v2: chunk+embed w/ `sqlite-vec`, hybrid merge, optional RAG answer.
8. **osx: daemon (`pa run`)** — EventKit work calendars, meeting detection, auto capture → transcribe → persistent upload queue, raw-audio retention; `osx/install.sh` LaunchAgent; `os.Logger` + log file.
9. **Speaker naming** — label speakers in web UI, per-user voice embeddings, match vs attendees; LLM name proposals never overwrite user labels.
10. **Ops/polish** — per-user export/delete, device list/revoke UI polish, backups of `data/`.

## Commands
- `npm run dev` (tsx watch + Vite middleware), `npm run build` (frontend → `dist/web`), `npm start`.
- `npm test`, `npm run test:watch`, `npm run test:e2e`, `npm run typecheck`.
- `./config-gen.sh`, `./install-service.sh`, `./start.sh [dev]`, `./stop.sh`, `./restart.sh`, `./rebuild.sh`.
- osx: `swift build` / `swift test` in `osx/`; `osx/build.sh [identity]` → signed `osx/build/PA.app`; `osx/install.sh` (LaunchAgent, planned); `osx/pick-mic.sh` (numbered mic picker).
- Run bundle: `open -W --stdout $(tty) --stderr $(tty) osx/build/PA.app --args test-capture`.

## Working practices
- **AGENTS.md hygiene:** record settled decisions + their *why*; mark sections `(settled)` / `(planned, not built)`. Non-obvious fix → note the bug it prevents + "don't regress/simplify". Facts about external tools/APIs checked by running them → say "verified live"; don't trust docs alone.
- **Git:** ⚠️ **never commit, create/switch branches, or push** — leave changes uncommitted on the current branch. agent-remote's auto-PR does branch (`joran/…`) + commit + push + PR. PRs are squash-merged (`Title (#N)`), imperative titles.
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
- ⚠️ **Never `pkill -f "tsx server/index.ts"`**: matches sibling services on this box (agent-remote, git-observer) and the agent's own shell. Kill by PID (`$!`) only.
- Live smoke test without touching repo `config.json`/`data/`: scratch dir with symlinks to repo + own `config.json` on a spare port. Stop it via `lsof -ti:<port> -sTCP:LISTEN` (the `$!` PID is only the tsx wrapper).
- Browser checks: no chromium-cli/system Chrome on dev box; Playwright installed in `/tmp/pw` (outside repo, not a dependency), `chromium.launch({args:["--no-sandbox"]})` works (verified live).

## Server tech (borrowed from `../agent-remote`)
- TypeScript everywhere, ESM (`"type":"module"`).
- Server **never compiled**: `tsx server/index.ts`; `tsx watch` for dev. Only frontend built (Vite → `dist/web`).
- Frontend: React + Vite, served by the same Node process on one port (Vite middleware in dev via `--dev` flag).
- HTTP: plain `node:http` (+ `ws` only if live updates needed). No framework unless it earns its keep.
- DB: SQLite via `better-sqlite3` (sync, simple, single file, no daemon).
- Tests: Vitest (see Working practices).
- Deploy: systemd **user** service; `install-service.sh`, `start.sh`/`stop.sh`/`restart.sh`/`rebuild.sh`. `Restart=always`, `StartLimitIntervalSec=0`. Rebuild stages to `dist/web.next` then atomic swap.
- Server resilience: `uncaughtException`/`unhandledRejection` log-and-continue; static serving try/catch → 503.
- Markdown rendering (built): `shared/markdown.ts` `renderMarkdown` = the only Markdown→HTML path. LLM output is untrusted (speech can prompt-inject): raw HTML escaped, links only http(s)/mailto (`target=_blank rel=noopener`), images → alt text (no remote loads). Don't loosen.

- **Config (settled):** `server/config.ts` `parseConfig` (pure, tested) validates + normalizes (usernames lowercased/trimmed, baseUrl trailing `/` stripped, empty apiKey → `null`); `loadConfig` = thin file wrapper. Unrouted `llm.tasks.X` = feature off, not an error. Task → unknown provider = startup error.
- **Static serving:** `resolveStaticPath` must stay `startsWith(root + sep)` (bare `startsWith(root)` lets `dist/web.prev` through); traversal → SPA fallback, never a file outside root.
- **Toolchain versions:** TypeScript 7 (native `tsc`), Vite 8, React 19, Vitest 4, Node 25 on dev box.

## Server design
- **Layout (settled):** `app.ts` `createApp({dataDir,getConfig,version,now})` = route table + all API handlers; `index.ts` = config watch, Vite/static, listen. Handlers throw `HttpError`; router → JSON error, unknown → 500 logged.
  - `api.e2e.test.ts` runs `createApp` in-process on port 0 + temp dir: full HTTP flow, never self-skips.
  - Injected `now()` everywhere for expiry tests.
- **Auth (web, built):** `server/auth.ts` owns all of it; rest of server only calls `authedUser(req)`/`requireUser`.
  - scrypt (`salt:hash`), server-side sessions in SQLite (sha256 of token), HttpOnly SameSite=Lax cookie `pa_session`, 30d sliding.
  - Signup allowed; login refused (403, only after password OK) unless username in `config.json` `users`.
  - `config.json` polled (`watchFile`) and reloaded live; invalid edit → keep previous config.
  - Enabled check **per request**, not just at login: removing a user cuts off sessions + devices immediately. Don't regress.
  - CSRF: SameSite=Lax + `readJson` requires `content-type: application/json` (415 otherwise).
- **Multi-tenancy = per-user DB file.** `data/app.db` (users, auth sessions, devices) + `data/users/<userId>.db` (all user content). Isolation by construction, not by `WHERE user_id`. Easy per-user export/delete.
  - `Store.user(id)`: path from integer id only, never user input. Migrations = append-only SQL list per DB, `PRAGMA user_version`.
- **Device pairing (osx, built):**
  - Client generates random bearer token (≥32 chars), `POST /api/devices/pair {account, deviceName}` with `Authorization: Bearer` → 202 `{deviceId, status, pairingCode, expiresAt}`. Same token re-pair = idempotent.
  - Server stores **sha256 of token** (never plaintext) + created/approved/last-used timestamps.
  - ⚠️ Pairing is **pending until approved**: user **types** the 6-digit code shown on the Mac into the web UI (web never shows the code). Otherwise anyone knowing a username could push data into that account.
  - Wrong code deletes the pending pairing (no brute force). Pending expires after 15 min; max 5 pending/user, oldest evicted (pair is unauthenticated).
  - `GET /api/device/me` works while pending (client polls for approval); every other `/api/device/*` needs active.
  - Device tokens only authorize device API (`/api/device/*`), never the web UI. Revoke = `DELETE /api/devices/:id`.
- **Transcript ingest (built):** `POST /api/device/transcripts`, idempotent on client-generated `id` (uuid; re-upload = upsert; 201 created / 200 replaced). Body limit 20 MB.
  - Payload (`TranscriptUpload`): recording `startedAt/endedAt`, `meeting` (null = ad-hoc; `calendarName`, `eventId`, `seriesId`, title, start/end, organizer, attendees `{name,email}`), segments `[{start,end,speaker,text}]` (seconds from recording start), asr/diarization model ids. Device id comes from the token, not the payload.
  - `parseTranscriptUpload` normalizes: lowercase uuid + emails, timestamps → UTC ISO (zone required), blank → null, all-null people dropped. Fixture: `shared/fixtures/transcript-upload.json`.
  - Stored: `raw` (body verbatim) + `data` (normalized JSON) + index columns. Ad-hoc `attendee_count` = null, not 0.
  - Derived data (summary, chunks, embeddings) regenerable from raw.
  - `updated_at` = content last changed: identical re-upload (device retry) keeps it and returns `changed:false` → no re-summarize, summary not stale. Don't make it bump on no-op uploads.
- **Formatting:** `shared/format.ts` (`formatDateTime`, `formatDuration`, `formatOffset`, `formatValue`; missing → `—`) used by UI and logs.
- **LLM (built):** `server/llm.ts`, OpenAI-compatible only (`/chat/completions`, `/embeddings`, `/models`); `createLlm({getConfig})` reads config per call (live reload).
  - `config.json` `llm.providers[]` `{id, baseUrl, apiKey?, models[]}`; default = local vLLM/llama.cpp (free). Per-task routing `llm.tasks {summary, search, embed}`; paid providers opt-in per task.
  - Pure parsers (`parseChatResponse`, `parseEmbeddingsResponse`, `errorMessage`, …) unit-tested with fake fetch; `llm.e2e.test.ts` = fake provider down→503→up (never skips) + live local LLM (config.json route, else probes `localhost:8000/v1`; self-skips).
  - `LlmError.retryable`: network/timeout/408/409/429/5xx/non-JSON reply/**unrouted task** = true (outage → job waits); other 4xx / malformed reply = false.
  - Strips leading `<think>…</think>` (reasoning models). Embeddings batched (64), reordered by `index`.
  - Health: `GET /api/llm/status` (session) → per task `{ok, provider, model, modelListed, error}`; model missing from `/models` = not ok (common misconfig).
  - vLLM reply/error shapes verified live (`{error:{message}}`, FastAPI `{detail}`); vLLM on dev box has no embedding model → embed live test skips.
- **Background jobs (built):** `server/jobs.ts` `JobQueue` (SQLite) + `JobRunner` (one job at a time: one local LLM). Started in `createApp`; handlers registered in `app.ts` `defaultJobHandlers`.
  - **Disabled users skipped:** `claimNext`/`nextRunAt` filter by `config.users` (read per claim) → no tokens spent; jobs stay queued untouched, resume when re-enabled (≤60s idle poll). `nextRunAt` must filter too, else an overdue disabled job makes the runner spin.
  - Table in **app.db** (not per-user DB) so one worker scans all users; payload = refs only (ids), never content. `user_id` FK cascade.
  - Dedupe on `(user_id, type, key)`: re-enqueue revives row (new payload, counters reset, `generation+1`). Settle only `WHERE generation = claimed AND status='running'` → re-upload mid-run re-runs, never lost. Don't drop the guard.
  - Retries: exponential backoff (30s→1h cap, no jitter). `isRetryable` duck-typed (`err.retryable === true`) so queue never imports LLM code. Outages never count toward `maxFailures` (5) → never `failed`; `failed` row kept, re-enqueue revives.
  - Crash: `recover()` at start requeues `running`. Shutdown: `app.close()` is async, aborts handler signal, `release()`s job (attempt not counted) before DB close.
- **Summaries (built, partial):** `server/summaries.ts`; job `summarize`, key = transcript id, payload null.
  - Enqueued on upload if content `changed` or never queued (backfill); `POST /api/transcripts/:id/summarize` (body `{}`, JSON content-type = CSRF guard) forces re-run → 202 `{summaryJob}`.
  - `GET /api/transcripts/:id` adds `summary` (`stale` = transcript changed since) + `summaryJob` (`JobState`). `GET /api/transcripts/:id/summary` = same two fields without segments (UI poll target; don't poll the full detail).
  - Web `SummaryPanel`: pure `web/summaryState.ts` `summaryStatusView(job, hasSummary)` → message/tone/poll/button (unit-tested); polls 2s while queued/running, 15s while waiting out a backoff (queued + `lastError`), stops on done/failed. Button: Summarize / Re-summarize / Retry, disabled in progress.
  - UI states verified live in headless Chromium (done, generating, LLM down → waiting → auto-recovered ~30s); `failed` + never-queued only unit-tested.
  - Meeting type by rule: no event = `adhoc`, 2 attendees = `1on1`, else `meeting`. Instructions: built-in per type (`builtin:<type>`); planned custom resolution series > type > default, LLM classify fallback.
  - Prompt: system = common rules (transcript language, Markdown, no invention, ASR caveats) + instructions; user = metadata + `[m:ss] Speaker: text` (same-speaker runs merged). No `max_tokens`; `finish_reason=length` / empty = non-retryable error.
  - Stored in per-user `summaries` (one row per transcript): text, type, instructions source + text, provider/model, token usage (null if unknown), `transcript_updated_at`.
  - Handler: missing transcript = done (no-op); LLM outage/unrouted `summary` task = retryable → job waits.
  - Live on dev box (gemma-4-31B via vLLM): fixture summary correct, ~0.6s (verified live).
- **Search:** hybrid — SQLite FTS5 (keywords/names) + `sqlite-vec` (embeddings of ~1-min transcript chunks) → merge/rerank → optional LLM answer citing chunks (RAG).
- **Wire contract:** `shared/api.ts` is source of truth; Swift `Codable` mirrors it. JSON fixtures in `shared/fixtures/` decoded by tests on both sides to catch drift.

## osx tech (decisions)
- **Headless — no UI.** Swift 6 CLI `pa`; runs as a background process. Swift because audio taps, EventKit, CoreML ASR are native-only.
- Min **macOS 26**, Apple Silicon only (arm64).
- **Toolchain: Command Line Tools only** (`xcode-select --install`); no Xcode project/IDE. SwiftPM package in `osx/` (`Package.swift`).
- Targets: `PACore` (pure: arg parsing, level meter; unit-tested) ⟂ `pa` (thin Core Audio/AVFoundation wrappers; tested by running on the Mac).
- Bundle id **`com.bitofant.pa`**; default signing identity name `PA Local Signing`.
- No swift-argument-parser: too few flags.
- **Minimal `.app` bundle, still headless** — why: TCC (mic/system audio/calendar) grants attach to a signed bundle id + `Info.plist` usage strings; bare binaries under launchd get flaky/misattributed prompts.
  - `osx/build.sh`: `swift build -c release` → assemble `PA.app/Contents/{Info.plist,MacOS/pa}` → codesign.
  - `Info.plist`: `LSBackgroundOnly`=true (no Dock/menu bar/window); `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, `NSCalendarsFullAccessUsageDescription`.
  - **Sign with a stable self-signed code-signing cert** (Keychain Access → Certificate Assistant). Ad-hoc signing changes identity every build → TCC re-prompts/stale grants. No paid Apple dev account.
  - No hardened runtime (would need audio-input entitlement; no notarization anyway).
  - ⚠️ TCC attributes to the *responsible* process: bare `PA.app/Contents/MacOS/pa` from Terminal → grants go to Terminal. Launch via `open`/launchd. (Expected; confirm in spike.)
- **CLI subcommands:** `pa pair <server> <account>` (prompts, shows pairing code), `pa status`, `pa run` (daemon mode), `pa test-capture` (spike, below), `pa mics` / `pa set-mic (UID|--default)` (built).
- **Mic selection (built, device switch not verified live):** persisted as Core Audio device **UID** (stable; object ids aren't) in app-support `config.json` `micDeviceUID`; nil/unplugged → system default.
  - `pa mics` = TSV `uid\tname\tflags` (pure `formatMicLine`), parsed by bash-3.2 `osx/pick-mic.sh`. Bare binary OK: enumeration needs no TCC.
  - Applied via `kAudioOutputUnitProperty_CurrentDevice` on inputNode's unit; device read back and printed (ground truth).
- **Autostart:** LaunchAgent `~/Library/LaunchAgents/<bundle id>.plist` (`RunAtLoad`, `KeepAlive`) running `PA.app/Contents/MacOS/pa run`; installed by `osx/install.sh`. **First run manually** so TCC prompts appear.
- **Calendar:** EventKit (reads whatever accounts macOS Calendar syncs: Exchange/Google/iCloud). Config picks which calendars are "work". No direct Graph/Google API.
- **Audio capture — two streams, kept separate** (no BlackHole/virtual driver):
  - **Headphones assumed → no echo handling at all** (user decision). Mic: plain `AVAudioEngine`, **no voice processing** — VP mic = all zeros on every live run, even without a tap (verified live); VP code removed, don't re-add.
  - System audio: Core Audio **process taps** (`AudioHardwareCreateProcessTap`, macOS 14.2+). Permission = "System Audio Recording Only" (not Screen Recording); no public API to pre-check — prompt fires on first tap.
  - **Tap scope: always global** (user decision: no interfering audio ever plays). No per-app targeting/bundle-id matching; covers Zoom/browser/anything. No self-exclusion (pa plays nothing).
  - Mic = local user (free speaker ID).
  - Status: **Zoom-only tap + mic verified live**; global tap not yet. `pa test-capture [--seconds N] [--out DIR] [--no-mic] [--no-system]`: tap + mic → two WAVs in `~/pa-test-capture/` (not ~/Desktop: extra TCC prompt) + per-second progress + peak/RMS + callback stats.
  - First live run (Zoom settings dialog, test sound, VP on): tap got only 0.5s of 30s; not reproduced since.
  - Second live run (Zoom, QuadCast S mic, External Headphones): tap IOProc delivered **2 buffers/callback** for a 2 ch interleaved tap → `AVAudioPCMBuffer(bufferListNoCopy:)` failed every callback (verified live). Now copy the last matching buffer / interleave mono buffers; stats print buffer layout + per-buffer peak. Don't go back to assuming 1 buffer.
  - Creating the tap aggregate fires `AVAudioEngineConfigurationChange` on the mic engine → engine stops (verified live) → now restarted in the observer.
  - Third live run (Zoom, QuadCast S, External Headphones, no VP): tap + mic both record (verified live).
  - Aggregate clocked by default **output** device (where meeting plays), not the system/alert-sound device.
  - Tap = `CATapDescription` (global, no exclusions, `muteBehavior=.unmuted`, private) → private aggregate device (default output as main sub-device, tap auto-start) → IOProc block → `AVAudioFile`.
  - Denied system-audio permission = **silent buffers, no error** → summary flags all-zero streams. Don't drop this check.
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
