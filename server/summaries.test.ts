import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { TranscriptUpload } from "../shared/api.js";
import { migrate, Store, USER_MIGRATIONS } from "./db.js";
import type { Job } from "./jobs.js";
import { resolveInstructions } from "../shared/instructions.js";
import { putInstruction } from "./instructions.js";
import { LlmError, type ChatMessage, type ChatOptions, type ChatResult, type Llm } from "./llm.js";
import { setSummaryLlm } from "./settings.js";
import {
  addUsage,
  buildClassifyPrompt,
  buildCombinePrompt,
  buildPartPrompt,
  buildSummaryPrompt,
  chunkSegments,
  estimateTokens,
  FALLBACK_CONTEXT_TOKENS,
  fitsInOneCall,
  formatSegments,
  groupNotes,
  inputBudgetChars,
  partLabel,
  replyReserve,
  summarizeTranscript,
  type PartNotes,
  classifyByRule,
  classifyMeeting,
  formatTranscriptLines,
  getSummary,
  parseClassifyReply,
  parseSummaryReply,
  saveSummary,
  summarizeHandler,
} from "./summaries.js";
import { parseTranscriptUpload, upsertTranscript } from "./transcripts.js";

const RAW = readFileSync("shared/fixtures/transcript-upload.json", "utf8");
const fixture = (over: Partial<TranscriptUpload> = {}) => parseTranscriptUpload({ ...JSON.parse(RAW), ...over });

const NONE = { series: null, type: null, default: null };
const builtin = (type: Parameters<typeof resolveInstructions>[0]) => resolveInstructions(type, null, NONE);

/** Fixture with n attendees and a title (fixture = 2 attendees, "Alice / Bob 1:1"). */
function withMeeting(title: string | null, n: number): TranscriptUpload {
  const t = fixture();
  const attendees = Array.from({ length: n }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.com` }));
  return { ...t, meeting: { ...t.meeting!, title, attendees } };
}

const reply = (text: string, extra: Partial<ChatResult> = {}): ChatResult => ({
  text,
  model: "m1",
  provider: "local",
  finishReason: "stop",
  usage: { promptTokens: 100, completionTokens: 20 },
  ...extra,
});

describe("classifyByRule", () => {
  it("no event = adhoc; title keywords win; 2 attendees = 1on1; otherwise unknown", () => {
    expect(classifyByRule(fixture({ meeting: null }))).toBe("adhoc");
    expect(classifyByRule(fixture())).toBe("1on1");
    expect(classifyByRule(withMeeting("Weekly sync", 2))).toBe("1on1");
    for (const title of ["Alice 1:1", "alice/bob 1-1", "1on1 Bob", "One-on-one"]) expect(classifyByRule(withMeeting(title, 3))).toBe("1on1");
    for (const title of ["Team stand-up", "Standup", "Daily", "Scrum"]) expect(classifyByRule(withMeeting(title, 6))).toBe("standup");
    expect(classifyByRule(withMeeting("Interview: Jane Doe (backend)", 2))).toBe("interview");
    expect(classifyByRule(withMeeting("Interview debrief Jane", 4))).toBeNull();
    expect(classifyByRule(withMeeting("Q4 planning", 5))).toBeNull();
    expect(classifyByRule(withMeeting(null, 0))).toBeNull();
    expect(classifyByRule(withMeeting("Update 11:15", 5))).toBeNull(); // "1:1" inside a time isn't a 1:1
  });
});

describe("pa transcribe upload (shared/fixtures/transcript-upload-pa.json)", () => {
  const pa = parseTranscriptUpload(JSON.parse(readFileSync("shared/fixtures/transcript-upload-pa.json", "utf8")));

  it("no calendar event → adhoc by rule (no LLM classify); prompt keeps speakers, marks unknown, keeps the Dutch line", () => {
    expect(classifyByRule(pa)).toBe("adhoc");
    const [, user] = buildSummaryPrompt(pa, builtin("adhoc"));
    expect(user.content).toContain("Title: (none: unscheduled call)");
    expect(user.content).toContain("(2m)");
    expect(user.content).toContain("[0:00] Alice Example: Morning! Can everyone hear me?");
    expect(user.content).toContain("[0:03] Speaker 1: Yes, loud and clear.");
    expect(user.content).toContain("[0:14] Unknown speaker: Kan iemand de notulen bijhouden?");
  });
});

describe("parseClassifyReply", () => {
  it("bare id, JSON, label, decorated word; unknown/adhoc = null", () => {
    expect(parseClassifyReply("external")).toBe("external");
    expect(parseClassifyReply(" `Standup`. ")).toBe("standup");
    expect(parseClassifyReply('{"type": "interview"}')).toBe("interview");
    expect(parseClassifyReply("```json\n{\"type\":\"1on1\"}\n```")).toBe("1on1");
    expect(parseClassifyReply("Stand-up")).toBe("standup");
    expect(parseClassifyReply("1:1")).toBe("1on1");
    expect(parseClassifyReply("This is a standup meeting")).toBeNull();
    expect(parseClassifyReply("adhoc")).toBeNull();
    expect(parseClassifyReply('{"type": 3}')).toBeNull();
    expect(parseClassifyReply("")).toBeNull();
  });
});

describe("buildClassifyPrompt", () => {
  it("lists LLM-pickable types (not adhoc), metadata and a bounded transcript excerpt", () => {
    const long = withMeeting("Q4 planning", 5);
    long.segments = Array.from({ length: 500 }, (_, i) => ({ start: i, end: i + 1, speaker: i % 2 ? "A" : "B", text: "blah ".repeat(10) }));
    const [sys, user] = buildClassifyPrompt(long);
    expect(sys.content).toMatch(/- external: .*customers/);
    expect(sys.content).not.toContain("adhoc");
    expect(user.content).toContain("Title: Q4 planning");
    expect(user.content).toContain("P4 <p4@example.com>");
    expect(user.content.length).toBeLessThan(4600);
    expect(user.content).toMatch(/\[…\]$/);
  });
});

describe("classifyMeeting", () => {
  const fakeLlm = (impl: () => Promise<Partial<ChatResult>>) => {
    const calls: ChatOptions[] = [];
    const llm = {
      chat: async (_task: string, _m: ChatMessage[], o: ChatOptions) => (calls.push(o), reply("", await impl())),
    } as unknown as Llm;
    return { llm, calls };
  };

  it("rule hit = no LLM call", async () => {
    const { llm, calls } = fakeLlm(async () => ({ text: "external" }));
    expect(await classifyMeeting(fixture(), llm)).toEqual({ type: "1on1", source: "rule" });
    expect(calls).toHaveLength(0);
  });

  it("ambiguous → LLM (with the chosen route); unusable reply or bad request → meeting/fallback", async () => {
    const t = withMeeting("Q4 planning", 5);
    const route = { provider: "paid", model: "big" };
    const ok = fakeLlm(async () => ({ text: "external" }));
    expect(await classifyMeeting(t, ok.llm, { route })).toEqual({ type: "external", source: "llm" });
    expect(ok.calls[0]).toMatchObject({ route, temperature: 0 });
    expect(await classifyMeeting(t, fakeLlm(async () => ({ text: "no idea" })).llm)).toEqual({ type: "meeting", source: "fallback" });
    const bad = fakeLlm(async () => {
      throw new LlmError("HTTP 400", false);
    });
    expect(await classifyMeeting(t, bad.llm)).toEqual({ type: "meeting", source: "fallback" });
  });

  it("outage propagates (job waits) instead of guessing", async () => {
    const down = fakeLlm(async () => {
      throw new LlmError("ECONNREFUSED", true);
    });
    await expect(classifyMeeting(withMeeting("Q4 planning", 5), down.llm)).rejects.toMatchObject({ retryable: true });
  });
});

describe("formatTranscriptLines", () => {
  it("timestamps, merges same-speaker runs, labels unknown speakers, skips blanks", () => {
    const t = fixture({
      segments: [
        { start: 0, end: 1, speaker: "A", text: "Hi." },
        { start: 1, end: 2, speaker: "A", text: " there " },
        { start: 2, end: 3, speaker: "B", text: "  " },
        { start: 65, end: 70, speaker: null, text: "Next topic." },
        { start: 3725, end: 3730, speaker: "A", text: "Bye." },
      ],
    });
    expect(formatTranscriptLines(t)).toBe("[0:00] A: Hi. there\n[1:05] Unknown speaker: Next topic.\n[1:02:05] A: Bye.");
  });
});

describe("buildSummaryPrompt", () => {
  it("system = common rules + instructions; user = metadata + transcript", () => {
    const t = fixture();
    const [sys, user] = buildSummaryPrompt(t, builtin("1on1"));
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("language of the transcript");
    expect(sys.content).toContain("## Feedback");
    expect(user.content).toContain("Title: Alice / Bob 1:1");
    expect(user.content).toContain("Attendees: Alice Example <alice@example.com>, Bob Builder <bob@example.com>");
    expect(user.content).toContain("Organizer: Alice Example <alice@example.com>");
    expect(user.content).toContain("(32m)");
    expect(user.content).toContain("[0:04] Speaker 2: Good, we mostly talked about the Q4 roadmap.");
  });

  it("ad-hoc: no attendee/organizer lines; empty transcript marked", () => {
    const [, user] = buildSummaryPrompt(fixture({ meeting: null, segments: [] }), builtin("adhoc"));
    expect(user.content).toContain("Title: (none: unscheduled call)");
    expect(user.content).not.toMatch(/Attendees|Organizer/);
    expect(user.content).toContain("Transcript:\n(empty)");
  });
});

describe("parseSummaryReply", () => {
  it("trims and unwraps a whole-reply markdown fence", () => {
    expect(parseSummaryReply(reply("  ## Summary\n- x  "))).toBe("## Summary\n- x");
    expect(parseSummaryReply(reply("```markdown\n## Summary\n- x\n```"))).toBe("## Summary\n- x");
    expect(parseSummaryReply(reply("Intro\n```\ncode\n```"))).toBe("Intro\n```\ncode\n```");
  });

  it("truncated or empty = non-retryable error", () => {
    for (const r of [reply("## Summ", { finishReason: "length" }), reply("   ")]) {
      let err: unknown;
      try {
        parseSummaryReply(r);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as { retryable?: boolean }).retryable).toBeUndefined();
    }
  });
});

describe("summary storage", () => {
  it("save/get round-trip; stale once the transcript content changes", () => {
    const db = new Database(":memory:");
    migrate(db, USER_MIGRATIONS);
    const t = fixture();
    upsertTranscript(db, "dev", t, RAW, 1000);
    expect(getSummary(db, t.id)).toBeNull();
    saveSummary(db, { transcriptId: t.id, text: "S", meetingType: "1on1", meetingTypeSource: "rule", instructions: builtin("1on1"), provider: "local", model: "m1", usage: { promptTokens: null, completionTokens: null }, parts: 3, transcriptUpdatedAt: 1000 }, 5000);
    expect(getSummary(db, t.id.toUpperCase())).toEqual({
      text: "S",
      meetingType: "1on1",
      meetingTypeSource: "rule",
      instructionsSource: "builtin:1on1",
      provider: "local",
      model: "m1",
      createdAt: new Date(5000).toISOString(),
      stale: false,
      parts: 3,
    });
    upsertTranscript(db, "dev", t, RAW, 2000); // identical: still fresh
    expect(getSummary(db, t.id)?.stale).toBe(false);
    upsertTranscript(db, "dev", { ...t, segments: t.segments.slice(1) }, RAW, 3000);
    expect(getSummary(db, t.id)?.stale).toBe(true);
    expect(db.prepare("SELECT instructions, prompt_tokens FROM summaries").get()).toEqual({ instructions: builtin("1on1").text, prompt_tokens: null });
  });
});

describe("summarizeHandler", () => {
  const job = (key: string, payload: unknown = null): Job => ({ id: 1, userId: 1, type: "summarize", key, payload, status: "running", generation: 1, attempts: 1, failures: 0, runAt: 0, lastError: null, createdAt: 0, updatedAt: 0 });

  function setup(chat: (messages: ChatMessage[]) => Promise<ChatResult>, contextTokens: number | null = null) {
    const dir = mkdtempSync(join(tmpdir(), "pa-sum-"));
    const store = new Store(dir);
    const calls: ChatMessage[][] = [];
    const opts: ChatOptions[] = [];
    const llm = {
      chat: async (task: string, messages: ChatMessage[], o: ChatOptions) => {
        expect(task).toBe("summary");
        calls.push(messages);
        opts.push(o);
        return chat(messages);
      },
      contextTokens: () => contextTokens,
    } as unknown as Llm;
    const handler = summarizeHandler({ store, llm, now: () => 9000 });
    const cleanup = () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { store, handler, calls, opts, cleanup };
  }

  it("summarizes the stored transcript and saves model + instructions", async () => {
    const { store, handler, calls, cleanup } = setup(async () => reply("## Summary\n- hiring plan"));
    try {
      const t = fixture();
      upsertTranscript(store.user(1), "dev", t, RAW, 1000);
      await handler(job(t.id), new AbortController().signal);
      expect(calls).toHaveLength(1);
      expect(calls[0][1].content).toContain("hiring plan");
      expect(getSummary(store.user(1), t.id)).toMatchObject({ text: "## Summary\n- hiring plan", meetingType: "1on1", model: "m1", stale: false, parts: 1 });
    } finally {
      cleanup();
    }
  });

  it("ambiguous meeting: classify call first, then summary with that type's instructions", async () => {
    const { store, handler, calls, cleanup } = setup(async (m) => reply(m[0].content.startsWith("You classify") ? "external" : "## S"));
    try {
      const t = withMeeting("Q4 planning", 5);
      upsertTranscript(store.user(1), "dev", t, RAW, 1000);
      await handler(job(t.id), new AbortController().signal);
      expect(calls).toHaveLength(2);
      expect(calls[1][0].content).toContain("## Their needs and concerns");
      expect(getSummary(store.user(1), t.id)).toMatchObject({ meetingType: "external", meetingTypeSource: "llm", instructionsSource: "builtin:external" });
    } finally {
      cleanup();
    }
  });

  it("custom instructions: series > type > default", async () => {
    const { store, handler, calls, cleanup } = setup(async () => reply("## S"));
    try {
      const db = store.user(1);
      const t = fixture(); // 1on1, series AAMkAGI2TG93SERIES=
      upsertTranscript(db, "dev", t, RAW, 1000);
      const run = async () => {
        await handler(job(t.id), new AbortController().signal);
        return { system: calls.at(-1)![0].content, source: getSummary(db, t.id)?.instructionsSource };
      };
      putInstruction(db, "default", "", "DEFAULT-TEXT", 1);
      expect(await run()).toMatchObject({ source: "default", system: expect.stringContaining("DEFAULT-TEXT") });
      putInstruction(db, "type", "meeting", "OTHER-TYPE", 1);
      putInstruction(db, "type", "1on1", "TYPE-TEXT", 1);
      expect(await run()).toMatchObject({ source: "type:1on1", system: expect.stringContaining("TYPE-TEXT") });
      putInstruction(db, "series", "AAMkAGI2TG93SERIES=", "SERIES-TEXT", 1);
      const r = await run();
      expect(r).toMatchObject({ source: "series:AAMkAGI2TG93SERIES=", system: expect.stringContaining("SERIES-TEXT") });
      expect(r.system).not.toContain("TYPE-TEXT");
    } finally {
      cleanup();
    }
  });

  it("model: job payload pick > user setting > default (null)", async () => {
    const { store, handler, opts, cleanup } = setup(async () => reply("## S"));
    try {
      const t = fixture();
      upsertTranscript(store.user(1), "dev", t, RAW, 1000);
      await handler(job(t.id), new AbortController().signal);
      expect(opts.at(-1)?.route).toBeNull();
      setSummaryLlm(store.user(1), { provider: "paid", model: "big" });
      await handler(job(t.id), new AbortController().signal);
      expect(opts.at(-1)?.route).toEqual({ provider: "paid", model: "big" });
      await handler(job(t.id, { llm: { provider: "local", model: "m" } }), new AbortController().signal);
      expect(opts.at(-1)?.route).toEqual({ provider: "local", model: "m" });
      await handler(job(t.id, { llm: "garbage" }), new AbortController().signal);
      expect(opts.at(-1)?.route).toEqual({ provider: "paid", model: "big" });
    } finally {
      cleanup();
    }
  });

  it("long transcript with a configured window → summarized in parts, parts saved", async () => {
    const { store, handler, calls, cleanup } = setup(async (m) => reply(m[0].content.startsWith("You take notes") ? "- notes" : "## Whole meeting"), 8192);
    try {
      const t = longTranscript(600);
      upsertTranscript(store.user(1), "dev", t, RAW, 1000);
      await handler(job(t.id), new AbortController().signal);
      const s = getSummary(store.user(1), t.id);
      expect(s).toMatchObject({ text: "## Whole meeting", meetingType: "1on1" });
      expect(s!.parts).toBeGreaterThan(3);
      expect(calls).toHaveLength(s!.parts! + 1);
    } finally {
      cleanup();
    }
  });

  it("missing transcript = no-op, no LLM call", async () => {
    const { handler, calls, cleanup } = setup(async () => reply("x"));
    try {
      await handler(job("00000000-0000-4000-8000-000000000000"), new AbortController().signal);
      expect(calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("LLM outage propagates as retryable and saves nothing", async () => {
    const { store, handler, cleanup } = setup(async () => {
      throw new LlmError("ECONNREFUSED", true);
    });
    try {
      const t = fixture();
      upsertTranscript(store.user(1), "dev", t, RAW, 1000);
      await expect(handler(job(t.id), new AbortController().signal)).rejects.toMatchObject({ retryable: true });
      expect(getSummary(store.user(1), t.id)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

// ---- long transcripts ----

/** n segments of ~`words` words, alternating speakers, 10s each. */
function longTranscript(n: number, words = 30): TranscriptUpload {
  const t = fixture();
  const segments = Array.from({ length: n }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 9,
    speaker: i % 3 ? "Speaker 1" : "Alice Example",
    text: `s${i} ${"lorem ipsum dolor ".repeat(Math.ceil(words / 3)).trim()}`,
  }));
  return { ...t, segments };
}

const notes = (from: number, to: number, text: string, total = 9): PartNotes => ({ from, to, total, start: from * 100, end: to * 100 + 99, text });

describe("long-transcript sizing (pure)", () => {
  it("reply reserve, one-call fit, input budget", () => {
    expect(replyReserve(90000)).toBe(8192);
    expect(replyReserve(8192)).toBe(2048);
    const m = [{ role: "user" as const, content: "x".repeat(3000) }]; // 1000 tokens
    expect(fitsInOneCall(m, 4096)).toBe(true); // 1000 + 1024 ≤ 4096
    expect(fitsInOneCall(m, 1200)).toBe(false);
    expect(inputBudgetChars(16384, m)).toBe((16384 - 4096 - 1000) * 3);
    expect(inputBudgetChars(4096, [{ role: "system", content: "x".repeat(60000) }])).toBe(1000); // floor
  });

  it("chunkSegments: order and words kept, each chunk within budget, oversize segment split, blanks dropped", () => {
    const t = longTranscript(200);
    t.segments[50] = { ...t.segments[50], text: "word ".repeat(3000).trim() }; // 15k chars, one segment
    t.segments[60] = { ...t.segments[60], text: "   " };
    const chunks = chunkSegments(t.segments, 5000);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(formatSegments(c).length).toBeLessThanOrEqual(5000);
    const words = (segs: { text: string }[]) => segs.flatMap((s) => s.text.split(/\s+/).filter(Boolean));
    expect(words(chunks.flat())).toEqual(words(t.segments));
    expect(chunks.flat().filter((s) => s.start === 500).length).toBeGreaterThan(2);
    expect(chunks.flat().map((s) => s.start)).toEqual([...chunks.flat().map((s) => s.start)].sort((a, b) => a - b));
    expect(chunkSegments([], 5000)).toEqual([]);
  });

  it("groupNotes: greedy consecutive groups; pairs up when nothing fits together; always shrinks", () => {
    const small = [0, 1, 2, 3, 4].map((i) => notes(i, i, "x".repeat(100)));
    expect(groupNotes(small, 300).map((g) => g.map((n) => n.from))).toEqual([[0, 1], [2, 3], [4]]);
    const big = [0, 1, 2].map((i) => notes(i, i, "x".repeat(1000)));
    expect(groupNotes(big, 500).map((g) => g.map((n) => n.from))).toEqual([[0, 1], [2]]);
    expect(groupNotes([notes(0, 0, "x")], 10)).toHaveLength(1);
  });

  it("labels, usage totals (unknown stays unknown)", () => {
    expect(partLabel(notes(1, 1, ""))).toBe("Part 2 of 9 (1:40–3:19)");
    expect(partLabel(notes(0, 3, ""))).toBe("Parts 1–4 of 9 (0:00–6:39)");
    expect(addUsage({ promptTokens: 1, completionTokens: 2 }, { promptTokens: 3, completionTokens: 4 })).toEqual({ promptTokens: 4, completionTokens: 6 });
    expect(addUsage({ promptTokens: 1, completionTokens: 2 }, { promptTokens: null, completionTokens: 4 })).toEqual({ promptTokens: null, completionTokens: 6 });
  });

  it("prompts: part = notes task + range + that part only; combine = summary rules + notes, no transcript", () => {
    const t = longTranscript(20);
    const [sys, user] = buildPartPrompt(t, builtin("1on1"), t.segments.slice(5, 8), 1, 4);
    expect(sys.content).toMatch(/^You take notes on one part/);
    expect(sys.content).toContain("## Feedback"); // final instructions passed through
    expect(user.content).toContain("Transcript part 2 of 4 (0:50–1:19):");
    expect(user.content).toContain("s5 ");
    expect(user.content).not.toContain("s4 ");
    const [csys, cuser] = buildCombinePrompt(t, builtin("1on1"), [notes(0, 0, "- a"), notes(1, 2, "- b")]);
    expect(csys.content).toMatch(/^You write meeting summaries/);
    expect(csys.content).toContain("notes taken on its consecutive parts");
    expect(cuser.content).toContain("### Part 1 of 9 (0:00–1:39)\n- a\n\n### Parts 2–3 of 9 (1:40–4:59)\n- b");
    expect(cuser.content).not.toContain("lorem");
  });
});

describe("summarizeTranscript", () => {
  /** Fake model with a real context window: overflow = vLLM-style LlmError. Replies by prompt kind. */
  function modelWithWindow(windowTokens: number, opts: { notesChars?: number; usage?: ChatResult["usage"]; failOnCall?: number } = {}) {
    const calls: { kind: string; tokens: number }[] = [];
    const llm = {
      chat: async (_task: string, m: ChatMessage[]) => {
        const kind = m[0].content.startsWith("You take notes") ? "part" : m[0].content.startsWith("You merge") ? "merge" : m[1].content.includes("Notes per part") ? "combine" : "single";
        const tokens = estimateTokens(m.map((x) => x.content).join("\n"));
        calls.push({ kind, tokens });
        if (opts.failOnCall === calls.length) throw new LlmError("ECONNREFUSED", true);
        if (tokens > windowTokens) throw new LlmError(`HTTP 400: This model's maximum context length is ${windowTokens} tokens.`, false, 400, true);
        const text = kind === "part" || kind === "merge" ? `- ${kind} ${"n".repeat(opts.notesChars ?? 50)}` : `## ${kind}`;
        return reply(text, { usage: opts.usage ?? { promptTokens: tokens, completionTokens: 10 } });
      },
      contextTokens: () => null,
    } as unknown as Llm;
    return { llm, calls };
  }
  const run = (t: TranscriptUpload, llm: Llm, contextTokens: number | null) => summarizeTranscript(t, builtin("meeting"), llm, { contextTokens });

  it("fits → one call, parts 1", async () => {
    const { llm, calls } = modelWithWindow(90000);
    expect(await run(fixture(), llm, 90000)).toMatchObject({ text: "## single", parts: 1, provider: "local", model: "m1" });
    expect(calls.map((c) => c.kind)).toEqual(["single"]);
  });

  it("known window too small → no doomed single call; parts → combine, every call within the window", async () => {
    const t = longTranscript(600); // ~60k chars ≈ 20k tokens
    const { llm, calls } = modelWithWindow(8192);
    const r = await run(t, llm, 8192);
    const kinds = calls.map((c) => c.kind);
    expect(kinds[0]).toBe("part");
    expect(kinds.at(-1)).toBe("combine");
    expect(kinds).not.toContain("single");
    expect(r).toMatchObject({ text: "## combine", parts: kinds.filter((k) => k === "part").length });
    expect(r.parts).toBeGreaterThan(3);
    for (const c of calls) expect(c.tokens + replyReserve(8192)).toBeLessThanOrEqual(8192);
    expect(r.usage.promptTokens).toBe(calls.reduce((a, c) => a + c.tokens, 0));
  });

  it("unknown window → single attempt; overflow → parts sized for the fallback window", async () => {
    const t = longTranscript(3000); // ~100k tokens
    const { llm, calls } = modelWithWindow(FALLBACK_CONTEXT_TOKENS + 4000);
    const r = await run(t, llm, null);
    expect(calls[0].kind).toBe("single");
    expect(calls.slice(1).every((c) => c.tokens <= FALLBACK_CONTEXT_TOKENS)).toBe(true);
    expect(r.parts).toBeGreaterThan(5);
    expect(r.text).toBe("## combine");
  });

  it("configured window too high → single overflows → parts at half the window (and less if needed)", async () => {
    const t = longTranscript(150); // ~11k tokens: fits 32k by estimate; real window 9k
    const { llm, calls } = modelWithWindow(9000);
    const r = await run(t, llm, 32768);
    // One doomed call per halving: single @32k, first part @16k; then 8k-sized parts fit.
    expect(calls.filter((c) => c.tokens > 9000).map((c) => c.kind)).toEqual(["single", "part"]);
    expect(calls.at(-1)!.kind).toBe("combine");
    expect(r).toMatchObject({ text: "## combine", parts: 2 });
  });

  it("parts overflow too → halve again and redo the parts", async () => {
    const t = longTranscript(600);
    const { llm, calls } = modelWithWindow(7000);
    const r = await run(t, llm, 24000); // estimate says don't even try single; 24k-sized parts overflow → 12k → 6k fits
    // First part fails @24k and @12k (one call each), 6k-sized parts fit.
    expect(calls.filter((c) => c.tokens > 7000).map((c) => c.kind)).toEqual(["part", "part"]);
    expect(r.text).toBe("## combine");
    expect(r.parts).toBe(calls.filter((c) => c.kind === "part").length - 2);
  });

  it("notes too long for one combine call → merge rounds first, then one combine", async () => {
    const t = longTranscript(2000);
    const { llm, calls } = modelWithWindow(6000, { notesChars: 3000 });
    const r = await run(t, llm, 6000);
    const kinds = calls.map((c) => c.kind);
    expect(kinds).toContain("merge");
    expect(kinds.filter((k) => k === "combine")).toHaveLength(1);
    expect(kinds.at(-1)).toBe("combine");
    expect(kinds.indexOf("merge")).toBeGreaterThan(kinds.lastIndexOf("part"));
    expect(r.text).toBe("## combine");
    for (const c of calls) expect(c.tokens).toBeLessThanOrEqual(6000);
  });

  it("still overflowing at the minimum window → non-retryable error pointing at contextTokens", async () => {
    const { llm } = modelWithWindow(2000);
    const err = await run(longTranscript(3000), llm, null).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/contextTokens/);
    expect((err as { retryable?: boolean }).retryable).toBeUndefined();
  });

  it("outage mid-way propagates as retryable; unknown usage stays unknown", async () => {
    const { llm } = modelWithWindow(8192, { failOnCall: 3 });
    await expect(run(longTranscript(600), llm, 8192)).rejects.toMatchObject({ retryable: true });
    const unknown = modelWithWindow(8192, { usage: { promptTokens: null, completionTokens: 5 } });
    expect((await run(longTranscript(600), unknown.llm, 8192)).usage.promptTokens).toBeNull();
  });
});
