import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { APP_MIGRATIONS, migrate, type Db } from "./db.js";
import { afterFailure, backoffMs, isRetryable, JobQueue, JobRunner, type JobHandler, type RetryPolicy } from "./jobs.js";

const policy: RetryPolicy = { baseMs: 1000, maxMs: 8000, maxFailures: 3 };
const outage = Object.assign(new Error("ECONNREFUSED"), { retryable: true });

let db: Db;
let t: number;
let q: JobQueue;
const now = () => t;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, APP_MIGRATIONS);
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'alice', 'x', 0), (2, 'bob', 'x', 0)").run();
  t = 1_000_000;
  q = new JobQueue(db, now);
});

describe("pure retry rules", () => {
  it("backoff doubles and caps", () => {
    expect([1, 2, 3, 4, 5, 10].map((a) => backoffMs(a, policy))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("isRetryable is duck-typed on .retryable === true", () => {
    expect(isRetryable(outage)).toBe(true);
    expect(isRetryable(new Error("x"))).toBe(false);
    expect(isRetryable({ retryable: "yes" })).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });

  it("outages never give up, even after many attempts", () => {
    const o = afterFailure({ attempts: 50, failures: 2 }, outage, 0, policy);
    expect(o).toEqual({ status: "queued", failures: 2, runAt: 8000, lastError: "ECONNREFUSED" });
  });

  it("real failures give up at maxFailures", () => {
    expect(afterFailure({ attempts: 1, failures: 1 }, new Error("bad"), 0, policy)).toMatchObject({ status: "queued", failures: 2, runAt: 1000 });
    expect(afterFailure({ attempts: 9, failures: 2 }, new Error("bad"), 0, policy)).toMatchObject({ status: "failed", failures: 3 });
  });
});

describe("JobQueue", () => {
  it("claims due jobs oldest first; future jobs wait", () => {
    q.enqueue(1, "summarize", "b", { id: "b" }, 500);
    q.enqueue(1, "summarize", "a", { id: "a" });
    expect(q.claimNext()).toMatchObject({ key: "a", status: "running", attempts: 1, payload: { id: "a" } });
    expect(q.claimNext()).toBeNull();
    expect(q.nextRunAt()).toBe(t + 500);
    t += 500;
    expect(q.claimNext()?.key).toBe("b");
  });

  it("dedupes on (user, type, key); other users/types are separate", () => {
    const a = q.enqueue(1, "summarize", "x", 1);
    const b = q.enqueue(1, "summarize", "x", 2);
    expect(b.id).toBe(a.id);
    expect(b.generation).toBe(2);
    expect(b.payload).toBe(2);
    expect(q.enqueue(2, "summarize", "x").id).not.toBe(a.id);
    expect(q.enqueue(1, "embed", "x").id).not.toBe(a.id);
  });

  it("complete → done", () => {
    q.enqueue(1, "s", "k");
    const job = q.claimNext()!;
    expect(q.complete(job)).toBe(true);
    expect(q.get(job.id)).toMatchObject({ status: "done", lastError: null });
    expect(q.nextRunAt()).toBeNull();
  });

  it("remove: deletes only that (user, type, key); a run in flight can't settle or resurrect it", () => {
    q.enqueue(1, "s", "k");
    q.enqueue(1, "s", "other");
    q.enqueue(2, "s", "k");
    const job = q.claimNext()!;
    expect(q.remove(1, "s", "k")).toBe(true);
    expect(q.remove(1, "s", "k")).toBe(false);
    expect(q.find(1, "s", "k")).toBeNull();
    expect(q.complete(job)).toBe(false);
    q.fail(job, new Error("x"), policy);
    expect(q.find(1, "s", "k")).toBeNull();
    expect(q.find(1, "s", "other")).not.toBeNull();
    expect(q.find(2, "s", "k")).not.toBeNull();
  });

  it("re-enqueue while running: the old run can't settle it, so the new payload runs", () => {
    q.enqueue(1, "s", "k", "v1");
    const job = q.claimNext()!;
    q.enqueue(1, "s", "k", "v2");
    expect(q.complete(job)).toBe(false);
    expect(q.claimNext()).toMatchObject({ status: "running", payload: "v2", generation: 2 });
  });

  it("a stale run can't settle a newer claimed generation", () => {
    q.enqueue(1, "s", "k", "v1");
    const old = q.claimNext()!;
    q.enqueue(1, "s", "k", "v2");
    const fresh = q.claimNext()!;
    expect(q.complete(old)).toBe(false);
    q.fail(old, new Error("stale"), policy);
    expect(q.get(fresh.id)).toMatchObject({ status: "running", generation: 2, lastError: null });
    expect(q.complete(fresh)).toBe(true);
  });

  it("fail: outage requeues with backoff and keeps error", () => {
    q.enqueue(1, "s", "k");
    const job = q.claimNext()!;
    q.fail(job, outage, policy);
    expect(q.get(job.id)).toMatchObject({ status: "queued", failures: 0, runAt: t + 1000, lastError: "ECONNREFUSED" });
    expect(q.claimNext()).toBeNull();
  });

  it("fail: gives up after maxFailures; re-enqueue revives with counters reset", () => {
    q.enqueue(1, "s", "k");
    for (let i = 0; i < policy.maxFailures; i++) {
      t += 10_000;
      q.fail(q.claimNext()!, new Error("bad"), policy);
    }
    const failed = q.find(1, "s", "k")!;
    expect(failed).toMatchObject({ status: "failed", failures: 3, attempts: 3, lastError: "bad" });
    t += 10_000;
    expect(q.claimNext()).toBeNull();
    expect(q.enqueue(1, "s", "k")).toMatchObject({ status: "queued", failures: 0, attempts: 0, lastError: null });
  });

  it("recover: running jobs from a crashed process go back to queued", () => {
    q.enqueue(1, "s", "k");
    q.claimNext();
    expect(q.recover()).toBe(1);
    expect(q.claimNext()).toMatchObject({ key: "k", attempts: 2 });
  });

  it("release: hands a job back without counting the attempt", () => {
    q.enqueue(1, "s", "k");
    const job = q.claimNext()!;
    q.release(job);
    expect(q.get(job.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("survives reopening the DB (persistence is the table, nothing in memory)", () => {
    q.enqueue(1, "s", "k", { big: true });
    const q2 = new JobQueue(db, now);
    expect(q2.claimNext()).toMatchObject({ payload: { big: true } });
  });

  it("disabled users' jobs are skipped untouched and resume when re-enabled", () => {
    q.enqueue(1, "s", "alice-job");
    t += 1;
    q.enqueue(2, "s", "bob-job");
    expect(q.claimNext(["bob"])?.key).toBe("bob-job"); // alice's older job skipped
    expect(q.claimNext(["bob"])).toBeNull();
    expect(q.find(1, "s", "alice-job")).toMatchObject({ status: "queued", attempts: 0 });
    expect(q.claimNext([])).toBeNull();
    expect(q.claimNext(["alice"])?.key).toBe("alice-job");
  });

  it("nextRunAt ignores disabled users (else an overdue job makes the runner spin)", () => {
    q.enqueue(1, "s", "k");
    expect(q.nextRunAt(["bob"])).toBeNull();
    expect(q.nextRunAt(["alice"])).toBe(t);
    expect(q.nextRunAt()).toBe(t);
  });

  it("deleting a user deletes their jobs", () => {
    q.enqueue(1, "s", "k");
    db.prepare("DELETE FROM users WHERE id = 1").run();
    expect(q.find(1, "s", "k")).toBeNull();
  });
});

describe("JobRunner.runOnce", () => {
  const quiet = { policy, log: () => {} };

  it("runs the handler and marks done", async () => {
    const seen: unknown[] = [];
    const r = new JobRunner(q, { s: async (job) => void seen.push(job.payload) }, now, quiet);
    q.enqueue(1, "s", "k", 42);
    expect(await r.runOnce()).toMatchObject({ key: "k" });
    expect(seen).toEqual([42]);
    expect(q.find(1, "s", "k")?.status).toBe("done");
    expect(await r.runOnce()).toBeNull();
  });

  it("handler outage keeps the job queued (never lost)", async () => {
    const r = new JobRunner(q, { s: async () => { throw outage; } }, now, quiet);
    q.enqueue(1, "s", "k");
    for (let i = 0; i < 10; i++) {
      await r.runOnce();
      t += 60_000;
    }
    expect(q.find(1, "s", "k")).toMatchObject({ status: "queued", attempts: 10, failures: 0 });
  });

  it("reads enabled users per claim (config reloads live)", async () => {
    let enabled: string[] = [];
    const ran: number[] = [];
    const r = new JobRunner(q, { s: async (j) => void ran.push(j.userId) }, now, { ...quiet, enabledUsers: () => enabled });
    q.enqueue(1, "s", "k");
    expect(await r.runOnce()).toBeNull();
    enabled = ["alice"];
    await r.runOnce();
    expect(ran).toEqual([1]);
  });

  it("unknown job type fails (after retries), doesn't crash", async () => {
    const r = new JobRunner(q, {}, now, quiet);
    q.enqueue(1, "nope", "k");
    for (let i = 0; i < 3; i++) {
      await r.runOnce();
      t += 60_000;
    }
    expect(q.find(1, "nope", "k")).toMatchObject({ status: "failed", lastError: 'no handler for job type "nope"' });
  });

  it("stop() aborts the in-flight handler and releases its job", async () => {
    let started!: () => void;
    const began = new Promise<void>((r) => (started = r));
    const handler: JobHandler = (_job, signal) =>
      new Promise((_, reject) => {
        started();
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { retryable: true })));
      });
    const r = new JobRunner(q, { s: handler }, now, quiet);
    q.enqueue(1, "s", "k");
    r.start();
    await began;
    await r.stop();
    expect(q.find(1, "s", "k")).toMatchObject({ status: "queued", attempts: 0, lastError: null });
  });

  it("start() drains due jobs and kick() picks up new ones", async () => {
    const done: string[] = [];
    const r = new JobRunner(q, { s: async (j) => void done.push(j.key) }, now, quiet);
    q.enqueue(1, "s", "a");
    r.start();
    await waitFor(() => done.length === 1);
    q.enqueue(1, "s", "b");
    r.kick();
    await waitFor(() => done.length === 2);
    await r.stop();
    expect(done).toEqual(["a", "b"]);
  });
});

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
