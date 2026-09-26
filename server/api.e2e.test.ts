import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type {
  DeviceListResponse,
  DeviceMeResponse,
  InstructionsResponse,
  LlmStatusResponse,
  PairResponse,
  SearchResponse,
  SettingsResponse,
  SignupResponse,
  SummarizeResponse,
  TranscriptDetail,
  TranscriptListResponse,
  TranscriptSummaryResponse,
} from "../shared/api.js";
import { createApp, type App } from "./app.js";
import { parseConfig, type Config } from "./config.js";

// Full HTTP flow against an in-process app on a random port + temp data dir; needs nothing external.
let dir: string;
let app: App;
let server: Server;
let base: string;
let config: Config = parseConfig({ users: ["alice"] });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pa-e2e-"));
  app = createApp({ dataDir: dir, getConfig: () => config, version: "test" });
  server = createServer((req, res) => void app.handleApi(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const post = (path: string, body: unknown, headers?: Record<string, string>) =>
  fetch(base + path, { method: "POST", ...json(body, headers) });
// Swift decodes these fixtures; real responses must keep the same keys + JSON types (drift guard).
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
function expectFixtureShape(name: string, actual: unknown): void {
  const fixture = JSON.parse(readFileSync(`shared/fixtures/${name}`, "utf8")) as Record<string, unknown>;
  const shape = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, typeOf(o[k])]));
  expect(shape(actual as Record<string, unknown>)).toEqual(shape(fixture));
}
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];

async function waitFor(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const DEVICE_TOKEN = "d".repeat(43);
const bearer = { authorization: `Bearer ${DEVICE_TOKEN}` };
const upload = JSON.parse(readFileSync("shared/fixtures/transcript-upload.json", "utf8"));

describe("API flow", () => {
  let cookie: string;
  let deviceId: string;

  it("signup: enabled user gets a session cookie, disabled doesn't and can't log in", async () => {
    const a = await post("/api/auth/signup", { username: "Alice", password: "password1" });
    expect(a.status).toBe(201);
    expect((await a.json()) as SignupResponse).toEqual({ username: "alice", enabled: true });
    expect(a.headers.get("set-cookie")).toMatch(/pa_session=.+HttpOnly; SameSite=Lax/);

    const b = await post("/api/auth/signup", { username: "bob", password: "password1" });
    expect((await b.json()) as SignupResponse).toEqual({ username: "bob", enabled: false });
    expect(b.headers.get("set-cookie")).toBeNull();
    expect((await post("/api/auth/login", { username: "bob", password: "password1" })).status).toBe(403);
  });

  it("login → me; wrong password 401; non-JSON body 415", async () => {
    expect((await post("/api/auth/login", { username: "alice", password: "wrong-pass" })).status).toBe(401);
    const res = await post("/api/auth/login", { username: "alice", password: "password1" });
    expect(res.status).toBe(200);
    cookie = cookieOf(res);
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    expect(await me.json()).toEqual({ username: "alice" });
    const form = await fetch(`${base}/api/auth/login`, { method: "POST", body: "username=alice&password=password1" });
    expect(form.status).toBe(415);
  });

  it("web routes need a session; device token doesn't count", async () => {
    expect((await fetch(`${base}/api/transcripts`)).status).toBe(401);
    expect((await fetch(`${base}/api/devices`, { headers: bearer })).status).toBe(401);
  });

  it("pairing: pending until approved with the code shown on the device", async () => {
    const res = await post("/api/devices/pair", { account: "alice", deviceName: "MacBook Pro" }, bearer);
    expect(res.status).toBe(202);
    const pair = (await res.json()) as PairResponse;
    expectFixtureShape("pair-response.json", pair);
    deviceId = pair.deviceId;
    expect(pair.status).toBe("pending");

    const meRes = await fetch(`${base}/api/device/me`, { headers: bearer });
    expect(((await meRes.json()) as DeviceMeResponse).status).toBe("pending");
    expect((await post("/api/device/transcripts", upload, bearer)).status).toBe(403);

    const list = (await (await fetch(`${base}/api/devices`, { headers: { cookie } })).json()) as DeviceListResponse;
    expect(list.devices).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(pair.pairingCode!); // web must not leak the code

    const ok = await post(`/api/devices/${deviceId}/approve`, { pairingCode: pair.pairingCode }, { cookie });
    expect(ok.status).toBe(204);
    const me = (await (await fetch(`${base}/api/device/me`, { headers: bearer })).json()) as DeviceMeResponse;
    expect(me).toEqual({ deviceId, account: "alice", deviceName: "MacBook Pro", status: "active" });
    expectFixtureShape("device-me.json", me);

    const unknown = await post("/api/devices/pair", { account: "nobody", deviceName: "x" }, { authorization: `Bearer ${"e".repeat(43)}` });
    expect(unknown.status).toBe(404);
    expectFixtureShape("error.json", await unknown.json());
  });

  it("transcript ingest is idempotent and readable from the web", async () => {
    const first = await post("/api/device/transcripts", upload, bearer);
    expect(first.status).toBe(201);
    expectFixtureShape("transcript-upload-response.json", await first.json());
    const again = await post("/api/device/transcripts", upload, bearer);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: "6f1c2b7e-3d4a-4e5f-9a8b-1c2d3e4f5a6b", created: false });

    const bad = await post("/api/device/transcripts", { ...upload, id: "nope" }, bearer);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/UUID/);

    const list = (await (await fetch(`${base}/api/transcripts`, { headers: { cookie } })).json()) as TranscriptListResponse;
    expect(list.transcripts).toHaveLength(1);
    expect(list.transcripts[0]).toMatchObject({ title: "Alice / Bob 1:1", deviceName: "MacBook Pro", attendeeCount: 2 });

    const detail = (await (await fetch(`${base}/api/transcripts/${list.transcripts[0].id}`, { headers: { cookie } })).json()) as TranscriptDetail;
    expect(detail.segments).toHaveLength(3);
    expect(detail.deviceId).toBe(deviceId);
    expect((await fetch(`${base}/api/transcripts/nope`, { headers: { cookie } })).status).toBe(404);
  });

  it("search: session required, q validated, hits over segments + attendees", async () => {
    const search = (qs: string) => fetch(`${base}/api/search?${qs}`, { headers: { cookie } });
    expect((await fetch(`${base}/api/search?q=roadmap`)).status).toBe(401);
    expect((await fetch(`${base}/api/search?q=roadmap`, { headers: bearer })).status).toBe(401);
    expect((await search("q=%20")).status).toBe(400);
    expect((await search("q=x&limit=abc")).status).toBe(400);

    const r = (await (await search(`q=${encodeURIComponent('bob "q4 roadmap"')}`)).json()) as SearchResponse;
    expect(r.truncated).toBe(false);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({
      transcript: { id: upload.id.toLowerCase(), title: "Alice / Bob 1:1", deviceName: "MacBook Pro" },
      metaMatch: true,
      segmentMatchCount: 1,
    });
    expect(r.results[0].segments[0].parts.filter((p) => p.match).map((p) => p.text)).toEqual(["Q4 roadmap"]);
    // FTS syntax is literal, never a 500.
    expect((await search(`q=${encodeURIComponent('NEAR( "unclosed title:x *')}`)).status).toBe(200);
    expect(((await (await search("q=zebra")).json()) as SearchResponse).results).toEqual([]);
    // Filters (fixture: started 2026-09-24T07:00:03Z, attendees Alice + Bob).
    const hits = async (qs: string) => ((await (await search(qs)).json()) as SearchResponse).results.length;
    expect(await hits("q=roadmap&with=bob&from=2026-09-24T00:00:00%2B02:00&to=2026-09-25T00:00:00%2B02:00")).toBe(1);
    expect(await hits("q=roadmap&from=2026-09-25T00:00:00Z")).toBe(0);
    expect(await hits("q=roadmap&with=carol")).toBe(0);
    expect(await hits("with=alice")).toBe(1);
    expect((await search("from=2026-09-24")).status).toBe(400);
  });

  it("LLM status: session required; unrouted tasks report off, not an error", async () => {
    expect((await fetch(`${base}/api/llm/status`)).status).toBe(401);
    const res = await fetch(`${base}/api/llm/status`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LlmStatusResponse;
    expect(body.tasks.map((t) => t.task)).toEqual(["summary", "search", "embed"]);
    for (const t of body.tasks) expect(t).toMatchObject({ ok: false, provider: null, model: null, modelListed: null });
  });

  it("upload queues a summary; LLM not configured = job waits (queued), transcript still stored", async () => {
    const id = upload.id.toLowerCase();
    const detail = (await (await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).json()) as TranscriptDetail;
    expect(detail.summary).toBeNull();
    expect(detail.summaryJob).toMatchObject({ status: "queued" });
    // Runner kicked on upload: by now it has tried once and recorded why it's waiting.
    await waitFor(async () => {
      const d = (await (await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).json()) as TranscriptDetail;
      return /not configured/.test(d.summaryJob?.lastError ?? "");
    });
  });

  it("re-summarize with a (fake) LLM routed → summary appears on the transcript", async () => {
    const llm = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "fake", choices: [{ message: { content: "## Summary\n- hiring plan" }, finish_reason: "stop" }] }));
    });
    await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
    try {
      const port = (llm.address() as AddressInfo).port;
      config = parseConfig({
        users: ["alice"],
        llm: { providers: [{ id: "fake", baseUrl: `http://127.0.0.1:${port}/v1` }], tasks: { summary: { provider: "fake", model: "fake" } } },
      });
      const id = upload.id.toLowerCase();
      const rs = await post(`/api/transcripts/${id}/summarize`, {}, { cookie });
      expect(rs.status).toBe(202);
      expect(((await rs.json()) as SummarizeResponse).summaryJob).toMatchObject({ status: "queued", attempts: 0, lastError: null });
      expect((await fetch(`${base}/api/transcripts/${id}/summarize`, { method: "POST", headers: { cookie } })).status).toBe(415); // CSRF guard
      expect((await post(`/api/transcripts/00000000-0000-4000-8000-000000000000/summarize`, {}, { cookie })).status).toBe(404);
      let d!: TranscriptDetail;
      await waitFor(async () => {
        d = (await (await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).json()) as TranscriptDetail;
        return d.summary !== null;
      });
      expect(d.summary).toMatchObject({ text: "## Summary\n- hiring plan", meetingType: "1on1", instructionsSource: "builtin:1on1", provider: "fake", model: "fake", stale: false });
      expect(d.summaryJob).toMatchObject({ status: "done", lastError: null, nextAttemptAt: null });
      // Poll endpoint = same summary fields, without the segments.
      const polled = (await (await fetch(`${base}/api/transcripts/${id.toUpperCase()}/summary`, { headers: { cookie } })).json()) as TranscriptSummaryResponse;
      expect(polled).toEqual({ summary: d.summary, summaryJob: d.summaryJob });
      expect((await fetch(`${base}/api/transcripts/00000000-0000-4000-8000-000000000000/summary`, { headers: { cookie } })).status).toBe(404);
      expect((await fetch(`${base}/api/transcripts/${id}/summary`)).status).toBe(401);

      // Identical re-upload: nothing re-queued, summary stays fresh.
      expect((await post("/api/device/transcripts", upload, bearer)).status).toBe(200);
      d = (await (await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).json()) as TranscriptDetail;
      expect(d.summaryJob?.status).toBe("done");
      expect(d.summary?.stale).toBe(false);

      // Changed re-upload: stale until re-summarized.
      const r = await post("/api/device/transcripts", { ...upload, segments: upload.segments.slice(1) }, bearer);
      expect(r.status).toBe(200);
      await waitFor(async () => {
        d = (await (await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).json()) as TranscriptDetail;
        return d.summaryJob?.status === "done" && d.summary?.stale === false;
      });
    } finally {
      config = parseConfig({ users: ["alice"] });
      await new Promise((r) => llm.close(r));
    }
  });

  it("custom instructions CRUD: validation, CSRF, series list", async () => {
    const put = (path: string, body: unknown, headers: Record<string, string> = { cookie }) =>
      fetch(`${base}/api/instructions${path}`, { method: "PUT", ...json(body, headers) });
    expect((await fetch(`${base}/api/instructions`)).status).toBe(401);
    let r = (await (await fetch(`${base}/api/instructions`, { headers: { cookie } })).json()) as InstructionsResponse;
    expect(r).toEqual({ custom: [], series: [{ seriesId: "AAMkAGI2TG93SERIES=", title: "Alice / Bob 1:1", count: 1, lastStartedAt: "2026-09-24T07:00:03.000Z" }] });

    expect((await put("/default", { text: " Be brief. " })).status).toBe(200);
    const typeRes = await put("/type/1on1", { text: "1on1 custom" });
    expect(await typeRes.json()).toMatchObject({ scope: "type", key: "1on1", text: "1on1 custom" });
    const series = encodeURIComponent("AAMkAGI2TG93SERIES=");
    expect((await put(`/series/${series}`, { text: "SERIES-TEXT" })).status).toBe(200);
    expect((await put("/type/party", { text: "x" })).status).toBe(400);
    expect((await put("/default", { text: "  " })).status).toBe(400);
    expect((await put("/default", { text: "x" }, {})).status).toBe(401);
    expect((await fetch(`${base}/api/instructions/default`, { method: "PUT", headers: { cookie }, body: '{"text":"x"}' })).status).toBe(415);
    expect((await put("/nope/x", { text: "x" })).status).toBe(404);

    r = (await (await fetch(`${base}/api/instructions`, { headers: { cookie } })).json()) as InstructionsResponse;
    expect(r.custom.map((c) => [c.scope, c.key, c.text])).toEqual([
      ["default", "", "Be brief."],
      ["series", "AAMkAGI2TG93SERIES=", "SERIES-TEXT"],
      ["type", "1on1", "1on1 custom"],
    ]);
    expect((await fetch(`${base}/api/instructions/type/1on1`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect((await fetch(`${base}/api/instructions/type/1on1`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    r = (await (await fetch(`${base}/api/instructions`, { headers: { cookie } })).json()) as InstructionsResponse;
    expect(r.custom).toHaveLength(2);
  });

  it("summary model choice: settings + per-run pick; series instructions used", async () => {
    const models: string[] = [];
    const llm = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const model = (JSON.parse(body) as { model: string }).model;
        models.push(model);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model, choices: [{ message: { content: `## S by ${model}` }, finish_reason: "stop" }] }));
      });
    });
    await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
    try {
      const port = (llm.address() as AddressInfo).port;
      config = parseConfig({
        users: ["alice"],
        llm: {
          providers: [
            { id: "local", baseUrl: `http://127.0.0.1:${port}/v1` },
            { id: "paid", baseUrl: `http://127.0.0.1:${port}/v1` },
          ],
          tasks: { summary: [{ provider: "local", model: "small" }, { provider: "paid", model: "big" }] },
        },
      });
      const putSettings = (body: unknown) => fetch(`${base}/api/settings`, { method: "PUT", ...json(body, { cookie }) });
      let s = (await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json()) as SettingsResponse;
      expect(s).toEqual({
        summaryLlm: null,
        summaryLlmChoices: [
          { provider: "local", model: "small", isDefault: true },
          { provider: "paid", model: "big", isDefault: false },
        ],
      });
      expect((await putSettings({ summaryLlm: { provider: "paid", model: "nope" } })).status).toBe(400);
      expect((await putSettings({})).status).toBe(400);
      const ok = await putSettings({ summaryLlm: { provider: "paid", model: "big" } });
      expect(((await ok.json()) as SettingsResponse).summaryLlm).toEqual({ provider: "paid", model: "big" });

      const id = upload.id.toLowerCase();
      const summarizeAndWait = async (body: unknown) => {
        const before = models.length;
        const res = await post(`/api/transcripts/${id}/summarize`, body, { cookie });
        expect(res.status).toBe(202);
        let d!: TranscriptDetail;
        await waitFor(async () => {
          d = (await (await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).json()) as TranscriptDetail;
          return models.length > before && d.summaryJob?.status === "done";
        });
        return d;
      };
      // User setting applies; series instructions (set in the previous test) win.
      let d = await summarizeAndWait({});
      expect(d.summary).toMatchObject({ text: "## S by big", provider: "paid", model: "big", meetingType: "1on1", meetingTypeSource: "rule", instructionsSource: "series:AAMkAGI2TG93SERIES=" });
      // Per-run pick overrides the setting.
      d = await summarizeAndWait({ llm: { provider: "local", model: "small" } });
      expect(d.summary).toMatchObject({ provider: "local", model: "small" });
      expect((await post(`/api/transcripts/${id}/summarize`, { llm: { provider: "x", model: "y" } }, { cookie })).status).toBe(400);

      // Pick removed from config → reported (and used) as default.
      config = parseConfig({ ...config, llm: { providers: config.llm.providers, tasks: { summary: [{ provider: "local", model: "small" }] } } });
      s = (await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json()) as SettingsResponse;
      expect(s.summaryLlm).toBeNull();
    } finally {
      config = parseConfig({ users: ["alice"] });
      await new Promise((r) => llm.close(r));
    }
  });

  describe("`pa transcribe` uploads (shared/fixtures/transcript-upload-pa.json)", () => {
    const paUpload = JSON.parse(readFileSync("shared/fixtures/transcript-upload-pa.json", "utf8"));
    const WINDOW = 12000;
    // vLLM's overflow reply, verbatim shape (verified live on gemma-4-31B).
    const overflow = (n: number) => ({
      error: { message: `This model's maximum context length is ${WINDOW} tokens. However, your prompt contains at least ${n} input tokens.`, type: "BadRequestError", param: "input_tokens", code: 400 },
    });
    let prompts: { kind: string; chars: number; ok: boolean }[] = [];
    let llm: Server;

    beforeAll(async () => {
      // Fake OpenAI-compatible model with a real window (~3 chars/token, like our estimate).
      llm = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const messages = (JSON.parse(body) as { messages: { content: string }[] }).messages;
          const sys = messages[0].content;
          const chars = messages.map((m) => m.content).join("\n").length;
          const kind = sys.startsWith("You classify") ? "classify" : sys.startsWith("You take notes") ? "part" : sys.startsWith("You merge") ? "merge" : messages[1].content.includes("Notes per part") ? "combine" : "single";
          const ok = chars / 3 <= WINDOW;
          prompts.push({ kind, chars, ok });
          res.setHeader("content-type", "application/json");
          if (!ok) {
            res.statusCode = 400;
            res.end(JSON.stringify(overflow(Math.ceil(chars / 3))));
            return;
          }
          const content = kind === "part" ? "- [0:00] migration plan discussed" : `## ${kind} summary`;
          res.end(JSON.stringify({ model: "fake", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: Math.ceil(chars / 3), completion_tokens: 5 } }));
        });
      });
      await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
      // No contextTokens: window unknown → one call, chunk only after an overflow reply.
      config = parseConfig({
        users: ["alice"],
        llm: { providers: [{ id: "fake", baseUrl: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1` }], tasks: { summary: { provider: "fake", model: "fake" } } },
      });
    });
    afterAll(async () => {
      config = parseConfig({ users: ["alice"] });
      await new Promise((r) => llm.close(r));
    });

    const summaryDone = async (id: string) => {
      let d!: TranscriptDetail;
      await waitFor(async () => {
        d = (await (await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).json()) as TranscriptDetail;
        return d.summaryJob?.status === "done" || d.summaryJob?.status === "failed";
      }, 15000);
      return d;
    };

    it("short call: stored as ad-hoc with speakers kept, summarized in one call, searchable", async () => {
      prompts = [];
      const r = await post("/api/device/transcripts", paUpload, bearer);
      expect(r.status).toBe(201);
      const d = await summaryDone(paUpload.id);
      expect(d.meeting).toBeNull();
      expect(d.segments.map((s) => s.speaker)).toEqual(["Alice Example", "Speaker 1", "Speaker 2", "Alice Example", null]);
      // "default": the custom default instruction saved by an earlier test beats built-in adhoc.
      expect(d.summary).toMatchObject({ text: "## single summary", meetingType: "adhoc", meetingTypeSource: "rule", instructionsSource: "default", parts: 1 });
      expect(prompts.map((p) => p.kind)).toEqual(["single"]); // adhoc by rule: no classify call
      const s = (await (await fetch(`${base}/api/search?q=migration`, { headers: { cookie } })).json()) as SearchResponse;
      expect(s.results.map((x) => x.transcript.id)).toContain(paUpload.id);
      const nl = (await (await fetch(`${base}/api/search?q=notulen`, { headers: { cookie } })).json()) as SearchResponse;
      expect(nl.results.map((x) => x.transcript.id)).toEqual([paUpload.id]);
    });

    it("long meeting (~3h) on a model with an unknown, too-small window → overflow → summarized in parts", async () => {
      prompts = [];
      // Fixture's lines repeated for ~3h, as pa would send a long recording.
      const segments = Array.from({ length: 1100 }, (_, i) => {
        const s = paUpload.segments[i % paUpload.segments.length];
        return { ...s, start: i * 10 + (s.start % 10), end: i * 10 + (s.start % 10) + 5 };
      });
      const long = { ...paUpload, id: "5b1d7c3e-9a2f-4e6b-8c0d-1f2e3a4b5c6d", endedAt: "2026-09-24T10:03:00Z", segments };
      expect((await post("/api/device/transcripts", long, bearer)).status).toBe(201);
      const d = await summaryDone(long.id);
      expect(d.summaryJob).toMatchObject({ status: "done", lastError: null });
      expect(d.summary).toMatchObject({ text: "## combine summary", meetingType: "adhoc" });
      expect(d.summary!.parts).toBeGreaterThan(2);
      const kinds = prompts.map((p) => p.kind);
      expect(kinds[0]).toBe("single");
      expect(prompts[0].ok).toBe(false); // real overflow reply from the "server" …
      expect(kinds.at(-1)).toBe("combine"); // … turned into parts + one combine
      expect(prompts.filter((p) => p.kind === "part" && p.ok).length).toBeGreaterThanOrEqual(d.summary!.parts!);
      expect(prompts.filter((p) => p.ok).every((p) => p.kind === "part" || p.kind === "combine")).toBe(true);
    });
  });

  it("delete transcript: gone from detail/list/search, job dropped, re-upload 410, web session required", async () => {
    const id = "0d0d0d0d-0000-4000-8000-00000000de1e";
    const doomed = { ...upload, id, segments: [{ start: 0, end: 2, speaker: "Alice", text: "zyzzyva confidential" }] };
    expect((await post("/api/device/transcripts", doomed, bearer)).status).toBe(201);
    const hits = async () => ((await (await fetch(`${base}/api/search?q=zyzzyva`, { headers: { cookie } })).json()) as SearchResponse).results.length;
    expect(await hits()).toBe(1);
    const del = (path: string, headers: Record<string, string>) => fetch(base + path, { method: "DELETE", headers });

    expect((await del(`/api/transcripts/${id}`, {})).status).toBe(401);
    expect((await del(`/api/transcripts/${id}`, bearer)).status).toBe(401); // device token ≠ web session
    const res = await del(`/api/transcripts/${id.toUpperCase()}`, { cookie });
    expect(res.status).toBe(204);

    expect((await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/transcripts/${id}/summary`, { headers: { cookie } })).status).toBe(404);
    const list = (await (await fetch(`${base}/api/transcripts`, { headers: { cookie } })).json()) as TranscriptListResponse;
    expect(list.transcripts.map((t) => t.id)).not.toContain(id);
    expect(await hits()).toBe(0);
    expect(app.jobs.find(1, "summarize", id)).toBeNull();

    const again = await post("/api/device/transcripts", doomed, bearer);
    expect(again.status).toBe(410);
    expect(((await again.json()) as { message: string }).message).toMatch(/deleted/);
    expect((await del(`/api/transcripts/${id}`, { cookie })).status).toBe(404);
    // Other transcripts untouched.
    expect((await fetch(`${base}/api/transcripts/${upload.id.toLowerCase()}`, { headers: { cookie } })).status).toBe(200);
  });

  it("disabling the user in config cuts off both web session and device", async () => {
    config = parseConfig({ users: [] });
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status).toBe(401);
    expect((await post("/api/device/transcripts", upload, bearer)).status).toBe(401);
    config = parseConfig({ users: ["alice"] });
  });

  it("revoke → device token dead; logout → session dead", async () => {
    const del = await fetch(`${base}/api/devices/${deviceId}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(204);
    expect((await fetch(`${base}/api/device/me`, { headers: bearer })).status).toBe(401);

    const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
    expect(out.status).toBe(204);
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie } })).status).toBe(401);
  });

  it("unknown route 404, wrong method 405, JSON errors", async () => {
    const r = await fetch(`${base}/api/nope`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect((await fetch(`${base}/api/transcripts`, { method: "PUT" })).status).toBe(405);
  });

  it("oversize body is rejected with 413", async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});
