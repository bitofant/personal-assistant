import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { TranscriptUpload } from "../shared/api.js";
import { migrate, Store, USER_MIGRATIONS } from "./db.js";
import type { Job } from "./jobs.js";
import { LlmError, type ChatMessage, type ChatResult, type Llm } from "./llm.js";
import {
  buildSummaryPrompt,
  classifyMeeting,
  formatTranscriptLines,
  getSummary,
  parseSummaryReply,
  resolveInstructions,
  saveSummary,
  summarizeHandler,
} from "./summaries.js";
import { parseTranscriptUpload, upsertTranscript } from "./transcripts.js";

const RAW = readFileSync("shared/fixtures/transcript-upload.json", "utf8");
const fixture = (over: Partial<TranscriptUpload> = {}) => parseTranscriptUpload({ ...JSON.parse(RAW), ...over });

const reply = (text: string, extra: Partial<ChatResult> = {}): ChatResult => ({
  text,
  model: "m1",
  provider: "local",
  finishReason: "stop",
  usage: { promptTokens: 100, completionTokens: 20 },
  ...extra,
});

describe("classifyMeeting", () => {
  it("2 attendees = 1on1, event = meeting, no event = adhoc", () => {
    const t = fixture();
    expect(classifyMeeting(t)).toBe("1on1");
    expect(classifyMeeting({ ...t, meeting: { ...t.meeting!, attendees: [...t.meeting!.attendees, { name: "C", email: null }] } })).toBe("meeting");
    expect(classifyMeeting({ ...t, meeting: { ...t.meeting!, attendees: [] } })).toBe("meeting");
    expect(classifyMeeting(fixture({ meeting: null }))).toBe("adhoc");
  });
});

describe("resolveInstructions", () => {
  it("picks the built-in for the type and records the source", () => {
    expect(resolveInstructions("1on1")).toMatchObject({ source: "builtin:1on1", text: expect.stringMatching(/1:1/) });
    expect(resolveInstructions("adhoc").source).toBe("builtin:adhoc");
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
    const [sys, user] = buildSummaryPrompt(t, resolveInstructions("1on1"));
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
    const [, user] = buildSummaryPrompt(fixture({ meeting: null, segments: [] }), resolveInstructions("adhoc"));
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
    saveSummary(db, { transcriptId: t.id, text: "S", meetingType: "1on1", instructions: resolveInstructions("1on1"), provider: "local", model: "m1", usage: { promptTokens: null, completionTokens: null }, transcriptUpdatedAt: 1000 }, 5000);
    expect(getSummary(db, t.id.toUpperCase())).toEqual({
      text: "S",
      meetingType: "1on1",
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
    expect(db.prepare("SELECT instructions, prompt_tokens FROM summaries").get()).toEqual({ instructions: resolveInstructions("1on1").text, prompt_tokens: null });
  });
});

describe("summarizeHandler", () => {
  const job = (key: string): Job => ({ id: 1, userId: 1, type: "summarize", key, payload: null, status: "running", generation: 1, attempts: 1, failures: 0, runAt: 0, lastError: null, createdAt: 0, updatedAt: 0 });

  function setup(chat: (messages: ChatMessage[]) => Promise<ChatResult>) {
    const dir = mkdtempSync(join(tmpdir(), "pa-sum-"));
    const store = new Store(dir);
    const calls: ChatMessage[][] = [];
    const llm = {
      chat: async (task: string, messages: ChatMessage[]) => {
        expect(task).toBe("summary");
        calls.push(messages);
        return chat(messages);
      },
    } as unknown as Llm;
    const handler = summarizeHandler({ store, llm, now: () => 9000 });
    const cleanup = () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { store, handler, calls, cleanup };
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
