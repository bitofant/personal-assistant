import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DeviceListResponse,
  HealthResponse,
  InstructionsResponse,
  LlmStatusResponse,
  MeResponse,
  SearchResponse,
  SettingsResponse,
  SignupResponse,
  SummarizeResponse,
  TranscriptDetail,
  TranscriptListResponse,
  TranscriptSummaryResponse,
  TranscriptUploadResponse,
} from "../shared/api.js";
import { Auth, clearSessionCookie, sessionCookie } from "./auth.js";
import { LLM_TASKS, type Config } from "./config.js";
import { Devices } from "./devices.js";
import { Store } from "./db.js";
import { jobState, JobQueue, JobRunner, type JobHandler, type RunnerOptions } from "./jobs.js";
import { deleteInstruction, listInstructions, listSeries, parseInstructionTarget, parseInstructionText, putInstruction } from "./instructions.js";
import { createLlm, routeChoices, type Llm } from "./llm.js";
import { parseSearchRequest, searchTranscripts } from "./search.js";
import { effectiveChoice, getSummaryLlm, parseRouteChoice, setSummaryLlm } from "./settings.js";
import { getSummary, SUMMARIZE_JOB, summarizeHandler, type SummarizePayload } from "./summaries.js";
import { bearerToken, HttpError, isRecord, readJson, sendError, sendJson, sendNoContent } from "./http.js";
import { deleteTranscript, getTranscript, transcriptExists, listTranscripts, MAX_TRANSCRIPT_BYTES, parseTranscriptUpload, upsertTranscript } from "./transcripts.js";

export interface AppOptions {
  dataDir: string;
  /** Called per request so config.json edits (enabled users) apply without restart. */
  getConfig: () => Config;
  version: string;
  now?: () => number;
  /** Injected in tests; default = OpenAI-compatible client over config.json routes. */
  llm?: Llm;
  /** Job type → handler; built from store + llm. Tests override. */
  jobHandlers?: (deps: JobDeps) => Record<string, JobHandler>;
  jobRunner?: RunnerOptions;
}

export interface JobDeps {
  store: Store;
  llm: Llm;
  now: () => number;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
}

type Handler = (ctx: Ctx) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export interface App {
  handleApi(req: IncomingMessage, res: ServerResponse): Promise<void>;
  readonly jobs: JobQueue;
  readonly runner: JobRunner;
  /** Stops the job runner (in-flight job is released, not lost), then closes DBs. */
  close(): Promise<void>;
}

function defaultJobHandlers(deps: JobDeps): Record<string, JobHandler> {
  return { [SUMMARIZE_JOB]: summarizeHandler(deps) };
}

export function createApp(opts: AppOptions): App {
  const now = opts.now ?? Date.now;
  const store = new Store(opts.dataDir);
  const auth = new Auth(store, opts.getConfig, now);
  const devices = new Devices(store, (u) => auth.isEnabled(u), now);
  const llm = opts.llm ?? createLlm({ getConfig: opts.getConfig });
  const jobs = new JobQueue(store.app, now);
  const runner = new JobRunner(jobs, (opts.jobHandlers ?? defaultJobHandlers)({ store, llm, now }), now, {
    ...opts.jobRunner,
    // Same source as auth's per-request check: disabling a user also stops spending tokens on them.
    enabledUsers: () => opts.getConfig().users,
  });
  runner.start();

  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler) =>
    routes.push({ method, pattern: new RegExp(`^${path.replace(/:\w+/g, "([^/]+)")}$`), handler });

  route("GET", "/api/health", ({ res }) => sendJson(res, { ok: true, version: opts.version } satisfies HealthResponse));

  // ---- web auth ----
  route("POST", "/api/auth/signup", async ({ req, res }) => {
    const { user, enabled } = await auth.signup((await readJson(req)).value);
    if (enabled) res.setHeader("set-cookie", sessionCookie(auth.createSession(user.id), req));
    sendJson(res, { username: user.username, enabled } satisfies SignupResponse, 201);
  });
  route("POST", "/api/auth/login", async ({ req, res }) => {
    const { user, token } = await auth.login((await readJson(req)).value);
    res.setHeader("set-cookie", sessionCookie(token, req));
    sendJson(res, { username: user.username } satisfies MeResponse);
  });
  route("POST", "/api/auth/logout", ({ req, res }) => {
    auth.logout(req);
    res.setHeader("set-cookie", clearSessionCookie());
    sendNoContent(res);
  });
  route("GET", "/api/auth/me", ({ req, res }) => {
    sendJson(res, { username: auth.requireUser(req).username } satisfies MeResponse);
  });

  // ---- devices (web side) ----
  route("GET", "/api/devices", ({ req, res }) => {
    sendJson(res, { devices: devices.list(auth.requireUser(req)) } satisfies DeviceListResponse);
  });
  route("POST", "/api/devices/pair", async ({ req, res }) => {
    sendJson(res, devices.pair(bearerToken(req), (await readJson(req)).value), 202);
  });
  route("POST", "/api/devices/:id/approve", async ({ req, res, params }) => {
    const user = auth.requireUser(req);
    devices.approve(user, params[0], (await readJson(req)).value);
    sendNoContent(res);
  });
  route("DELETE", "/api/devices/:id", ({ req, res, params }) => {
    devices.remove(auth.requireUser(req), params[0]);
    sendNoContent(res);
  });

  // ---- device API (bearer) ----
  route("GET", "/api/device/me", ({ req, res }) => sendJson(res, devices.me(req)));
  route("POST", "/api/device/transcripts", async ({ req, res }) => {
    const device = devices.requireActive(req);
    const { raw, value } = await readJson(req, MAX_TRANSCRIPT_BYTES);
    const { changed, ...result } = upsertTranscript(store.user(device.userId), device.id, parseTranscriptUpload(value), raw, now());
    // Unchanged re-upload: keep existing summary/job; but backfill if it was never queued.
    if (changed || !jobs.find(device.userId, SUMMARIZE_JOB, result.id)) enqueueSummary(device.userId, result.id);
    sendJson(res, result satisfies TranscriptUploadResponse, result.created ? 201 : 200);
  });

  // ---- transcripts (web) ----
  route("GET", "/api/transcripts", ({ req, res }) => {
    const user = auth.requireUser(req);
    const transcripts = listTranscripts(store.user(user.id), devices.names(user.id));
    sendJson(res, { transcripts } satisfies TranscriptListResponse);
  });
  route("GET", "/api/transcripts/:id", ({ req, res, params }) => {
    const user = auth.requireUser(req);
    const db = store.user(user.id);
    const t = getTranscript(db, params[0], devices.names(user.id));
    if (!t) throw new HttpError(404, "No such transcript.");
    sendJson(res, { ...t, ...summaryOf(user.id, t.id) } satisfies TranscriptDetail);
  });
  route("DELETE", "/api/transcripts/:id", ({ req, res, params }) => {
    const user = auth.requireUser(req);
    const id = params[0].toLowerCase();
    if (!deleteTranscript(store.user(user.id), id, now())) throw new HttpError(404, "No such transcript.");
    // After the row is gone: a run in flight saves nothing and can't settle the removed job.
    jobs.remove(user.id, SUMMARIZE_JOB, id);
    sendNoContent(res);
  });
  route("GET", "/api/transcripts/:id/summary", ({ req, res, params }) => {
    const user = auth.requireUser(req);
    const id = params[0].toLowerCase();
    if (!transcriptExists(store.user(user.id), id)) throw new HttpError(404, "No such transcript.");
    sendJson(res, summaryOf(user.id, id));
  });
  route("POST", "/api/transcripts/:id/summarize", async ({ req, res, params }) => {
    const user = auth.requireUser(req);
    const { value } = await readJson(req); // content-type check = CSRF guard
    const id = params[0].toLowerCase();
    if (!transcriptExists(store.user(user.id), id)) throw new HttpError(404, "No such transcript.");
    const llmPick = parseRouteChoice(isRecord(value) ? value.llm : null, routeChoices(opts.getConfig(), "summary"));
    sendJson(res, { summaryJob: jobState(enqueueSummary(user.id, id, { llm: llmPick })) } satisfies SummarizeResponse, 202);
  });

  // ---- search ----
  route("GET", "/api/search", ({ req, res }) => {
    const user = auth.requireUser(req);
    const parsed = parseSearchRequest(new URL(req.url ?? "/", "http://x").searchParams);
    sendJson(res, searchTranscripts(store.user(user.id), parsed, devices.names(user.id)) satisfies SearchResponse);
  });

  function summaryOf(userId: number, transcriptId: string): TranscriptSummaryResponse {
    const job = jobs.find(userId, SUMMARIZE_JOB, transcriptId);
    return { summary: getSummary(store.user(userId), transcriptId), summaryJob: job && jobState(job) };
  }

  function enqueueSummary(userId: number, transcriptId: string, payload: SummarizePayload | null = null) {
    const job = jobs.enqueue(userId, SUMMARIZE_JOB, transcriptId, payload);
    runner.kick();
    return job;
  }

  // ---- custom summary instructions ----
  route("GET", "/api/instructions", ({ req, res }) => {
    const db = store.user(auth.requireUser(req).id);
    sendJson(res, { custom: listInstructions(db), series: listSeries(db) } satisfies InstructionsResponse);
  });
  // /default, /type/:type, /series/:seriesId (URL-encoded)
  for (const path of ["/api/instructions/(default)", "/api/instructions/(type|series)/:key"]) {
    route("PUT", path, async ({ req, res, params }) => {
      const user = auth.requireUser(req);
      const { scope, key } = parseInstructionTarget(params[0], params[1]);
      const text = parseInstructionText((await readJson(req)).value);
      sendJson(res, putInstruction(store.user(user.id), scope, key, text, now()));
    });
    route("DELETE", path, ({ req, res, params }) => {
      const user = auth.requireUser(req);
      const { scope, key } = parseInstructionTarget(params[0], params[1]);
      deleteInstruction(store.user(user.id), scope, key);
      sendNoContent(res);
    });
  }

  // ---- user settings ----
  const settingsOf = (userId: number): SettingsResponse => {
    const choices = routeChoices(opts.getConfig(), "summary");
    return { summaryLlm: effectiveChoice(getSummaryLlm(store.user(userId)), choices), summaryLlmChoices: choices };
  };
  route("GET", "/api/settings", ({ req, res }) => sendJson(res, settingsOf(auth.requireUser(req).id)));
  route("PUT", "/api/settings", async ({ req, res }) => {
    const user = auth.requireUser(req);
    const { value } = await readJson(req);
    if (!isRecord(value) || !("summaryLlm" in value)) throw new HttpError(400, "summaryLlm required (null = server default).");
    setSummaryLlm(store.user(user.id), parseRouteChoice(value.summaryLlm, routeChoices(opts.getConfig(), "summary")));
    sendJson(res, settingsOf(user.id));
  });

  // ---- LLM ----
  route("GET", "/api/llm/status", async ({ req, res }) => {
    auth.requireUser(req);
    const tasks = await Promise.all(LLM_TASKS.map(async (task) => ({ task, ...(await llm.health(task)) })));
    sendJson(res, { tasks } satisfies LlmStatusResponse);
  });

  const prune = setInterval(() => auth.pruneExpired(), 3600_000);
  prune.unref();

  return {
    jobs,
    runner,
    async handleApi(req, res) {
      const path = (req.url ?? "/").split("?")[0];
      let pathMatched = false;
      try {
        for (const r of routes) {
          const m = r.pattern.exec(path);
          if (!m) continue;
          pathMatched = true;
          if (r.method !== req.method) continue;
          let params: string[];
          try {
            params = m.slice(1).map(decodeURIComponent);
          } catch {
            throw new HttpError(400, "Malformed URL.");
          }
          await r.handler({ req, res, params });
          return;
        }
        if (pathMatched) sendError(res, 405, "Method not allowed.");
        else sendError(res, 404, "Unknown API route.");
      } catch (err) {
        if (res.headersSent) return void res.destroy();
        if (err instanceof HttpError) {
          // Body may be unread (e.g. 401 before readJson); close so the client doesn't hang uploading.
          if (!req.complete) res.setHeader("connection", "close");
          return sendError(res, err.status, err.message);
        }
        console.error(`${req.method} ${path} failed:`, err);
        sendError(res, 500, "Internal error.");
      }
    },
    async close() {
      clearInterval(prune);
      await runner.stop();
      store.close();
    },
  };
}
