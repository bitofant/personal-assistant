import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type {
  AuthOptionsResponse,
  DeviceListResponse,
  DeviceMeResponse,
  InstructionsResponse,
  LiveTranscriptResponse,
  LlmStatusResponse,
  PairResponse,
  SearchResponse,
  SettingsResponse,
  SignupResponse,
  SpeakerNamesResponse,
  SpeakerSuggestionsResponse,
  SummarizeResponse,
  TranscriptDetail,
  TranscriptListResponse,
  TranscriptSummaryResponse,
  UserExport,
} from "../shared/api.js";
import { createApp, type App } from "./app.js";
import { backupData } from "./backup.js";
import { parseConfig, type Config } from "./config.js";

// Full HTTP flow against an in-process app on a random port + temp data dir; needs nothing external.
let dir: string;
let app: App;
let server: Server;
let base: string;
let config: Config = parseConfig({ users: ["alice"], auth: { signup: true } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pa-e2e-"));
  app = createApp({ dataDir: dir, getConfig: () => config, version: "test", passwordAttemptIntervalMs: 0 });
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

      // Spoken note (`pa note`): kind round-trips, summarized with the note instructions, list marks it.
      const noteId = "4f0c2a8e-2b1d-4c3e-9f5a-0d6b7e8f9a10";
      expect((await post("/api/device/transcripts", { ...upload, id: noteId, meeting: null, kind: "note" }, bearer)).status).toBe(201);
      await waitFor(async () => {
        d = (await (await fetch(`${base}/api/transcripts/${noteId}`, { headers: { cookie } })).json()) as TranscriptDetail;
        return d.summary !== null;
      });
      expect(d.kind).toBe("note");
      expect(d.summary).toMatchObject({ meetingType: "note", meetingTypeSource: "rule", instructionsSource: "builtin:note" });
      const list = (await (await fetch(`${base}/api/transcripts`, { headers: { cookie } })).json()) as TranscriptListResponse;
      expect(list.transcripts.find((x) => x.id === noteId)?.kind).toBe("note");
      expect(list.transcripts.find((x) => x.id === id)).not.toHaveProperty("kind");
      // Later tests count this device's transcripts.
      expect((await fetch(`${base}/api/transcripts/${noteId}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
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
    // Summary from the previous test used built-in 1on1 → now outdated, while the transcript itself isn't.
    const sum = (await (await fetch(`${base}/api/transcripts/${upload.id.toLowerCase()}/summary`, { headers: { cookie } })).json()) as TranscriptSummaryResponse;
    expect(sum.summary).toMatchObject({ instructionsSource: "builtin:1on1", instructionsChanged: true, stale: false });
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

  it("speaker names: PUT validates, detail + search + export show them, summary goes stale", async () => {
    const id = upload.id.toLowerCase();
    const get = async () => (await (await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).json()) as TranscriptDetail;
    const put = (body: unknown, headers: Record<string, string> = { cookie }) =>
      fetch(`${base}/api/transcripts/${id}/speakers`, { method: "PUT", ...json(body, headers) });
    const t = await get();
    expect(t.speakerNames).toEqual({});
    const label = t.segments.find((s) => s.speaker)!.speaker!;

    expect((await put({ names: { [label]: "Zed" } }, {})).status).toBe(401);
    expect((await put({ names: { "No Such Speaker": "Zed" } })).status).toBe(400);
    const csrf = await fetch(`${base}/api/transcripts/${id}/speakers`, { method: "PUT", headers: { cookie, "content-type": "text/plain" }, body: "{}" });
    expect(csrf.status).toBe(415);
    expect((await fetch(`${base}/api/transcripts/0d0d0d0d-0000-4000-8000-000000000000/speakers`, { method: "PUT", ...json({ names: {} }, { cookie }) })).status).toBe(404);

    const before = t.updatedAt;
    const r = await put({ names: { [label]: "  Zed Zebra " } });
    expect(r.status).toBe(200);
    expect((await r.json()) as SpeakerNamesResponse).toEqual({ speakerNames: { [label]: "Zed Zebra" }, autoSpeakers: {} });
    const after = await get();
    expect(after.speakerNames).toEqual({ [label]: "Zed Zebra" });
    expect(after.segments.find((s) => s.speaker === label)).toBeTruthy(); // raw labels kept
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before));
    if (after.summary) expect(after.summary.stale).toBe(true);

    const word = after.segments.find((s) => s.speaker === label)!.text.split(/\W+/).find((w) => w.length > 3)!;
    const sr = (await (await fetch(`${base}/api/search?q=${encodeURIComponent(word)}`, { headers: { cookie } })).json()) as SearchResponse;
    const hit = sr.results.find((x) => x.transcript.id === id)!;
    expect(hit.segments.some((s) => s.speaker === "Zed Zebra")).toBe(true);

    const ex = await fetch(`${base}/api/export`, { headers: { cookie } });
    expect(ex.status).toBe(200);
    expect(ex.headers.get("content-disposition")).toMatch(/^attachment; filename="personal-assistant-alice-\d{4}-\d\d-\d\d\.json"$/);
    const data = (await ex.json()) as UserExport;
    expect(data).toMatchObject({ format: "personal-assistant-export/1", username: "alice" });
    const mine = data.transcripts.find((x) => x.transcript.id === id)!;
    expect(mine.speakerNames).toEqual({ [label]: "Zed Zebra" });
    expect(mine.transcript.segments.length).toBe(t.segments.length);
    expect(mine.deviceName).toBe("MacBook Pro");
    expect(data.devices.map((d) => d.id)).toContain(deviceId);
    expect((await fetch(`${base}/api/export`)).status).toBe(401);

    expect((await put({ names: { [label]: null } })).status).toBe(200);
    expect((await get()).speakerNames).toEqual({});
  });

  it("speaker suggestions: LLM proposes, never applied; changed re-upload clears them", async () => {
    const paUpload = JSON.parse(readFileSync("shared/fixtures/transcript-upload-pa.json", "utf8"));
    const id = paUpload.id.toLowerCase();
    const path = `/api/transcripts/${id}/speakers/suggestions`;
    const get = async () => (await (await fetch(base + path, { headers: { cookie } })).json()) as SpeakerSuggestionsResponse;
    const llm = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const sys = (JSON.parse(body) as { messages: { content: string }[] }).messages[0].content;
        const content = sys.startsWith("You identify speakers") ? '{"Speaker 1": {"name": "Bob", "evidence": "thanks Bob"}, "Alice Example": "Mallory"}' : "## S";
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: "fake", choices: [{ message: { content }, finish_reason: "stop" }] }));
      });
    });
    await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
    try {
      config = parseConfig({
        users: ["alice"],
        llm: { providers: [{ id: "fake", baseUrl: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1` }], tasks: { summary: { provider: "fake", model: "fake" } } },
      });
      expect(await get()).toEqual({ suggestions: {}, job: null, matches: {} });
      expect((await fetch(base + path)).status).toBe(401);
      expect((await fetch(base + path, { method: "POST", headers: { cookie } })).status).toBe(415); // CSRF guard
      expect((await post(`/api/transcripts/0d0d0d0d-0000-4000-8000-000000000000/speakers/suggestions`, {}, { cookie })).status).toBe(404);

      const r = await post(path, {}, { cookie });
      expect(r.status).toBe(202);
      expect(((await r.json()) as SpeakerSuggestionsResponse).job).toMatchObject({ status: "queued" });
      let s!: SpeakerSuggestionsResponse;
      await waitFor(async () => (s = await get()).job?.status === "done");
      expect(s.suggestions).toEqual({ "Speaker 1": { name: "Bob", evidence: "thanks Bob" } }); // unasked label dropped
      const d = (await (await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).json()) as TranscriptDetail;
      expect(d.speakerNames).toEqual({});

      expect((await post("/api/device/transcripts", { ...paUpload, segments: paUpload.segments.slice(1) }, bearer)).status).toBe(200);
      expect((await get()).suggestions).toEqual({});
    } finally {
      config = parseConfig({ users: ["alice"] });
      await new Promise((r) => llm.close(r));
    }
  });

  it("devices: list shows upload stats; PATCH renames (CSRF, validation), device API sees the new name", async () => {
    const list = async () => ((await (await fetch(`${base}/api/devices`, { headers: { cookie } })).json()) as DeviceListResponse).devices;
    const before = (await list()).find((d) => d.id === deviceId)!;
    // Earlier tests uploaded the meeting + both pa fixtures (one deleted again) from this device.
    expect(before.transcriptCount).toBe(3);
    expect(before.lastUploadAt).not.toBeNull();
    const patch = (body: unknown, headers: Record<string, string> = { cookie }) => fetch(`${base}/api/devices/${deviceId}`, { method: "PATCH", ...json(body, headers) });
    expect((await patch({ name: "x" }, {})).status).toBe(401);
    expect((await patch({ name: "x" }, bearer)).status).toBe(401); // device token ≠ web session
    expect((await fetch(`${base}/api/devices/${deviceId}`, { method: "PATCH", headers: { cookie }, body: '{"name":"x"}' })).status).toBe(415);
    expect((await patch({ name: " " })).status).toBe(400);
    expect((await fetch(`${base}/api/devices/nope`, { method: "PATCH", ...json({ name: "x" }, { cookie }) })).status).toBe(404);
    const r = await patch({ name: " Work Mac " });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: deviceId, name: "Work Mac", transcriptCount: 3 });
    expect(((await (await fetch(`${base}/api/device/me`, { headers: bearer })).json()) as DeviceMeResponse).deviceName).toBe("Work Mac");
    const list1 = (await (await fetch(`${base}/api/transcripts`, { headers: { cookie } })).json()) as TranscriptListResponse;
    expect(list1.transcripts.every((t) => t.deviceName === "Work Mac")).toBe(true);
    // Unchanged re-upload (device retry) still counts as an upload.
    await new Promise((res) => setTimeout(res, 5));
    expect((await post("/api/device/transcripts", upload, bearer)).status).toBe(200);
    expect(Date.parse((await list()).find((d) => d.id === deviceId)!.lastUploadAt!)).toBeGreaterThan(Date.parse(before.lastUploadAt!));
  });

  it("auto speaker names: voice learns from user names, calendar elimination, confirm, export", async () => {
    const detail = async (id: string) => (await (await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).json()) as TranscriptDetail;
    const put = (id: string, names: Record<string, string | null>) => fetch(`${base}/api/transcripts/${id}/speakers`, { method: "PUT", ...json({ names }, { cookie }) });
    const segs = (labels: string[]) => labels.map((speaker, i) => ({ start: i * 30, end: i * 30 + 29, speaker, text: `words ${i}` }));
    const base0 = { startedAt: "2026-09-25T07:00:00Z", endedAt: "2026-09-25T08:00:00Z", meeting: null, asrModel: "asr", diarizationModel: "diar-x" };
    const A = "a0a0a0a0-0000-4000-8000-000000000001";
    const B = "a0a0a0a0-0000-4000-8000-000000000002";
    const C = "a0a0a0a0-0000-4000-8000-000000000003";

    // A: Speaker 1 has a voice; the user names it.
    const a = { ...base0, id: A, segments: segs(["Me", "Speaker 1", "Speaker 2"]), speakerEmbeddings: { "Speaker 1": [1, 0, 0, 0], "Speaker 2": [0, 1, 0, 0] } };
    expect((await post("/api/device/transcripts", a, bearer)).status).toBe(201);
    expect((await detail(A)).autoSpeakers).toEqual({});
    expect((await put(A, { "Speaker 1": "Bob" })).status).toBe(200);

    // B: same voice under another label → auto-named at upload, before anything else reads the names.
    const b = { ...base0, id: B, segments: segs(["Me", "Speaker 1", "Speaker 2"]), speakerEmbeddings: { "Speaker 1": [0, 0, 1, 0], "Speaker 2": [0.98, 0.05, 0, 0] } };
    expect((await post("/api/device/transcripts", b, bearer)).status).toBe(201);
    const db = await detail(B);
    expect(db.speakerNames).toEqual({ "Speaker 2": "Bob" });
    expect(db.autoSpeakers).toEqual({ "Speaker 2": { name: "Bob", reason: "voice", score: expect.closeTo(0.999, 2) } });
    expect("speakerEmbeddings" in db).toBe(false); // vectors never shipped with the transcript
    // Confirm = same name back → user name, no stale bump.
    const r = (await (await put(B, { "Speaker 2": "Bob" })).json()) as SpeakerNamesResponse;
    expect(r).toEqual({ speakerNames: { "Speaker 2": "Bob" }, autoSpeakers: {} });
    expect((await detail(B)).updatedAt).toBe(db.updatedAt);

    // C: 1on1 from the calendar; the user is marked isSelf → the remote speaker is the other invitee.
    const meeting = {
      calendarName: "Work", eventId: "ev-c", seriesId: null, title: "Carol / me", start: base0.startedAt, end: base0.endedAt,
      organizer: { name: "Carol Danvers", email: "carol@x.com" },
      attendees: [{ name: "Joran T", email: "me@x.com", isSelf: true }, { name: "Carol Danvers", email: "carol@x.com" }],
    };
    expect((await post("/api/device/transcripts", { ...base0, id: C, meeting, segments: segs(["Me", "Speaker 1"]) }, bearer)).status).toBe(201);
    expect((await detail(C)).autoSpeakers).toEqual({ "Speaker 1": { name: "Carol Danvers", reason: "calendar", score: null } });
    // User clears it → unnamed; offered again as a match (not re-applied).
    await put(C, { "Speaker 1": null });
    expect((await detail(C)).speakerNames).toEqual({});
    const sugg = (await (await fetch(`${base}/api/transcripts/${C}/speakers/suggestions`, { headers: { cookie } })).json()) as SpeakerSuggestionsResponse;
    expect(sugg.matches).toEqual({ "Speaker 1": { name: "Carol Danvers", reason: "calendar", score: null } });

    const ex = (await (await fetch(`${base}/api/export`, { headers: { cookie } })).json()) as UserExport;
    const xb = ex.transcripts.find((x) => x.transcript.id === B)!;
    expect(xb.speakerEmbeddings["Speaker 1"]).toEqual([0, 0, 1, 0]); // stored unit-length
    expect(xb.autoSpeakers).toEqual({});
    expect(ex.transcripts.find((x) => x.transcript.id === C)!.transcript.meeting!.attendees[0].isSelf).toBe(true);

    for (const id of [A, B, C]) expect((await fetch(`${base}/api/transcripts/${id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
  });

  it("live preview: chunks → list + cursor poll → final upload replaces it; late chunk refused; delete → 410; discard", async () => {
    const liveChunk = JSON.parse(readFileSync("shared/fixtures/live-chunk.json", "utf8"));
    const id = "1e1e1e1e-0000-4000-8000-00000000a11e";
    const livePath = `/api/device/transcripts/${id}/live`;
    const getLive = async (after = 0) => {
      const r = await fetch(`${base}/api/transcripts/${id}/live?after=${after}`, { headers: { cookie } });
      return { status: r.status, body: (await r.json()) as LiveTranscriptResponse };
    };
    const listed = async () => ((await (await fetch(`${base}/api/transcripts`, { headers: { cookie } })).json()) as TranscriptListResponse).transcripts.find((t) => t.id === id);

    expect((await post(livePath, liveChunk)).status).toBe(401);
    expect((await post("/api/device/transcripts/nope/live", liveChunk, bearer)).status).toBe(400);
    expect((await post(livePath, { ...liveChunk, stream: "x" }, bearer)).status).toBe(400);
    const first = await post(`/api/device/transcripts/${id.toUpperCase()}/live`, liveChunk, bearer); // id canonicalized
    expect(first.status).toBe(200);
    expectFixtureShape("live-chunk-response.json", await first.json());
    expect((await fetch(`${base}/api/transcripts/${id}/live`)).status).toBe(401);
    expect((await fetch(`${base}/api/transcripts/${id}/live`, { headers: bearer })).status).toBe(401); // device token ≠ web session

    const a = await getLive();
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ id, status: "live", deviceName: "Work Mac", segments: [{ stream: "system", speaker: "Others" }] });
    expect(await listed()).toMatchObject({ live: "live", title: "Alice / Bob 1:1", segmentCount: 1 });
    // Detail = 404 while only the preview exists (web then shows the live view).
    expect((await fetch(`${base}/api/transcripts/${id}`, { headers: { cookie } })).status).toBe(404);

    expect((await post(livePath, liveChunk, bearer)).status).toBe(200); // retry: no duplicate
    const mic = { ...liveChunk, stream: "mic", seq: 0, segments: [{ start: 5, end: 6, speaker: "Alice Example", text: "Yes, release first." }] };
    expect((await post(livePath, mic, bearer)).status).toBe(200);
    const b = await getLive(a.body.cursor);
    expect(b.body.segments.map((s) => s.text)).toEqual(["Yes, release first."]);
    expect((await post(livePath, { ...liveChunk, seq: 1, segments: [], ended: true }, bearer)).status).toBe(200);
    expect((await getLive(b.body.cursor)).body).toMatchObject({ status: "ended", segments: [] });

    const final = { ...upload, id };
    expect((await post("/api/device/transcripts", final, bearer)).status).toBe(201);
    expect((await getLive()).body).toMatchObject({ status: "final", segments: [] });
    expect((await listed())?.live).toBeUndefined();
    const late = await post(livePath, { ...liveChunk, seq: 2 }, bearer);
    expect(await late.json()).toEqual({ accepted: false });
    expect((await listed())?.live).toBeUndefined();

    // Deleting from the web while recording: the Mac's next chunk + final upload get 410.
    const id2 = "1e1e1e1e-0000-4000-8000-00000000a12e";
    expect((await post(`/api/device/transcripts/${id2}/live`, liveChunk, bearer)).status).toBe(200);
    expect((await fetch(`${base}/api/transcripts/${id2}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect((await fetch(`${base}/api/transcripts/${id2}/live`, { headers: { cookie } })).status).toBe(404);
    expect((await post(`/api/device/transcripts/${id2}/live`, { ...liveChunk, seq: 1 }, bearer)).status).toBe(410);
    expect((await post("/api/device/transcripts", { ...upload, id: id2 }, bearer)).status).toBe(410);

    // Discarded recording (too short): preview dropped, no tombstone.
    const id3 = "1e1e1e1e-0000-4000-8000-00000000a13e";
    expect((await post(`/api/device/transcripts/${id3}/live`, liveChunk, bearer)).status).toBe(200);
    expect((await fetch(`${base}/api/device/transcripts/${id3}/live`, { method: "DELETE", headers: bearer })).status).toBe(204);
    expect((await fetch(`${base}/api/device/transcripts/${id3}/live`, { method: "DELETE", headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/transcripts/${id3}/live`, { headers: { cookie } })).status).toBe(404);

    expect((await fetch(`${base}/api/transcripts/${id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
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

  it("signup switch: options endpoint + 403 when off (live config)", async () => {
    const opts = async () => (await (await fetch(`${base}/api/auth/options`)).json()) as AuthOptionsResponse;
    const prev = config;
    try {
      config = parseConfig({ users: ["alice"], auth: { signup: true } });
      expect(await opts()).toEqual({ signup: true });
      config = parseConfig({ users: ["alice"] });
      expect(await opts()).toEqual({ signup: false });
      const r = await post("/api/auth/signup", { username: "mallory", password: "password1" });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { message: string }).message).toMatch(/disabled/);
    } finally {
      config = prev;
    }
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

describe("login throttle (default interval)", () => {
  it("second attempt within 1s → 429 + Retry-After, JSON body", async () => {
    const d = mkdtempSync(join(tmpdir(), "pa-e2e-throttle-"));
    const a = createApp({ dataDir: d, getConfig: () => config, version: "test" });
    const s = createServer((req, res) => void a.handleApi(req, res));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/auth/login`;
    const login = () => fetch(url, { method: "POST", ...json({ username: "nobody", password: "password1" }) });
    try {
      expect((await login()).status).toBe(401);
      const r = await login();
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("1");
      expect(((await r.json()) as { message: string }).message).toMatch(/Too many attempts/);
    } finally {
      await new Promise((r) => s.close(r));
      await a.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("account delete", () => {
  it("password re-checked; account, sessions, devices, user DB and backup copies gone; username free again", async () => {
    const d = mkdtempSync(join(tmpdir(), "pa-e2e-account-"));
    const backups = join(d, "backups");
    const cfg = parseConfig({ users: ["alice", "dave"], auth: { signup: true }, backup: { dir: backups } });
    const a = createApp({ dataDir: join(d, "data"), getConfig: () => cfg, version: "test", passwordAttemptIntervalMs: 0 });
    const s = createServer((req, res) => void a.handleApi(req, res));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const signup = async (username: string) => {
      const r = await fetch(`${url}/api/auth/signup`, { method: "POST", ...json({ username, password: "password1" }) });
      return { cookie: cookieOf(r) };
    };
    const del = (cookie: string, body: unknown) => fetch(`${url}/api/account`, { method: "DELETE", ...json(body, { cookie }) });
    try {
      const alice = await signup("alice");
      const dave = await signup("dave");
      // Both users get a DB (export opens it); then a backup holds both.
      for (const u of [alice, dave]) expect((await fetch(`${url}/api/export`, { headers: { cookie: u.cookie } })).status).toBe(200);
      const snap = backupData(join(d, "data"), { dir: backups, keep: 3 }, Date.UTC(2026, 8, 1)).snapshot;
      expect(readdirSync(join(backups, snap, "users")).sort()).toEqual(["1.db", "2.db"]);

      expect((await del(dave.cookie, { password: "wrong-password" })).status).toBe(403);
      expect((await fetch(`${url}/api/auth/me`, { headers: { cookie: dave.cookie } })).status).toBe(200); // still logged in
      expect((await del(dave.cookie, {})).status).toBe(400);
      const ok = await del(dave.cookie, { password: "password1" });
      expect(ok.status).toBe(204);
      expect(ok.headers.get("set-cookie")).toMatch(/pa_session=;.*Max-Age=0/);

      expect((await fetch(`${url}/api/auth/me`, { headers: { cookie: dave.cookie } })).status).toBe(401);
      expect(existsSync(join(d, "data", "users", "2.db"))).toBe(false);
      expect(readdirSync(join(backups, snap, "users"))).toEqual(["1.db"]);
      const login = await fetch(`${url}/api/auth/login`, { method: "POST", ...json({ username: "dave", password: "password1" }) });
      expect(login.status).toBe(401);
      // Other users untouched.
      expect((await fetch(`${url}/api/auth/me`, { headers: { cookie: alice.cookie } })).status).toBe(200);
      // Re-signup (SQLite may reuse id 2) = a fresh, working account.
      const again = await signup("dave");
      const ex = (await (await fetch(`${url}/api/export`, { headers: { cookie: again.cookie } })).json()) as UserExport;
      expect(ex).toMatchObject({ username: "dave", transcripts: [], devices: [] });
    } finally {
      await new Promise((r) => s.close(r));
      await a.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
