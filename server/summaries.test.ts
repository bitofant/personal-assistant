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
  buildClassifyPrompt,
  buildSummaryPrompt,
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
    saveSummary(db, { transcriptId: t.id, text: "S", meetingType: "1on1", meetingTypeSource: "rule", instructions: builtin("1on1"), provider: "local", model: "m1", usage: { promptTokens: null, completionTokens: null }, transcriptUpdatedAt: 1000 }, 5000);
    expect(getSummary(db, t.id.toUpperCase())).toEqual({
      text: "S",
      meetingType: "1on1",
      meetingTypeSource: "rule",
      instructionsSource: "builtin:1on1",
      provider: "local",
      model: "m1",
      createdAt: new Date(5000).toISOString(),
      stale: false,
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

  function setup(chat: (messages: ChatMessage[]) => Promise<ChatResult>) {
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
      expect(getSummary(store.user(1), t.id)).toMatchObject({ text: "## Summary\n- hiring plan", meetingType: "1on1", model: "m1", stale: false });
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
