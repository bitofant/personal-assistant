import type { JobState, JobStatus } from "../shared/api.js";
import type { Db } from "./db.js";

// SQLite-backed job queue (app.db). One worker, one job at a time: there is one local LLM.

export type { JobStatus };

export function jobState(job: Job): JobState {
  return {
    status: job.status,
    attempts: job.attempts,
    lastError: job.lastError,
    nextAttemptAt: job.status === "queued" ? new Date(job.runAt).toISOString() : null,
  };
}

export interface Job {
  id: number;
  userId: number;
  type: string;
  /** Dedupe key within (user, type), e.g. transcript id. Re-enqueue = re-run, never a duplicate row. */
  key: string;
  payload: unknown;
  status: JobStatus;
  /** Bumped on every enqueue; a run only settles the generation it claimed. */
  generation: number;
  /** Runs started (drives backoff). */
  attempts: number;
  /** Non-retryable failures (drives giving up). Outages never count. */
  failures: number;
  runAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  /** Non-retryable failures before status = failed (row kept; re-enqueue revives it). */
  maxFailures: number;
}

export const DEFAULT_RETRY: RetryPolicy = { baseMs: 30_000, maxMs: 3600_000, maxFailures: 5 };

/** Exponential: base, 2·base, 4·base … capped. No jitter: single worker, and tests stay deterministic. */
export function backoffMs(attempts: number, p: RetryPolicy): number {
  return Math.min(p.baseMs * 2 ** Math.max(0, attempts - 1), p.maxMs);
}

/** Duck-typed so the queue never imports vendor/LLM code: any error with `retryable: true` = outage. */
export function isRetryable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { retryable?: unknown }).retryable === true;
}

export interface FailureOutcome {
  status: "queued" | "failed";
  failures: number;
  runAt: number;
  lastError: string;
}

/** Outage → always requeue (never lost). Other errors → retry until maxFailures, then failed. */
export function afterFailure(job: Pick<Job, "attempts" | "failures">, err: unknown, now: number, p: RetryPolicy): FailureOutcome {
  const lastError = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  const failures = job.failures + (isRetryable(err) ? 0 : 1);
  if (failures >= p.maxFailures) return { status: "failed", failures, runAt: now, lastError };
  return { status: "queued", failures, runAt: now + backoffMs(job.attempts, p), lastError };
}

interface Row {
  id: number;
  user_id: number;
  type: string;
  key: string;
  payload: string;
  status: JobStatus;
  generation: number;
  attempts: number;
  failures: number;
  run_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

// @users = JSON array of usernames, or NULL for no filter.
const USER_FILTER = `(@users IS NULL OR user_id IN (SELECT id FROM users WHERE username IN (SELECT value FROM json_each(@users))))`;

function usersParam(usernames: readonly string[] | undefined): string | null {
  return usernames ? JSON.stringify(usernames) : null;
}

function toJob(r: Row): Job {
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    key: r.key,
    payload: JSON.parse(r.payload),
    status: r.status,
    generation: r.generation,
    attempts: r.attempts,
    failures: r.failures,
    runAt: r.run_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class JobQueue {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  /** Insert or revive (user,type,key): newest payload wins, counters reset, due now. */
  enqueue(userId: number, type: string, key: string, payload: unknown = null, delayMs = 0): Job {
    const t = this.now();
    const row = this.db
      .prepare(
        `INSERT INTO jobs (user_id, type, key, payload, status, run_at, created_at, updated_at)
         VALUES (@userId, @type, @key, @payload, 'queued', @runAt, @t, @t)
         ON CONFLICT (user_id, type, key) DO UPDATE SET payload = excluded.payload, status = 'queued',
           generation = generation + 1, attempts = 0, failures = 0, run_at = excluded.run_at,
           last_error = NULL, updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get({ userId, type, key, payload: JSON.stringify(payload ?? null), runAt: t + delayMs, t }) as Row;
    return toJob(row);
  }

  /**
   * Oldest due queued job → running. `usernames` = enabled users; others' jobs stay queued untouched
   * (no tokens spent for disabled accounts; re-enabling resumes them). Omitted = all users.
   */
  claimNext(usernames?: readonly string[]): Job | null {
    const t = this.now();
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = @t
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= @t AND ${USER_FILTER}
                     ORDER BY run_at, id LIMIT 1)
         RETURNING *`,
      )
      .get({ t, users: usersParam(usernames) }) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** False if re-enqueued mid-run (stays queued so the newer payload runs). */
  complete(job: Job): boolean {
    return this.settle(job, { status: "done", failures: job.failures, runAt: job.runAt, lastError: null });
  }

  fail(job: Job, err: unknown, policy: RetryPolicy = DEFAULT_RETRY): FailureOutcome {
    const outcome = afterFailure(job, err, this.now(), policy);
    this.settle(job, outcome);
    return outcome;
  }

  /** Shutdown mid-run: hand the job back untouched (attempt not counted). */
  release(job: Job): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', attempts = max(0, attempts - 1), updated_at = ?
         WHERE id = ? AND generation = ? AND status = 'running'`,
      )
      .run(this.now(), job.id, job.generation);
  }

  /** Startup: anything still `running` was cut off by a crash/restart. */
  recover(): number {
    return this.db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(this.now()).changes;
  }

  /** Same filter as claimNext: an overdue disabled-user job must not make the runner spin. */
  nextRunAt(usernames?: readonly string[]): number | null {
    const r = this.db
      .prepare(`SELECT min(run_at) t FROM jobs WHERE status = 'queued' AND ${USER_FILTER}`)
      .get({ users: usersParam(usernames) }) as { t: number | null };
    return r.t;
  }

  get(id: number): Job | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? toJob(r) : null;
  }

  find(userId: number, type: string, key: string): Job | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE user_id = ? AND type = ? AND key = ?").get(userId, type, key) as Row | undefined;
    return r ? toJob(r) : null;
  }

  private settle(job: Job, o: { status: JobStatus; failures: number; runAt: number; lastError: string | null }): boolean {
    // generation guard: a re-enqueue during the run must not be overwritten.
    return (
      this.db
        .prepare(
          `UPDATE jobs SET status = @status, failures = @failures, run_at = @runAt, last_error = @lastError, updated_at = @t
           WHERE id = @id AND generation = @generation AND status = 'running'`,
        )
        .run({ ...o, t: this.now(), id: job.id, generation: job.generation }).changes === 1
    );
  }
}

// ---- runner ----

export type JobHandler = (job: Job, signal: AbortSignal) => Promise<void>;

export interface RunnerOptions {
  policy?: RetryPolicy;
  /** Re-check at least this often (clock jumps, rows written by other code). */
  maxIdleMs?: number;
  log?: (msg: string) => void;
  /** Enabled usernames, read per claim (config reloads live). Omitted = all users. */
  enabledUsers?: () => readonly string[];
}

export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private abort = new AbortController();
  private stopped = true;
  private readonly policy: RetryPolicy;
  private readonly maxIdleMs: number;
  private readonly log: (msg: string) => void;
  private readonly enabledUsers: (() => readonly string[]) | undefined;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: Readonly<Record<string, JobHandler>>,
    private readonly now: () => number = Date.now,
    opts: RunnerOptions = {},
  ) {
    this.policy = opts.policy ?? DEFAULT_RETRY;
    this.maxIdleMs = opts.maxIdleMs ?? 60_000;
    this.log = opts.log ?? ((m) => console.log(m));
    this.enabledUsers = opts.enabledUsers;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    const n = this.queue.recover();
    if (n) this.log(`jobs: requeued ${n} interrupted job(s)`);
    this.kick();
  }

  /** Call after enqueue so new work starts now instead of at the next poll. */
  kick(): void {
    if (this.stopped || this.running) return;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort.abort();
    await this.running;
  }

  /** Run one due job, if any. Never throws: every outcome is persisted. */
  async runOnce(): Promise<Job | null> {
    const job = this.queue.claimNext(this.enabledUsers?.());
    if (!job) return null;
    const handler = this.handlers[job.type];
    const signal = this.abort.signal;
    try {
      if (!handler) throw new Error(`no handler for job type "${job.type}"`);
      await handler(job, signal);
      if (!this.queue.complete(job)) this.log(`jobs: ${describe(job)} re-enqueued while running; will run again`);
    } catch (err) {
      if (signal.aborted) {
        this.queue.release(job);
        return job;
      }
      const o = this.queue.fail(job, err, this.policy);
      const when = o.status === "failed" ? "giving up" : `retry in ${Math.round((o.runAt - this.now()) / 1000)}s`;
      this.log(`jobs: ${describe(job)} failed (${isRetryable(err) ? "transient" : `failure ${o.failures}/${this.policy.maxFailures}`}), ${when}: ${o.lastError}`);
    }
    return job;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.drain().finally(() => {
        this.running = null;
        if (this.stopped) return;
        const next = this.queue.nextRunAt(this.enabledUsers?.());
        this.schedule(next === null ? this.maxIdleMs : Math.min(Math.max(0, next - this.now()), this.maxIdleMs));
      });
    }, delayMs);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped && (await this.runOnce()));
    } catch (err) {
      // DB error (disk full, closed): keep the loop alive, try again later.
      this.log(`jobs: runner error: ${(err as Error).message}`);
    }
  }
}

function describe(job: Job): string {
  return `${job.type}#${job.id} (user ${job.userId}, ${job.key}, attempt ${job.attempts})`;
}
