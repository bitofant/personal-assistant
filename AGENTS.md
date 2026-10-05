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
- Server (built): SQLite store, web auth, device pairing + approval, transcript ingest/list/detail/delete, minimal web UI, LLM client + job queue, summaries (+ web view with job status), custom instructions + LLM meeting-type classify + per-user summary model (settings page), search v1 (FTS5 keyword + date/attendee filters + web page), nightly SQLite backups (`npm run backup` + systemd timer), speaker names (web) + LLM name suggestions + auto speaker names (voice + calendar), per-user export + account delete (incl. backups), summary `instructionsChanged` flag, long-summary resume after outage.
- osx: `pa test-capture` spike runs on the Mac; Zoom tap + mic (no VP) record (verified live).
- osx: `pa run` daemon (detect → record → transcribe → upload) + `pa calendars` + `osx/install.sh` built 2026-09-30: PACore Linux-tested; `pa` wrappers (EventKit, Core Audio process list, libproc, capture, signals) **never compiled** → Mac session: mac-check `--only build`, `--only queue`, `--only daemon`.
- osx: `pa pair` / `pa status` / `pa transcribe --upload` / `pa queue` / `pa run` (upload worker only) verified live on the Mac (2026-09-30 mac-check, server via ssh tunnel): pair (no Keychain dialog), re-pair reuses token, upload + replace, summary + search OK, outage → retry, revoke → halt → re-pair → resume, SIGTERM exit. 410 drop not exercised on the Mac (transcript wasn't deleted before the step; server + web delete re-verified live) → redo `--only queue`.
- osx: `osx/Package.resolved` pins FluidAudio 0.17.4. #24 had committed it at the repo root, where SwiftPM ignores it; moved 2026-10-01.
- Mac session 1 (roadmap 1–4) done 2026-09-30; capture/bench/transcribe results assumed OK (user decision, report not reviewed). Daemon (8) code done, **next = Mac session 2** (verify 8) (remote access 8a done: LAN-only). Summary/search tuning waits for real transcripts.
- Spoken notes (2026-10-04): `pa note` + daemon note recording + server `kind: note` / `note` type built; PACore + server tested; `pa/Note.swift` + `Run.swift` polling **never compiled** → Mac session: `--only build`, `--only note`.
- Menu bar app + pause (2026-10-05): PACore (pause detector, `MenuStatus`, `AgentPaths`) Linux-tested; `pa-menu` (AppKit), `pa/Pause.swift`, pause polling in `Run.swift` **never compiled** → Mac session: `--only build`, `--only menu`.
- Live preview (2026-10-01): server + web built + tested (unit, api.e2e, headless Chromium); PACore pure parts Linux-tested; `pa/LiveEngine.swift` + sink plumbing **never compiled** → Mac session: `--only build`, `--only live`.
- Everything else below = planned, not built.
- Default port **4200** (4000/4100 taken on the dev box by other services).
- Monorepo: `server/` (Node backend), `web/` (React frontend), `shared/` (TS wire types), `osx/` (headless Swift CLI).
- Linux dev box can't build the `pa` target (Core Audio/Security); PACore is pure Foundation → builds + tests on Linux via `osx/test-linux.sh` (verified live). Keep PACore Linux-portable.
- `README.md` = user/contributor onboarding; `AGENTS.md` = agent guidance. Keep both current.

## Roadmap (next up, in order)
- Order = riskiest unknowns first, then thinnest end-to-end slice (Mac audio → server transcript), then value-add. Tick off / reorder as done.
1. ~~**osx: `pa test-capture` on the Mac**~~ — done (global tap assumed OK, not reviewed).
2. ~~**osx: transcription spike**~~ — FluidAudio compiles + runs on the Mac; `pa transcribe --upload` → first real transcript + summary (verified live). Bench numbers not reviewed.
3. ~~**osx: `pa pair` / `pa status`**~~ — verified live on the Mac (via ssh tunnel; https server URL pending 8a).
4. ~~**osx: end-to-end upload**~~ — done via `pa transcribe --upload` (verified live).
5. ~~**server: LLM client + job queue**~~ — done (see Server design → LLM / Background jobs).
6. **server: summaries** — built: summarize job, rule + LLM classify, built-in + custom instructions (series > type > default), per-user model pick, settings page, long-transcript map-reduce. Series type reuse, `instructionsChanged` flag, resume of part notes after an outage: done 2026-10-01. Tuning waits for real transcripts.
7. **server: search** — v1 done (FTS5 keyword + date/attendee filters, see Server design → Search). Next v2: chunk+embed w/ `sqlite-vec`, hybrid merge, optional RAG answer — blocked on real transcripts (to judge retrieval) + an embedding model on the dev box (2026-10-01: vLLM `/embeddings` 404, Ollama on :11434 has no models; verified live). Pagination skipped: >50 hits → refine with filters.
8. **osx: daemon (`pa run`)** — built, not yet compiled/run on the Mac (see osx Daemon). Left: Mac verification; then tune detection from the logs (which processes hold the mic; `ignoreMicApps` defaults?).
9. **Speaker naming** — web labels + LLM suggestions + auto naming (voice embeddings from the Mac + calendar elimination) built 2026-10-01 (see Server design → Speaker matching). Left: Mac compile/run of the FluidAudio embedding path; tune thresholds on ~10–20 real meetings with corrected names.
8a. **Remote access** — **LAN-only, built** (user decision 2026-09-30: no Tailscale on the work Mac; no public exposure because Cloudflare would see plaintext transcripts; app-layer encryption rejected because the web UI would leak them anyway). `https://assistant.riuna.com` = `~/src/webserver/nginx/conf.d/assistant.conf` → app bound to `172.17.0.1`. Details in `docs/remote-access.md`. Left: user removes the Cloudflare Tunnel route; restart to apply the bind; re-pair the Mac to the https URL. Off-LAN the Mac's uploads wait in the queue.
10. ~~**Ops/polish**~~ — per-transcript delete, per-user export + account delete (purges backups), backups, device rename + upload stats + revoke explanation: done.
11. **Live preview** (user ask: watch the transcript while recording, ≤10 s lag) — built, see Server design → Live preview + osx Live preview. Left: Mac compile + `mac-check --only live` (measured lag p50/p95, chunk-edge quality, RAM). User decisions: preview only (offline pass still makes the final transcript); live speakers = mic vs `Others` (no streaming diarization).
12. **Spoken notes** (user's day: half meetings, half solo time dictating thoughts while reading Slack) — built 2026-10-04, see osx Spoken notes + Server design → Spoken notes. Left: Mac compile + `mac-check --only note`; tune the built-in `note` instructions on real notes. Not done: live preview has no `kind` (a note's preview is titled "(ad-hoc call)").
13. **Menu bar app** — built 2026-10-05 (see osx Menu bar app); "Open live transcript" item (roadmap 11 in the menu) added 2026-10-05. Left: Mac compile + `mac-check --only menu`.

## Commands
- `npm run dev` (tsx watch + Vite middleware), `npm run build` (frontend → `dist/web`), `npm start`, `npm run backup`.
- `npm test`, `npm run test:watch`, `npm run test:e2e`, `npm run typecheck`.
- `./config-gen.sh`, `./install-service.sh`, `./start.sh [dev]`, `./stop.sh`, `./restart.sh`, `./rebuild.sh`.
- osx: `swift build` / `swift test` in `osx/`; `osx/test-linux.sh` = PACore tests on the Linux dev box (Docker `swift:6.1`; `pa` target is macOS-only in the manifest); `osx/build.sh [identity]` → signed `osx/build/PA.app` + `osx/build/PAMenu.app`; `osx/install.sh [--uninstall]` (LaunchAgents → both apps in place); `osx/pick-mic.sh` (numbered mic picker); `osx/bench-asr.sh [dir] [stamp]` (Mac: pinned `fluidaudiocli` ASR + offline diarization on a capture → `bench-<stamp>/summary.txt`); `osx/CHECKLIST.md` = first-Mac-run steps.
- `osx/pa <cmd>` = run built `pa` from anywhere. TCC cmds (`test-capture`, `run` (not `--no-record`), `calendars`) via `open -W` (cwd `/` → `--out` made absolute; output → files streamed by `tail -f` so pipes/tee work live; Ctrl-C forwarded to our pid only; exit status always 0), rest = bare binary.
- `osx/mac-check.sh [--from|--only STAGE] [--seconds N] [--server URL] [--account A] [--tunnel HOST]` = guided CHECKLIST run: stages `prereqs build capture bench transcribe pair upload queue daemon note live`; pauses for human actions, y/n(+note)/skip for judgments (plays WAVs via `afplay`), greps pa output for the rest → `~/pa-test-capture/report-<stamp>{/,.tgz}`. `--tunnel` = own `ssh -L 4200` (control socket) → cuts it for the outage test. Greps exact pa strings (`still queued`, `stopped until re-paired`, `resumed`, `dropped`, `all zeros`, `voice embeddings for N speaker`, …): changing those messages → update the script.
  - Server URL checked up front with the `parseServerURL` rule (bare `host:port` / LAN `http://` failed only at `pa pair`, first Mac run). Pair failure stops the run; upload/queue require `pa status` active. Change the rule → update `valid_server`.
  - `pa run` stopped with SIGTERM, not INT: bash starts background jobs with SIGINT ignored (verified live). `queue` stage = bare `pa run --no-record` (upload only, no TCC). `daemon` stage = `osx/pa run` (TERM to wrapper → INT to pa); greps `recording … started`, `stopped (inactive)`, `segments queued for upload`, `pa run: stopped`, `meeting apps:`.
  - `daemon` stage + `osx/install.sh`: syntax-checked only (no dry-run, no shellcheck on the box).
  - `note` stage greps `pa note: recording note`, `started: spoken note (mic only)`, `stopped, Ns`, `stopped (meetingStarted)`, `stopped (noteStopped)`, `no note recording`, `refused`, `isn't recording` (syntax-checked only).
  - `menu` stage (after `note`) asks about Open live transcript during the call; greps `recording paused`, `recording resumed`, `stopped (paused)`, `recorder: Watching for meetings` (`pa status`), `resumed` (`pa resume`); rest = human-judged icon/menu states (syntax-checked only).
  - `live` stage greps `live: streaming ASR model loaded`, `preview streaming to server`, `live <id>: done, lag p50` (syntax-checked only).

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
  - Known: `llm.e2e` "live local LLM: embeddings" fails on the dev box (vLLM answers 404 on `/embeddings` but the `embedUp` probe says up); pre-existing, not a regression.
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
- React effects: always brace bodies (`useEffect(() => { … })`); newer Chromium's `scrollIntoView` returns a Promise → arrow-expression effect crashes the component (verified live).

## Server tech (borrowed from `../agent-remote`)
- TypeScript everywhere, ESM (`"type":"module"`).
- Server **never compiled**: `tsx server/index.ts`; `tsx watch` for dev. Only frontend built (Vite → `dist/web`).
- Frontend: React + Vite, served by the same Node process on one port (Vite middleware in dev via `--dev` flag).
- HTTP: plain `node:http` (+ `ws` only if live updates needed). No framework unless it earns its keep.
- DB: SQLite via `better-sqlite3` (sync, simple, single file, no daemon).
- Tests: Vitest (see Working practices).
- Deploy: systemd **user** service; `install-service.sh`, `start.sh`/`stop.sh`/`restart.sh`/`rebuild.sh`. `Restart=always`, `StartLimitIntervalSec=0`. Rebuild stages to `dist/web.next` then atomic swap.
- Server resilience: `uncaughtException`/`unhandledRejection` log-and-continue; static serving try/catch → 503.
- **Web styling (built):** copied from `../agent-remote/web/styles.css`: dark palette as `:root` vars (all colors resolve to them), surfaces separated by elevation (`--bg`<`--panel`<`--raised`), no borders, filled controls. Layout = left sidebar (search + nav) + page header + scrolling `.content`; ≤640px sidebar = off-canvas drawer. All styles in `web/styles.css` (classes, no inline styles); global `button`/`input` base + `.primary`/`.danger`. Verified live in headless Chromium (desktop + 390px).
- Markdown rendering (built): `shared/markdown.ts` `renderMarkdown` = the only Markdown→HTML path. LLM output is untrusted (speech can prompt-inject): raw HTML escaped, links only http(s)/mailto (`target=_blank rel=noopener`), images → alt text (no remote loads). Don't loosen.

- **Config (settled):** `server/config.ts` `parseConfig` (pure, tested) validates + normalizes (usernames lowercased/trimmed, baseUrl trailing `/` stripped, empty apiKey → `null`); `loadConfig` = thin file wrapper. Unrouted `llm.tasks.X` = feature off, not an error. Task → unknown provider = startup error.
  - `llm.tasks.X` = route or list of routes → always normalized to non-empty `LlmRoute[]`; first = default, rest = user-selectable (summary). Duplicate route = error.
  - Route `contextTokens` (optional, integer ≥4096, else null = unknown) = model window, used only for summary chunking.
  - `server.host` (default `127.0.0.1`) → `listen(port, host)`. IP literal only (hostname = ambiguous v4/v6 bind). Was all-interfaces before → plain HTTP on LAN; don't regress the default. `172.17.0.1` = nginx-in-Docker (current choice, LAN-only vhost); wildcard logs a warning. Host/port need restart (reload warns). `localUrl` = connectable URL (logs + `health.e2e`). All modes verified live.
- **Static serving:** `resolveStaticPath` must stay `startsWith(root + sep)` (bare `startsWith(root)` lets `dist/web.prev` through); traversal → SPA fallback, never a file outside root.
- **Toolchain versions:** TypeScript 7 (native `tsc`), Vite 8, React 19, Vitest 4, Node 25 on dev box.

## Server design
- **Layout (settled):** `app.ts` `createApp({dataDir,getConfig,version,now})` = route table + all API handlers; `index.ts` = config watch, Vite/static, listen. Handlers throw `HttpError`; router → JSON error, unknown → 500 logged.
  - `api.e2e.test.ts` runs `createApp` in-process on port 0 + temp dir: full HTTP flow, never self-skips.
  - Injected `now()` everywhere for expiry tests.
- **Auth (web, built):** `server/auth.ts` owns all of it; rest of server only calls `authedUser(req)`/`requireUser`.
  - scrypt (`salt:hash`), server-side sessions in SQLite (sha256 of token), HttpOnly SameSite=Lax cookie `pa_session`, 30d sliding.
  - Signup only if `config.json` `auth.signup` (default **false**; else 403 before hashing); web hides the tab via `GET /api/auth/options`. Login refused (403, only after password OK) unless username in `users`.
  - Login + signup share a **global** `Throttle`: 1 attempt/s across all clients → 429 + `Retry-After` (via `HttpError.headers`), checked before parsing/scrypt so floods stay cheap. Rejected attempts don't extend the wait. Global = an attacker can delay your login but can't guess fast or burn CPU (user decision). Tests pass interval 0 (`Auth` 4th arg / `passwordAttemptIntervalMs`).
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
  - Rename (built, verified live in headless Chromium): `PATCH /api/devices/:id {name}` (session, JSON = CSRF guard) → `DeviceInfo`; trimmed, 1–100, no control chars; pending too. `pa status` shows it (reads `/api/device/me`). Idempotent re-pair keeps the name (doesn't overwrite).
  - `DeviceInfo.transcriptCount` + `lastUploadAt`: counts from per-user DB (`deviceUploadStats`, GROUP BY `device_id`) merged in `app.ts`/export (devices live in app.db). `last_upload_at` (app migration 3) stamped on every accepted upload incl. unchanged retries (mutation-checked); null → newest `received_at` (devices from before the column). `lastUsedAt` also counts status polls → shown as "last seen".
  - Revoke wording (`web/devices.ts`) must match the Mac queue: 401 → halt, files kept, auto-resume after re-pair + approve. Change the queue → update the text.
- **Transcript ingest (built):** `POST /api/device/transcripts`, idempotent on client-generated `id` (uuid; re-upload = upsert; 201 created / 200 replaced). Body limit 20 MB.
  - Payload (`TranscriptUpload`): recording `startedAt/endedAt`, `meeting` (null = ad-hoc; `calendarName`, `eventId`, `seriesId`, title, start/end, organizer, attendees `{name,email}`), segments `[{start,end,speaker,text}]` (seconds from recording start), asr/diarization model ids. Device id comes from the token, not the payload.
  - `parseTranscriptUpload` normalizes: lowercase uuid + emails, timestamps → UTC ISO (zone required), blank → null, all-null people dropped. `isSelf` kept only when true; `speakerEmbeddings` (optional) validated (same length 2–4096, labels must be in segments) and kept only when non-empty → `data` of old clients' uploads unchanged. Fixture: `shared/fixtures/transcript-upload.json`.
  - Stored: `raw` (body verbatim) + `data` (normalized JSON) + index columns. Ad-hoc `attendee_count` = null, not 0.
  - Derived data (summary, chunks, embeddings) regenerable from raw.
  - `updated_at` = content last changed: identical re-upload (device retry) keeps it and returns `changed:false` → no re-summarize, summary not stale. Don't make it bump on no-op uploads.
- **Transcript delete (built):** `DELETE /api/transcripts/:id` (session) → 204 / 404; web "Delete transcript" button (confirm) on the detail page → back to list. Verified live in headless Chromium.
  - `deleteTranscript`: one transaction; summary + `search_rows` go by FK cascade, FTS terms by the `search_rows_ad` trigger (unit test checks `search_fts` itself, not just search results). Needs `foreign_keys=ON` (openDb sets it; test DBs must too).
  - Tombstone `deleted_transcripts (id, deleted_at)` (user migration 6, no content): re-upload of that id → **410 Gone**, so device retries / `pa transcribe --upload` re-runs can't resurrect a deletion. Upload queue treats 410 as permanent (drops it, never retries; see osx Upload queue).
  - Then `jobs.remove` drops the summarize job; a run in flight can't settle a removed row, and `saveSummary` is `INSERT … SELECT … WHERE EXISTS(transcript)` → no FK error/orphan. Don't drop the guard.
  - Not purged: existing backups (until they rotate out; UI confirm says so), SQLite free pages/WAL until reuse/checkpoint (no `secure_delete`).
- **Formatting:** `shared/format.ts` (`formatDateTime`, `formatDuration`, `formatOffset`, `formatValue`; missing → `—`) used by UI and logs.
- **LLM (built):** `server/llm.ts`, OpenAI-compatible only (`/chat/completions`, `/embeddings`, `/models`); `createLlm({getConfig})` reads config per call (live reload).
  - `config.json` `llm.providers[]` `{id, baseUrl, apiKey?, models[]}`; default = local vLLM/llama.cpp (free). Per-task routing `llm.tasks {summary, search, embed}`; paid providers opt-in per task.
  - Pure parsers (`parseChatResponse`, `parseEmbeddingsResponse`, `errorMessage`, …) unit-tested with fake fetch; `llm.e2e.test.ts` = fake provider down→503→up (never skips) + live local LLM (config.json route, else probes `localhost:8000/v1`; self-skips).
  - `LlmError.retryable`: network/timeout/408/409/429/5xx/non-JSON reply/**unrouted task** = true (outage → job waits); other 4xx / malformed reply = false.
  - `LlmError.contextOverflow`: `isContextOverflow` (pure) = 413, or 400 + vLLM/OpenAI/llama.cpp/Anthropic "too long" wording; always non-retryable. vLLM reply verified live (instant 400, "maximum context length is 90000 tokens"). Only place that knows vendor wording.
  - `llm.contextTokens(task, route)` = configured window of the route `chat` would use (null = unknown/unrouted).
  - Route choice: `chat(task, msgs, {route})`; `resolveRoute` honors `route` only if it's in `llm.tasks[task]` (else default) → users can't aim at arbitrary models/paid keys. Don't loosen. `routeChoices` = list for UI; health reports the default route.
  - Strips leading `<think>…</think>` (reasoning models). Embeddings batched (64), reordered by `index`.
  - Health: `GET /api/llm/status` (session) → per task `{ok, provider, model, modelListed, error}`; model missing from `/models` = not ok (common misconfig).
  - vLLM reply/error shapes verified live (`{error:{message}}`, FastAPI `{detail}`); vLLM on dev box has no embedding model → embed live test skips.
- **Background jobs (built):** `server/jobs.ts` `JobQueue` (SQLite) + `JobRunner` (one job at a time: one local LLM). Started in `createApp`; handlers registered in `app.ts` `defaultJobHandlers`.
  - **Disabled users skipped:** `claimNext`/`nextRunAt` filter by `config.users` (read per claim) → no tokens spent; jobs stay queued untouched, resume when re-enabled (≤60s idle poll). `nextRunAt` must filter too, else an overdue disabled job makes the runner spin.
  - Table in **app.db** (not per-user DB) so one worker scans all users; payload = refs only (ids), never content. `user_id` FK cascade.
  - Dedupe on `(user_id, type, key)`: re-enqueue revives row (new payload, counters reset, `generation+1`). Settle only `WHERE generation = claimed AND status='running'` → re-upload mid-run re-runs, never lost. Don't drop the guard.
  - Retries: exponential backoff (30s→1h cap, no jitter). `isRetryable` duck-typed (`err.retryable === true`) so queue never imports LLM code. Outages never count toward `maxFailures` (5) → never `failed`; `failed` row kept, re-enqueue revives.
  - Crash: `recover()` at start requeues `running`. Shutdown: `app.close()` is async, aborts handler signal, `release()`s job (attempt not counted) before DB close.
- **Summaries (built):** `server/summaries.ts`; job `summarize`, key = transcript id, payload `{llm}` (one-off model pick) or null.
  - Enqueued on upload (payload null) if content `changed` or never queued (backfill); `POST /api/transcripts/:id/summarize` (body `{llm?}`, JSON content-type = CSRF guard) forces re-run → 202 `{summaryJob}`; `llm` not in choices → 400.
  - Model: payload pick > user setting (`settings` table, `summaryLlm`) > default. Stored pick dropped from config → treated as default (`effectiveChoice`), not an error. Classify uses the same route.
  - `GET /api/transcripts/:id` adds `summary` (`stale` = transcript changed since) + `summaryJob` (`JobState`). `GET /api/transcripts/:id/summary` = same two fields without segments (UI poll target; don't poll the full detail).
  - Web `SummaryPanel`: pure `web/summaryState.ts` `summaryStatusView(job, hasSummary)` → message/tone/poll/button (unit-tested); polls 2s while queued/running, 15s while waiting out a backoff (queued + `lastError`), stops on done/failed. Button: Summarize / Re-summarize / Retry, disabled in progress.
  - UI states verified live in headless Chromium (done, generating, LLM down → waiting → auto-recovered ~30s); `failed` + never-queued only unit-tested.
  - Types + descriptions + built-ins + `resolveInstructions` live in `shared/instructions.ts` (UI + server share them). Types: `1on1 standup interview external meeting adhoc`.
  - Classify order: rule > series > LLM. Series = `seriesMeetingType`: type of the latest *other* summarized occurrence with source rule/series/llm (fallback + NULL-source rows skipped so a bad guess isn't copied forward) → source `series`, no LLM call, consistent instructions across a series. Re-summarizing an occurrence never reads its own row.
  - `classifyByRule`: no event = `adhoc`; title keywords (1:1, standup/daily/scrum, interview minus debrief/prep) **before** attendee count (2-person interview ≠ 1on1); 2 attendees = `1on1`; else null → LLM (`classifyMeeting`, bare type-id reply, never picks `adhoc`). Unparseable reply / non-retryable error → `meeting` + source `fallback`; retryable → throw (job waits). Stored `meeting_type_source` rule/series/llm/fallback (null on old rows).
  - Instructions: series > type > custom default > `builtin:<type>`; each **replaces** lower levels (custom default hides built-in per-type texts — intended). Common rules always prepended. Source strings `series:<id>` / `type:<t>` / `default` / `builtin:<t>`.
  - Custom instructions: per-user `instructions (scope, key)` table; `GET /api/instructions` (custom + `series` seen in transcripts); `PUT|DELETE /api/instructions/default | /type/:type | /series/:seriesId` (URL-encoded id, case kept, trimmed; text ≤20k; DELETE idempotent). Editing doesn't mark summaries stale (re-summarize manually).
  - Settings: `GET|PUT /api/settings` `{summaryLlm, summaryLlmChoices}`; web `#/settings` (`web/Settings.tsx`) + model `<select>` in `SummaryPanel`.
  - Classify verified live on gemma (external / meeting cases); settings page + series instructions + remote pick verified live in headless Chromium.
  - `instructionsChanged` (computed in `getSummary`, nothing stored): resolve instructions now for the summary's stored type + transcript `series_id` vs stored text **and** source (same text moved to another level = changed). Type not re-classified. Separate from `stale` (transcript changed). Web shows a warning; verified live in headless Chromium.
  - Prompt: system = common rules (transcript language, Markdown, no invention, ASR caveats) + instructions; user = metadata + `[m:ss] Speaker: text` (same-speaker runs merged). No `max_tokens`; `finish_reason=length` / empty = non-retryable error.
  - Stored in per-user `summaries` (one row per transcript): text, type, instructions source + text, provider/model, token usage (null if unknown), `transcript_updated_at`.
  - Handler: missing transcript = done (no-op); LLM outage/unrouted `summary` task = retryable → job waits.
  - Live on dev box (gemma-4-31B via vLLM): fixture summary correct, ~0.6s (verified live).
  - **Long transcripts (built):** `summarizeTranscript` = one call if it fits (or window unknown); else parts → notes per part (`buildPartPrompt`) → merge rounds of neighbour notes if they don't fit one call (`groupNotes`, ≤4 rounds) → `buildCombinePrompt` (same summary rules, fed notes). Instructions passed into every notes prompt so parts capture what the final format needs.
    - Window unknown + overflow reply → assume 16384 (`FALLBACK_CONTEXT_TOKENS`); overflow in parts → halve and redo, down to 4096, then non-retryable error pointing at `contextTokens`. One wasted call per halving (verified in tests).
    - Estimate = chars/3 (`CHARS_PER_TOKEN`): gemma tokenizer ~3.8 chars/token on Dutch prose, ~2.1 on JSON (verified live). Reply reserve = min(8192, window/4) (no `max_tokens` sent).
    - `chunkSegments` splits between segments, oversize segment at word boundaries; order + every word kept.
    - `summaries.parts` (user migration 5): 1 = one call, >1 = parts, NULL = older row; web shows "summarized in N parts". Usage summed over all calls (any unknown → null).
    - Live (verified): 30-min synthetic meeting, forced 4096 window → 3 parts, 8.7s, facts from all 3 parts in the final summary.
    - **Resume (built, unit-tested + mutation-checked; not run live: would need killing the shared vLLM):** part + merge calls go through `NotesCache`; handler passes `dbNotesCache` = per-user `summary_calls (transcript_id, key, result)` (user migration 8, FK cascade). Key = sha256(route + messages): prompts are deterministic per window → retry recomputes the same keys, skips done parts. Cached usage still summed. Single + combine calls never cached. `saveSummary` clears the transcript's rows (same transaction). Null route = "task default": an admin default change between attempts isn't detected (accepted).
- **Search v1 (built):** `server/search.ts`; `GET /api/search?q=&limit=` (session) → `SearchResponse` (per transcript: list item, `metaMatch`, `segmentMatchCount`, ≤3 best segments w/ highlight `parts`).
  - Per-user DB migration 4: `search_rows` (1 row/segment + 1 meta row: title, attendee+organizer names/emails) + external-content FTS5 `search_fts` (`unicode61 remove_diacritics 2`). Synced by **triggers** from `transcripts.data` (+ backfill in migration) → no code path can forget to reindex. Changing what's indexed = new migration that rebuilds, never edit migration 4.
  - Speaker labels not indexed (diarization labels would match everything).
  - `parseSearchQuery` (pure): every term quoted → FTS syntax always literal (no 500s, no column targeting); words prefix (`"w"*`), `"quoted"` = phrase; no-letter terms dropped (an empty phrase ANDs everything to nothing); max 10 terms.
  - Semantics: AND per **transcript** (terms may hit meta or different segments), ranked by summed bm25, weights title 10 / attendees 5 / text 1.
  - ⚠️ Every FTS scan in its own `MATERIALIZED` CTE, joined to `search_rows` outside: inlined `MATCH` subqueries were re-run per row (76s → 0.5s on 500k segments, verified live); bm25()/highlight() also error inside joins.
  - ⚠️ `rowid = CAST(? AS INTEGER)`: better-sqlite3 binds JS numbers as REAL and FTS5 silently ignores `rowid = <real>` → wrong row's highlight (verified live). Don't drop the CAST.
  - highlight() only for shown segments (control-char markers → `TextPart[]`); web renders text nodes + `<mark>`, never HTML.
  - Perf (1000 meetings × 500 segs, dev box): rare term ~10ms, term in ~50% of segments ~0.6s; filters add ~0 (verified live).
  - Filters (`from`/`to`/`with`): narrow only, never score/`metaMatch`. `from` incl / `to` excl on `started_at`, ISO w/ zone → UTC (`parseIsoTime`, shared with ingest; stored ISO strings compare lexically). `with` (≤5, AND) = `attendees : "x"*` FTS query → case/accent-insensitive word prefix, same MATERIALIZED-CTE rule. No `q` + filter = list newest first.
  - Web filters: hash holds local days (`from`/`to` inclusive); `searchApiPath` converts to [local midnight, day-after-`to` midnight) instants — server never guesses the user's zone. Nav box keeps active filters.
  - Web: nav `SearchBox` → `#/search?q=`; `web/routes.ts` = only hash builder/parser (unit-tested); `#/t/<id>/s/<n>` scrolls to + highlights segment. Verified live in headless Chromium.
- **Backups (built):** `server/backup.ts` `backupData` → `backup.dir/<yyyyMMdd-HHmmss>Z/{app.db,users/<id>.db}`, keep newest `backup.keep` (config `backup`, default `data/backups` / 14). Timer `personal-assistant-backup.timer` (03:30, `Persistent`) installed by `install-service.sh`.
  - `VACUUM INTO` per DB = online-safe consistent copy incl. uncommitted-to-main WAL content; a raw file copy misses it (even the schema, mutation-checked). Snapshot files are `journal_mode=delete` → self-contained.
  - Written to `<stamp>.partial`, `quick_check`, then rename → listed snapshot always complete; leftover partials pruned; unknown names in the dir never touched.
  - Opens DBs without `migrate()`: a backup never changes schema.
  - ⚠️ Entry = `server/backup-main.ts`, not an `import.meta.url === argv[1]` guard: guard failed via symlinked path → silent no-op backup (verified live). Don't "simplify" back.
  - Verified live: scratch server running (WAL open), 3 runs, prune to keep=2; bad config.json → exit 1 (unit fails visibly). Units pass `systemd-analyze verify`.
- **Speaker names (built, verified live in headless Chromium desktop + 390px):** per-user `speaker_names (transcript_id, label, name)` (user migration 7, FK cascade). `transcripts.data` never rewritten (= what the device sent).
  - `PUT /api/transcripts/:id/speakers {names: {label: name|null}}` → `{speakerNames}`; partial; labels must occur in the transcript; trimmed, ≤100 chars, blank/null = remove. ⚠️ Control chars rejected: a newline in a name could forge `[m:ss] Speaker:` lines in the LLM prompt.
  - Applied in: detail (`speakerNames` map; segments keep raw labels, web renders `displaySpeaker`), search hits (server-side), summarize job (`loadTranscript` → `applySpeakerNames`), export.
  - A change bumps `transcripts.updated_at` to `max(updated_at+1, now)` (strictly newer even on the same clock) → summary `stale`; not auto re-summarized. Identical device re-upload keeps names. Re-transcribed upload may renumber labels → names can then be wrong (not detected).
  - ⚠️ Lookups use `Object.hasOwn`: a label like `constructor` must not hit Object.prototype (mutation-checked).
  - Not indexed for search (names only replace labels in hits).
- **Speaker matching (built 2026-10-01; unit + api.e2e tested, mutation-checked; UI verified live in headless Chromium desktop/390px; thresholds uncalibrated):** `server/speakerMatch.ts`, no LLM, runs **synchronously in the upload request** (before the summary job reads names).
  - Auto names = `speaker_names` rows with `source='auto'` + `reason` (voice/calendar) + `score` (user migration 10). User names always win, never overwritten. Detail/PUT return `autoSpeakers`.
  - ⚠️ Voiceprints = join of `speaker_names` **source 'user' only** + `speaker_embeddings` (other transcripts, same `diarizationModel`). Auto names never teach themselves; confirm (PUT same name) turns auto → user without bumping `updated_at`. No separate voiceprint table → nothing to sync; delete/rename = automatically reflected.
  - Embeddings: upload `speakerEmbeddings` {label: number[]} (Mac: FluidAudio `DiarizationResult.speakerDatabase` = VBx cluster centroids, raw 256-d space, checked in v0.17.4 source). Stored unit-length float32 BLOBs in `speaker_embeddings` (FK cascade), **never in `transcripts.data`** (identical retries with/without them stay unchanged; not shipped to the web). Unchanged retry only backfills embeddings if none.
  - Voice: greedy one-to-one by best-sample cosine; auto ≥0.70 + margin 0.10 over runner-up + ≥20 s speech + invitee (non-invitee needs ≥0.80); ≥0.50 = suggestion. Uncalibrated guesses (`VOICE_*` consts).
  - Calendar (`eliminate`): exactly one unnamed generic label with ≥10 s speech + exactly one named invitee not accounted for (self via `Person.isSelf` or name = mic label; names in use; `personKey` = case/accent/punctuation/word-order-insensitive) → auto. Skipped if voice suggests someone else for that label. Any doubt → nothing.
  - Changed re-upload: auto names cleared + recomputed (labels may renumber). PUT doesn't re-run auto (a cleared auto name stays cleared); `GET …/speakers/suggestions` adds `matches` (computed live for unnamed labels) and the LLM suggest prompt gets them as hints.
  - Exported: `autoSpeakers` + `speakerEmbeddings` per transcript.
- **Speaker suggestions (built, verified live: gemma-4-31B + headless Chromium desktop/390px):** `server/speakerSuggestions.ts`, job `suggest-speakers` (key = transcript id), on demand only: `POST /api/transcripts/:id/speakers/suggestions` (JSON body = CSRF guard) → 202; `GET` same path → `SpeakerSuggestionsResponse {suggestions, job}`.
  - ⚠️ Suggestions only: own table `speaker_suggestions` (user migration 9, FK cascade); never writes `speaker_names`. Web "Use" fills the input; user saves. `GET` hides labels the user has named. Don't make it auto-apply.
  - Asks only about generic labels (`isGenericLabel` in `speakers.ts`: `Speaker N`, `S1`, `SPEAKER_00`) without any (user/auto) name; none → saves empty, no LLM call. Mic label = user's real name, never asked.
  - Prompt: user names applied, invitees listed, transcript cut from the start to the window (`inputBudgetChars`; unknown window → 16384); overflow → halve to 4096. Route = user's summary model (`summary` task).
  - `parseSuggestReply`: reply untrusted → only asked labels, names ≤100 chars w/o control chars (prompt-forging), generic/same-as-label names dropped, evidence flattened + ≤300. Unparseable → saves none (logged), job done (no pointless retries). gemma replies ```json-fenced (verified live).
  - Cleared on **changed** device re-upload (labels may be renumbered); speaker renames don't clear. Not exported (derived). Delete transcript → `jobs.remove` for this job too.
- **Account (built, verified live):** `GET /api/export` = `UserExport` JSON (`format: personal-assistant-export/1`) as attachment. `DELETE /api/account {password}` → 204 + cookie cleared: `Auth.confirmPassword` (same global throttle as login; wrong = 403, still logged in) → `account.ts deleteAccount`: users row (cascade sessions/devices/jobs) → `Store.deleteUserDb` (closes handle, rm db/wal/shm) → `purgeUserFromBackups(resolve(cwd, backup.dir))`.
  - `Store` keeps an in-process set of deleted ids → `user()` throws, so a job/request in flight can't recreate the file; `Auth.signup` clears it (SQLite may reuse the max rowid for a new account).
  - Backup purge: every snapshot + `.partial`: rm `users/<id>.db`, delete app.db row (FK on) then **VACUUM** (without it the password hash stays in free pages; mutation-checked).
  - Not done: removing the username from config.json `users` (admin; logged). If it stays and signup is on, anyone can register that name (fresh, empty account). A backup running during the delete could still copy the file (rare; not handled).
  - Tombstones go with the user DB: a still-paired Mac is revoked (device row gone → 401 → queue halts), so it can't re-upload.
- **Live preview (built 2026-10-01; unit + api.e2e + headless Chromium desktop/390px with a fake device):** `server/live.ts`. Preview only: final `TranscriptUpload` (same id) replaces it.
  - `POST /api/device/transcripts/:id/live` (bearer, active) `LiveChunk {stream mic|system, seq, startedAt, meeting, segments, ended?}` → `{accepted}`; idempotent on (id, stream, seq) via `live_chunks` (empty chunks too). `DELETE` same path (bearer) = recording discarded, no tombstone. Body ≤1 MB, ≤500 segments. Fixtures `live-chunk.json` + `live-chunk-response.json`.
  - Own tables (user migration 11: `live_transcripts`, `live_chunks`, `live_segments`), never `transcripts` → no summary/FTS/speaker matching on partial text.
  - ⚠️ Final upload deletes the preview in the same transaction (`upsertTranscript`); a chunk after that → `accepted:false`, not stored (else a preview would reappear next to the transcript). Mutation-checked.
  - Tombstoned id → 410. Web delete works on a live-only id (`deleteTranscript` also deletes live rows + tombstones) → Mac's later chunks + final upload get 410 = user can kill a meeting while it records.
  - `GET /api/transcripts/:id/live?after=<cursor>` (session) → `LiveTranscriptResponse` (cursor = `live_segments.id`; segments sorted by start; `status` live/ended/final). List = transcripts + previews (`live` field, `endedAt` = last chunk).
  - Stale previews (no chunk 24 h) purged lazily on list/live GET (no sweep over every user DB). Not exported (transient).
  - Web: detail 404 → `web/Live.tsx` polls (2 s; 4 s once ended), swaps to the detail page on `final`. Pure `web/liveState.ts` (merge by start, join chunk-split lines, status, follow-bottom). Polling, not ws/SSE (2 s fits the budget).
  - 404 within 30 s of opening (`waitForFirstChunk`) → keep polling ("Waiting for the live preview"), then "No such transcript.": menu bar link opens the page before the first chunk exists (verified live in headless Chromium).
- **Spoken notes (built 2026-10-04, unit + api.e2e, mutation-checked; web not run in a browser):** upload `kind: "note"` (optional; `"meeting"`/null → key omitted so older uploads' `data` stays identical; other values 400). `classifyByRule`: note first → type `note` (source rule, never offered to the LLM), built-in `note` instructions (notes by topic + todos + open questions, first person). List item `kind` = `json_extract(data,'$.kind')` (no column/migration). Web titles via `shared/format.ts` `transcriptTitle` (`(spoken note)` / `(ad-hoc call)`). Speaker suggest/match: only the mic label → nothing to do.
- **Search v2 (planned, not built):** hybrid — FTS5 + `sqlite-vec` (embeddings of ~1-min chunks) → merge/rerank → optional LLM answer citing chunks (RAG).
- **Wire contract:** `shared/api.ts` is source of truth; Swift `Codable` mirrors it (`osx/Sources/PACore/Wire.swift`). JSON fixtures in `shared/fixtures/` decoded by Swift `WireTests`; `transcript-upload-pa.json` = byte-for-byte-semantic output of `pa transcribe`'s pure pipeline (Swift `PaUploadFixtureTests` builds it; server unit + `api.e2e` ingest/summarize/search it). nil keys are **omitted** (no `meeting`, no `speaker`), not null — server must keep treating missing = null; `api.e2e.test.ts` `expectFixtureShape` asserts real responses keep fixture keys + JSON types (mutation-checked both sides). New device-facing response → add fixture + both checks.

## osx tech (decisions)
- **Headless — no UI** (`pa`); the only UI = separate `PAMenu.app` (see Menu bar app). Swift 6 CLI `pa`; runs as a background process. Swift because audio taps, EventKit, CoreML ASR are native-only.
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
- **CLI subcommands:** `pa pair <server> <account> [--name D]`, `pa status`, `pa upload <json>`, `pa transcribe` (spike, see Transcription), `pa run [--no-record]` (daemon), `pa note start|stop|toggle|status` (bare binary, no TCC), `pa pause` / `pa resume` (bare binary),  `pa calendars`, `pa queue` (recordings not yet transcribed + pending/failed uploads), `pa test-capture` (spike, below), `pa mics` / `pa set-mic (UID|--default)` (built).
- **Mic selection (built, device switch not verified live):** persisted as Core Audio device **UID** (stable; object ids aren't) in app-support `config.json` `micDeviceUID`; nil/unplugged → system default.
  - `pa mics` = TSV `uid\tname\tflags` (pure `formatMicLine`), parsed by bash-3.2 `osx/pick-mic.sh`. Bare binary OK: enumeration needs no TCC.
  - Applied via `kAudioOutputUnitProperty_CurrentDevice` on inputNode's unit; device read back and printed (ground truth).
- **Autostart (built, not run):** LaunchAgent `~/Library/LaunchAgents/<bundle id>.plist` (`RunAtLoad`, `KeepAlive`, `AssociatedBundleIdentifiers`, stdout/err → `~/Library/Logs/<bundle id>.log`) running `osx/build/PA.app/Contents/MacOS/pa run` in place; `osx/install.sh` = bootout + write + bootstrap. **Grant TCC first** via `osx/pa calendars` / `test-capture` / `run` (prompts need an interactive launch).
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
- **Meeting detection (PACore built, Linux-tested + mutation-checked; wired in `pa run`, not run on the Mac):** `MeetingDetector.swift` `detectStep(state, input) → (state, [RecorderAction])`, pure, called every few s; actions `start(event?)` / `attach(event)` / `stop(session, reason)` / `discard(session)`.
  - Inputs: `eligibleEvents` (work calendars), `micInUse`, `meetingAppRunning` (Zoom/Teams/Webex/browser), `now`.
  - ⚠️ `micInUse` must exclude pa's own process (per-process `kAudioProcessPropertyIsRunningInput`, not `…DeviceIsRunningSomewhere`): our capture would keep every recording alive forever.
  - Window = [start − 5 min, end + 10 min) (user decision). Start: mic → core event (latest start) > upcoming (pre-roll) > ad-hoc; app alone → only events with attendees not already recorded ("Focus time" + Zoom open all day ≠ call). Never links to an already-ended event (call right after = ad-hoc).
  - Activity = mic, or app-in-window until the mic was first seen (then mic only: Zoom left open ≠ still in call). Stop after 2 min inactive (dropouts don't split); <60 s active → `discard`. Overrun keeps recording while mic in use.
  - Back-to-back: split exactly at next event's start (stop before start, same step); overlapping events don't split a running one. Ad-hoc call that reaches an event's window → `attach` (relabel), no split. Finished event: app won't restart it; mic (rejoin) does, linked again.
  - Session event snapshot refreshed each step (moved/extended events).
  - **Pause (built 2026-10-05, Linux-tested + mutation-checked):** `DetectorInput.paused` ← app-support `pause.json` (`PauseStore`, `{pausedAt}`; unreadable = not paused → fail toward recording), polled every 1 s like notes. User decisions: running meeting → `finish(.paused)` (≥60 s kept, else discarded); indefinite only (no timed pause); **notes still work while paused**. Pause-stop runs **before** note handling (note requested in the same poll starts, not refused); `if paused return` after it (a call ending a note isn't recorded). Event → `finished` → on resume only the mic restarts it.
- **Daemon `pa run` (built; PACore Linux-tested + mutation-checked; `pa/` wrappers never compiled):**
  - `pa/Run.swift`: upload worker task + recording task (lock → `recoverInterrupted` → transcribe loop + record loop). Non-Sendable state (EventKit, controller, recorders) local to one task, never shared.
  - Record loop every 5 s: `micUsers` (Core Audio process objects `IsRunningInput`, own pid excluded, `ignoreMicApps`) + `runningMeetingApps` (libproc exe paths → outermost `.app` in `defaultMeetingApps`, incl. browsers; NSWorkspace avoided: needs a run loop) → `detectStep` via PACore `RecordingController`. Calendar + config re-read every 60 s (broken config → keep previous). Signals + calendar state logged on change only.
  - EventKit (`pa/Calendars.swift`): access requested only if `workCalendars` set (cached; grant later → restart); events overlapping [now−12h, now+1h]; `isRecurring = hasRecurrenceRules || isDetached`; rooms/resources dropped (`mapParticipants`); organizer = self → `selfStatus` nil.
  - `PACore/Recordings.swift`: `recordings/<id>-{mic,system}.wav` + sidecar `<id>.json` (`RecordingMeta`) written at **start** (crash-safe). id = upload id (not a stamp: back-to-back split can start two in one second).
  - Capture = `CaptureRecorder` (mic then tap, same order as test-capture); one stream failing = keep the other; stop → `streamWarnings` (all-zero / no audio / write error) logged.
  - `RecordingProcessor`: finished sidecars oldest first → transcribe (models loaded per recording, released after) → 0 segments = not uploaded → `enqueue` + `worker.kick()` → delete audio (or `keepAudioDays` → `recordings/kept/`, pruned by mtime). ⚠️ `attempts` saved **before** transcribing: a crash in ASR can't crash-loop under `KeepAlive`; 3 attempts → parked (kept, `pa queue` shows `failed`). Retries: per finished recording + every 10 min.
  - ⚠️ Single instance: `flock` on app-support `run.lock`, taken **before** `recoverInterrupted` (else it would mark the other process's live recording ended). Second `pa run` waits (polls 5 s). `--no-record` takes no lock (double upload = harmless).
  - SIGTERM/SIGINT: DispatchSource (signal ignored first) cancels the record task → `controller.shutdown` (≥ minActive kept, else discarded) → WAVs closed → exit 0 without waiting for a transcription (restarts from sidecar). Default SIGTERM would leave WAV headers unfinalized.
  - Logging: `daemonLog` = stdout (launchd → log file) + `os.Logger` (`.public`).
  - Known limits: WAV = float32 48 kHz stereo ≈ 1.4 GB/h for the tap (+ mic), 4 GB WAV cap ≈ 2.9 h; file I/O still in the capture callbacks (spike-grade `WavWriter`).
- **Live preview (PACore built + Linux-tested + mutation-checked; `pa/LiveEngine.swift` written vs FluidAudio v0.17.4 source, never compiled):**
  - `WavWriter(sink:)` gets every buffer written to the WAV → `LivePreview.sink` copies it (AVAudioEngine reuses buffers) → unbounded AsyncStream (dropping audio would shift later timestamps) → per-stream `SlidingWindowAsrManager`.
  - Config 8 s left + 5 s chunk + 2 s right = model's fixed 15 s window → word lag 2–7 s + send + 2 s web poll. Default 11 s chunk = up to 13 s. Smaller chunk = more chunk-edge errors; tune from `mac-check live`.
  - FluidAudio update = that window's new tokens only, on the stream timeline (checked in source; assumed = since recording start, verify on Mac). `isConfirmed` = confidence, not stability → all updates used.
  - ⚠️ `LiveWordAssembler` holds each window's last word back: next window may continue it (split word) or re-decode it whole (FluidAudio #897; overlap in time → held copy dropped). Emitting it early = duplicate/split words. Mutation-checked both ways.
  - `LiveChunkBuilder` (seq per stream, `groupSegments`), mic speaker = `micSpeakerName()` (same as final), system = `Others`.
  - `LiveOutbox` (in-memory, ≤120 chunks, oldest dropped): failure → 15 s pause, resend same seq (server dedups); 410/`accepted:false`/401 → stop for this recording; 400 → skip chunk. `record(for:)` matches by stream+seq, not head (actor reentrancy). Not the upload queue: the final upload covers losses.
  - `AudioRecorder` hooks (default no-op): `prepare(meta)` before start, `meetingChanged` (attach + final snapshot before stop), `willDiscard` before stop → DELETE preview.
  - `LiveModels`: one model load per daemon (Task-deduped; preloaded at `pa run` start), kept (offline models still per recording). Never `asr.cleanup()` (would unload the shared model). Mac `config.json` `liveTranscription: false` = off; unpaired = off.
  - Daemon logs per recording `live <id>: done, lag p50 … p95 …` (`liveLagSummary`; speech → server accept, excludes web poll).
- **Spoken notes (built 2026-10-04; PACore Linux-tested + mutation-checked; `pa/Note.swift` + Run.swift polling never compiled):** explicit trigger, never inferred. User decisions: explicit trigger + `note` type (always-on mic + VAD rejected: records bystanders/phone calls); tray icon → add a toggle (roadmap 13).
  - `pa note` writes/deletes app-support `note-request.json` (`NoteRequestStore`, `{id, requestedAt}`, new id per start); `pa run` reads it every 1 s between 5 s steps → `DetectorInput.note`. A file, not a socket/signal: survives either side restarting.
  - Detector: note session = mic only (`AudioRecorder.start(system: nil)`: no tap, so nothing playing on the Mac gets in), no event, no dropout/minActive (kept however short, also on shutdown), ends when the request goes/changes (`noteStopped`), after `noteMaxDuration` 2 h from the request (`noteExpired`), or when another app takes the mic (`meetingStarted` → call recorded in the same step). Request during a meeting/call → refused. App-alone start never interrupts a note (Zoom open ≠ call).
  - ⚠️ Handled requests: `DetectorState.noteDone` + `.clearNoteRequest(id)` → daemon deletes the file only if it still holds that id. Without `noteDone` a lingering file restarts the note after the call (mutation-checked). Stale file (reboot) = expired → cleared, not recorded.
  - Sidecar `RecordingMeta.noteId` (request id) → upload `kind: .note`; `pa note start/stop` confirm by polling for that sidecar (`waitForNoteStart/Stop`, 15 s); `pa note start` checks `run.lock` first (free = no recording daemon → exit 1).
- **Menu bar app (built 2026-10-05; PACore parts Linux-tested; `Sources/pa-menu/main.swift` never compiled):** separate `PAMenu.app` (bundle id `com.bitofant.pa.menu`, `LSUIElement`, target `pa-menu`, PACore only). User decision: separate app, not in `pa run` (menu crash can't kill a recording; `pa run` stays headless for ssh/`--no-record`; no AppKit run loop in the daemon).
  - ⚠️ **No daemon→menu IPC**: state = `readMenuStatus(AgentPaths)` over files `pa run` already writes: `run.lock` held (`daemonIsRunning`, flock probe), open sidecar (`endedAt` nil; ignored if lock free = crash leftover), `note-request.json`, `pause.json`, upload-queue counts. Actions write the same files as `pa note` / `pa pause`. Don't add a status file/socket unless the files can't answer.
  - "Open live transcript" (only while recording, Mac `liveEnabled`, valid server URL): `liveTranscriptURL` (pure, tested) → `<server>/#/t/<recording id>` (sidecar id = upload id = live id; same page swaps to the final transcript). Hash must match `web/routes.ts` `transcriptHash`.
  - Status reads must stay read-only: `UploadQueueStore.counts()` (no decode), never `load()` (moves corrupt files to `failed/`; test checks).
  - `menuStatus` (pure) = headline + SF Symbol, one render used by menu + `pa status` (`recorder: …` line, printed before the server call). Refresh every 3 s + on menu open.
  - Start note: fire-and-forget; `noteWasRefused` (request gone, no sidecar) → feedback line; no sidecar within 15 s → withdraw (`clear(id:)`), same as `pa note start`.
  - LaunchAgent `com.bitofant.pa.menu`: `KeepAlive {SuccessfulExit: false}` → Quit (exit 0) stays quit until next login; crash restarts. No Keychain, no audio → no TCC.
  - `AgentPaths` (PACore) = single source for app-support paths (`config`, `recordings`, `upload-queue`, `note-request.json`, `pause.json`, `run.lock`), keyed on `bundleID` `com.bitofant.pa` (not the menu's id). Probe can collide with a starting `pa run` for µs → its 5 s lock poll retries (accepted).
- **Calendar model (built, pure):** `Calendar.swift` `CalendarEvent` (EKEvent mirror) → `meetingMeta`. `eventId` = externalId, recurring → `externalId@<occurrenceDate ISO>` (EKEvent ids are shared by occurrences; occurrenceDate survives a moved occurrence); `seriesId` = externalId (recurring only) → server series instructions/type reuse.
  - Work calendars: Mac `config.json` `workCalendars` = names or `Source/Name`, case-insensitive (Exchange + iCloud both default to "Calendar"). nil/empty = none → all recordings ad-hoc (personal event titles never uploaded by accident). Excluded: all-day, cancelled, declined, zero-length; tentative/pending kept.
  - `emailFromParticipantURL`: `mailto:` only (Exchange X.500 paths → nil).
- **Transcription:** on-device, behind PACore `Transcriber` (URL → `[TimedWord]`) + `SpeakerDiarizer` (URL → `[SpeakerTurn]`) protocols.
  - ⚠️ Not `Diarizer`: FluidAudio exports a public `Diarizer` protocol → ambiguous in `pa` (imports both). New PACore public names: check FluidAudio for clashes.
  - `pa/FluidEngines.swift` (written vs v0.17.4 source, not compiled yet): `FluidTranscriber` = `AsrModels.downloadAndLoad(.v3)` → `AsrManager` (same config as `fluidaudiocli transcribe`) → fresh `TdtDecoderState` per file → `buildWordTimings`. v0.17.4 `transcribe` needs `decoderState: inout` (API.md is stale). `FluidDiarizer` = `OfflineDiarizerManager.prepareModels()` + `process(url)`; `@unchecked Sendable` (manager read-only after load).
  - `pa transcribe [DIR] [--stamp S] [--me NAME] [--no-diarize] [--upload]`: newest capture default; mic speaker default `NSFullUserName()`; writes `pa-<stamp>-transcript.json` next to WAVs; reuses that file's id on re-run → server upsert, no duplicates. `meeting` = null (no calendar yet).
  - Default: **FluidAudio** (CoreML/ANE) Parakeet TDT v3 (multilingual, fast); pinned `.upToNextMinor(from: "0.17.4")` (0.x API churn). Adapter: `buildWordTimings(from: tokenTimings)` → words; `OfflineDiarizerManager` ids `S1…`.
  - FluidAudio's `NemoTextProcessing` xcframework = static lib (checked) → no dylib to bundle in `PA.app`. Its resource bundle only used by TTS.
  - `Package.swift`: `pa` + FluidAudio declared only `#if os(macOS)` → Linux resolves/tests PACore with the manifest as-is. Don't move them out of the guard.
  - `SpeakerDiarizer.diarize(url) → Diarization {turns, embeddings}`; `transcribeRecording` re-keys embeddings by segment label (`speakerLabelMap`, ids without words dropped) → `TranscriptUpload.speakerEmbeddings`. `FluidDiarizer` passes `speakerDatabase` (not compiled yet).
  - Calendar participants → `Person.isSelf` from EKParticipant `isCurrentUser` (attendees + organizer); server uses it to skip the user in speaker elimination.
  - PACore `Transcript.swift` (built, unit-tested, mutation-checked; not yet run on real audio): `transcribeRecording` = mic words → `micSpeaker` (headphones → mic = local user only); system words → diarized. `assignSpeakers` (max overlap, else nearest turn ≤0.5s, else nil) → `relabelSpeakers` (`Speaker N` by first appearance) → `groupSegments` (split on speaker change, gap >1.5s, sentence end past 20s, hard 45s) → `mergeStreams` (by start, ties = stream order).
  - Diarization failure = fail safe: speakers nil, `diarizationModel` nil, warning; ASR failure throws.
  - `findCaptures` pairs `pa-<yyyyMMdd-HHmmss>-{system,mic}.wav`; stamp = Mac local time. `makeTranscriptUpload` → UTC ISO, lowercase id.
  - Fallback/alt: Apple `SpeechAnalyzer`/`SpeechTranscriber` (macOS 26); WhisperKit if accuracy on a language demands it.
- **Speaker ID:** FluidAudio diarization on system stream → clusters. Naming: per-user voice embeddings of known speakers (labeled in web UI), matched against calendar attendees; unknown → `Speaker N`. Server-side LLM may propose names from context; never overwrite a user label.
- **Storage/queue:** audio + pending uploads in `~/Library/Application Support/<bundle id>/`. Raw audio deleted once the transcript is in the upload queue (queue persists first); `keepAudioDays` retention built.
- **Upload queue (PACore built, Linux-tested + mutation-checked; `pa/Run.swift` + `Server.swift` verified live on Linux vs scratch server with file-backed Keychain/config stubs, not yet on the Mac):** `UploadQueue.swift` actor, sender injected; `pa/Run.swift` passes URLSession + server/token read **per send** (`pa pair` in another process applies without restart; unpaired → 401-shaped error → halt).
  - One atomic JSON file per upload `<dir>/<id>.json` (`QueuedUpload`: upload + revision + attempts + nextAttemptAt + lastError). `enqueue` persists before returning → caller may then delete audio. Id must be a UUID (it's a file name); same id = replace + un-park.
  - `classifyUploadFailure`: network/5xx/403 (pending approval)/408/409/425/429 = retry; **410 = drop** (server tombstone, never retry); **401 = halt** (whole queue, in memory; `resume()` after re-pair; restart probes once); other 4xx = park in `failed/` (data kept, not retried). Unreadable queue file → `failed/`.
  - Retry: pass stops at first transient failure; queue-wide backoff 30s→1h by consecutive failures (one probe per wait during outages) + per-item backoff; order = least-recently-tried first → a poison item can't block fresh ones. Cancellation mid-send not counted.
  - Dir `~/Library/Application Support/<bundle id>/upload-queue/`. `pa transcribe --upload` = enqueue + one `drain` (then `pa run` retries); `pa upload <json>` stays direct (debug). Two processes draining = possible double send → harmless (server upserts by id).
  - `UploadWorker.swift` (`pa run` loop): `step` (halted → probe `/api/device/me`, `resume()` when active; probe result logged only on change) → `drain` → wait `uploadWorkerDelay` (next due, capped at 60s idle poll = rescan for other processes' enqueues; halted = 60s probe) or `kick()` (in-process enqueue). Kick during a drain is remembered (`pendingKick`), don't drop it. Kick wait = actor continuation + cancellation handler; `Task.isCancelled` check inside `withCheckedContinuation` closes the onCancel-before-wait race.
  - Parked items: no re-queue command yet (`pa queue` shows them; re-running `pa transcribe --upload` un-parks).
  - ⚠️ Settle only if the file's `revision` is unchanged: re-enqueue during a send (actor reentrancy) must not be deleted. Don't drop the guard.
- **Server client (built):** PACore `ApiClient.swift` = pure `parseServerURL` (https unless loopback), `newDeviceToken` (32 random bytes base64url), request builders (`ApiRequest`), `decodeResponse` (→ `ApiError` w/ server `message`); `pa/Server.swift` = URLSession only.
  - `pa pair`: same server+account → reuses Keychain token (server idempotent, re-shows code); else new token. Saves token + config right after 202, polls `/api/device/me` 3s; 401 = wrong code/expired → re-pair.
  - ⚠️ `fflush(nil)` after the pairing prompt: stdout block-buffered when not a TTY → code only shown at exit (verified live). Swift 6 can't touch the `stdout` global.
  - Code shown as `123 456`; server strips whitespace.
  - Swift encoder omits nil keys; server treats missing = null (verified live).
- **Secrets:** bearer token in Keychain (generic password, service = bundle id, account `device-token`); non-secret settings (server URL, work calendars, retention) in `~/Library/Application Support/<bundle id>/config.json`.
- Networking: `URLSession`, HTTPS only (except localhost).
- Logging: `os.Logger` (subsystem = bundle id) + log file in `~/Library/Logs/` (built: `daemonLog`).
- Tests: Swift Testing (`swift test`); decode `shared/fixtures/` JSON.
