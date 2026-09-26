import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { loadConfig, parseConfig, type Config } from "./config.js";
import { APP_MIGRATIONS, migrate } from "./db.js";
import { JobQueue, JobRunner, type RetryPolicy } from "./jobs.js";
import { createLlm, type Llm } from "./llm.js";

// Part 1: real HTTP against a fake OpenAI server, incl. down → up. Needs nothing external, never skips.
// Part 2: live local LLM (config.json route, else vLLM default :8000); self-skips when down.

const policy: RetryPolicy = { baseMs: 1000, maxMs: 60_000, maxFailures: 3 };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

interface Seen {
  path: string;
  auth: string | undefined;
  body: Record<string, unknown> | null;
}

function fakeOpenAi(port: number, seen: Seen[], mode: { status: number }): Promise<Server> {
  const server = createServer(async (req: IncomingMessage, res) => {
    let text = "";
    for await (const c of req) text += c;
    seen.push({ path: req.url ?? "", auth: req.headers.authorization, body: text ? JSON.parse(text) : null });
    res.setHeader("content-type", "application/json");
    if (mode.status !== 200) {
      res.statusCode = mode.status;
      return void res.end(JSON.stringify({ error: { message: "overloaded" } }));
    }
    if (req.url === "/v1/models") return void res.end(JSON.stringify({ object: "list", data: [{ id: "fake-chat" }] }));
    if (req.url === "/v1/embeddings") {
      const input = (JSON.parse(text) as { input: string[] }).input;
      return void res.end(JSON.stringify({ data: input.map((s, index) => ({ index, embedding: [s.length, 0.5] })) }));
    }
    const msgs = (JSON.parse(text) as { messages: { content: string }[] }).messages;
    res.end(
      JSON.stringify({
        model: "fake-chat",
        choices: [{ message: { role: "assistant", content: `<think>…</think>echo: ${msgs.at(-1)?.content}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

describe("LLM client + job queue over real HTTP (fake provider)", () => {
  let port: number;
  let config: Config;
  let llm: Llm;
  let server: Server | null = null;
  const seen: Seen[] = [];
  const mode = { status: 200 };

  beforeEach(async () => {
    port = await freePort();
    config = parseConfig({
      llm: {
        providers: [{ id: "fake", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test", models: ["fake-chat"] }],
        tasks: { summary: { provider: "fake", model: "fake-chat" }, embed: { provider: "fake", model: "fake-chat" } },
      },
    });
    llm = createLlm({ getConfig: () => config, healthTimeoutMs: 2000 });
    seen.length = 0;
    mode.status = 200;
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server!.close(r));
  });

  it("provider down: health reports it, job stays queued; provider up: same job completes", async () => {
    // Port is free = nothing listening = ECONNREFUSED, like a stopped vLLM.
    expect(await llm.health("summary")).toMatchObject({ ok: false, provider: "fake", modelListed: null, error: expect.stringMatching(/ECONNREFUSED/) });

    const db = new Database(":memory:");
    migrate(db, APP_MIGRATIONS);
    db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'alice', 'x', 0)").run();
    let t = 0;
    const q = new JobQueue(db, () => t);
    const results: string[] = [];
    const runner = new JobRunner(
      q,
      {
        async echo(job, signal) {
          const r = await llm.chat("summary", [{ role: "user", content: String(job.payload) }], { signal });
          results.push(r.text);
        },
      },
      () => t,
      { policy, log: () => {} },
    );

    q.enqueue(1, "echo", "k", "hello");
    await runner.runOnce();
    await runner.runOnce(); // still backing off: nothing claimed
    expect(q.find(1, "echo", "k")).toMatchObject({ status: "queued", attempts: 1, failures: 0, lastError: expect.stringMatching(/ECONNREFUSED/) });

    server = await fakeOpenAi(port, seen, mode);
    mode.status = 503; // up but overloaded: still transient
    t += 1000;
    await runner.runOnce();
    expect(q.find(1, "echo", "k")).toMatchObject({ status: "queued", failures: 0, lastError: expect.stringMatching(/HTTP 503: overloaded/) });

    mode.status = 200;
    t += 2000;
    await runner.runOnce();
    expect(q.find(1, "echo", "k")).toMatchObject({ status: "done", attempts: 3, lastError: null });
    expect(results).toEqual(["echo: hello"]); // think block stripped
    expect(seen.at(-1)).toMatchObject({ path: "/v1/chat/completions", auth: "Bearer sk-test", body: { model: "fake-chat" } });

    expect(await llm.health("summary")).toEqual({ ok: true, provider: "fake", model: "fake-chat", modelListed: true, error: null });
    expect((await llm.embed("embed", ["a", "bbb"])).vectors).toEqual([[1, 0.5], [3, 0.5]]);

    await new Promise((r) => server!.close(r));
    server = null;
  });

  it("hung provider times out as retryable instead of blocking the queue", async () => {
    const hang = createServer(() => {}); // accepts, never replies
    await new Promise<void>((r) => hang.listen(port, "127.0.0.1", r));
    try {
      const slow = createLlm({ getConfig: () => config, chatTimeoutMs: 200 });
      const e = await slow.chat("summary", []).catch((err) => err);
      expect(e).toMatchObject({ retryable: true, message: expect.stringMatching(/timed out after 200 ms/) });
    } finally {
      hang.closeAllConnections();
      await new Promise((r) => hang.close(r));
    }
  });
});

// ---- live local LLM ----

const LOCAL_DEFAULT = "http://localhost:8000/v1";

async function liveConfig(): Promise<Config | null> {
  let base: Config | null = null;
  try {
    base = loadConfig();
  } catch {
    // no config.json on this checkout; probe the default local vLLM instead
  }
  if (base?.llm.tasks.summary) return base;
  try {
    const res = await fetch(`${LOCAL_DEFAULT}/models`, { signal: AbortSignal.timeout(3000) });
    const model = ((await res.json()) as { data?: { id: string }[] }).data?.[0]?.id;
    if (!model) return null;
    return parseConfig({
      llm: { providers: [{ id: "local", baseUrl: LOCAL_DEFAULT, models: [model] }], tasks: { summary: { provider: "local", model } } },
    });
  } catch {
    return null;
  }
}

const live = await liveConfig();
const liveLlm = live && createLlm({ getConfig: () => live });
const chatUp = !!liveLlm && (await liveLlm.health("summary")).ok;
const embedUp = !!liveLlm && (await liveLlm.health("embed")).ok;

describe.skipIf(!chatUp)("live local LLM: chat", () => {
  it("answers a trivial prompt with usage reported", async () => {
    const r = await liveLlm!.chat("summary", [{ role: "user", content: "Reply with exactly the word: pong" }], { temperature: 0, maxTokens: 64 });
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.model).toBeTruthy();
    expect(r.usage.promptTokens).toBeGreaterThan(0);
    // Model quality = soft signal only.
    if (!/pong/i.test(r.text)) console.warn(`live chat: expected "pong", got ${JSON.stringify(r.text)}`);
  });

  it("json mode returns parseable JSON", async () => {
    const r = await liveLlm!.chat(
      "summary",
      [{ role: "user", content: 'Return the JSON object {"a": 1} and nothing else.' }],
      { temperature: 0, maxTokens: 64, json: true },
    );
    expect(() => JSON.parse(r.text)).not.toThrow();
  });
});

describe.skipIf(!embedUp)("live local LLM: embeddings", () => {
  it("returns one same-dimension vector per input", async () => {
    const r = await liveLlm!.embed("embed", ["meeting about budget", "1on1 with Bob", "quarterly planning"]);
    expect(r.vectors).toHaveLength(3);
    expect(new Set(r.vectors.map((v) => v.length)).size).toBe(1);
  });
});

describe.skipIf(!chatUp)("live local LLM: summarize job", () => {
  it("summarizes the fixture transcript end to end (handler → LLM → summaries table)", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Store } = await import("./db.js");
    const { parseTranscriptUpload, upsertTranscript } = await import("./transcripts.js");
    const { getSummary, summarizeHandler } = await import("./summaries.js");

    const dir = mkdtempSync(join(tmpdir(), "pa-live-sum-"));
    const store = new Store(dir);
    try {
      const raw = readFileSync("shared/fixtures/transcript-upload.json", "utf8");
      const base = JSON.parse(raw);
      // Enough content for a real summary: decisions + an action item.
      base.segments.push(
        { start: 16, end: 30, speaker: "Speaker 2", text: "We agreed to open two backend roles this quarter, and I will write the job descriptions by Friday." },
        { start: 31, end: 40, speaker: "Alice Example", text: "Great. I'll ask finance to confirm the budget. Can we revisit onboarding next week?" },
      );
      const t = parseTranscriptUpload(base);
      upsertTranscript(store.user(1), "dev", t, raw, Date.now());
      await summarizeHandler({ store, llm: liveLlm!, now: Date.now })(
        { id: 1, userId: 1, type: "summarize", key: t.id, payload: null, status: "running", generation: 1, attempts: 1, failures: 0, runAt: 0, lastError: null, createdAt: 0, updatedAt: 0 },
        new AbortController().signal,
      );
      const s = getSummary(store.user(1), t.id);
      expect(s).toMatchObject({ meetingType: "1on1", instructionsSource: "builtin:1on1", stale: false });
      expect(s!.text.length).toBeGreaterThan(20);
      // Quality = soft: eyeball it in the test output.
      console.log(`live summary (${s!.model}):\n${s!.text}`);
      if (!/##/.test(s!.text) || !/two|2/.test(s!.text)) console.warn("live summary: missing headings or the 'two roles' decision");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!chatUp)("live local LLM: meeting classification", () => {
  it("ambiguous meetings get a parseable type from the LLM (not the fallback)", async () => {
    const { readFileSync } = await import("node:fs");
    const { classifyByRule, classifyMeeting } = await import("./summaries.js");
    const { parseTranscriptUpload } = await import("./transcripts.js");
    const base = JSON.parse(readFileSync("shared/fixtures/transcript-upload.json", "utf8"));
    const cases = [
      {
        expect: "external",
        title: "Acme Corp x Initech: renewal",
        attendees: ["me@initech.com", "pm@initech.com", "buyer@acme.com", "cto@acme.com"],
        lines: ["Thanks for having us. Our main concern with the renewal is the price increase.", "Understood, we can offer a discount if you sign for two years."],
      },
      {
        expect: "meeting",
        title: "Q4 planning",
        attendees: ["a@initech.com", "b@initech.com", "c@initech.com", "d@initech.com"],
        lines: ["Let's go through the roadmap items for Q4 and decide priorities.", "I think the billing migration has to come first."],
      },
    ];
    for (const c of cases) {
      const t = parseTranscriptUpload({
        ...base,
        meeting: { ...base.meeting, title: c.title, attendees: c.attendees.map((email) => ({ name: null, email })) },
        segments: c.lines.map((text, i) => ({ start: i * 10, end: i * 10 + 9, speaker: `Speaker ${(i % 2) + 1}`, text })),
      });
      expect(classifyByRule(t)).toBeNull();
      const r = await classifyMeeting(t, liveLlm!);
      // Hard gate: reply was parseable. Which type = model quality, soft.
      expect(r.source).toBe("llm");
      if (r.type !== c.expect) console.warn(`live classify "${c.title}": expected ${c.expect}, got ${r.type}`);
      else console.log(`live classify "${c.title}": ${r.type}`);
    }
  });
});
