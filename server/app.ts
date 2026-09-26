import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DeviceListResponse,
  HealthResponse,
  LlmStatusResponse,
  MeResponse,
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
import { createLlm, type Llm } from "./llm.js";
import { getSummary, SUMMARIZE_JOB, summarizeHandler } from "./summaries.js";
import { bearerToken, HttpError, readJson, sendError, sendJson, sendNoContent } from "./http.js";
import { getTranscript, transcriptExists, listTranscripts, MAX_TRANSCRIPT_BYTES, parseTranscriptUpload, upsertTranscript } from "./transcripts.js";

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
  route("GET", "/api/transcripts/:id/summary", ({ req, res, params }) => {
    const user = auth.requireUser(req);
    const id = params[0].toLowerCase();
    if (!transcriptExists(store.user(user.id), id)) throw new HttpError(404, "No such transcript.");
    sendJson(res, summaryOf(user.id, id));
  });
  route("POST", "/api/transcripts/:id/summarize", async ({ req, res, params }) => {
    const user = auth.requireUser(req);
    await readJson(req); // content-type check = CSRF guard
    const id = params[0].toLowerCase();
    if (!transcriptExists(store.user(user.id), id)) throw new HttpError(404, "No such transcript.");
    sendJson(res, { summaryJob: jobState(enqueueSummary(user.id, id)) } satisfies SummarizeResponse, 202);
  });

  function summaryOf(userId: number, transcriptId: string): TranscriptSummaryResponse {
    const job = jobs.find(userId, SUMMARIZE_JOB, transcriptId);
    return { summary: getSummary(store.user(userId), transcriptId), summaryJob: job && jobState(job) };
  }

  function enqueueSummary(userId: number, transcriptId: string) {
    const job = jobs.enqueue(userId, SUMMARIZE_JOB, transcriptId);
    runner.kick();
    return job;
  }

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
