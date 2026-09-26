import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate, USER_MIGRATIONS } from "./db.js";
import { HttpError } from "./http.js";
import {
  deleteInstruction,
  listInstructions,
  listSeries,
  MAX_INSTRUCTIONS_CHARS,
  parseInstructionTarget,
  parseInstructionText,
  putInstruction,
} from "./instructions.js";
import { parseTranscriptUpload, upsertTranscript } from "./transcripts.js";

const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as HttpError).status;
  }
  return 0;
};

describe("parseInstructionTarget", () => {
  it("default has no key; type must be known; series id trimmed, case kept", () => {
    expect(parseInstructionTarget("default", undefined)).toEqual({ scope: "default", key: "" });
    expect(parseInstructionTarget("type", "1on1")).toEqual({ scope: "type", key: "1on1" });
    expect(parseInstructionTarget("series", " AbC/= ")).toEqual({ scope: "series", key: "AbC/=" });
    expect(status(() => parseInstructionTarget("type", "party"))).toBe(400);
    expect(status(() => parseInstructionTarget("series", " "))).toBe(400);
    expect(status(() => parseInstructionTarget("nope", "x"))).toBe(404);
  });
});

describe("parseInstructionText", () => {
  it("trimmed non-empty string within limit", () => {
    expect(parseInstructionText({ text: "  Be brief.  " })).toBe("Be brief.");
    for (const body of [{}, { text: "   " }, { text: 5 }, null, { text: "x".repeat(MAX_INSTRUCTIONS_CHARS + 1) }])
      expect(status(() => parseInstructionText(body))).toBe(400);
  });
});

describe("instructions storage", () => {
  it("put upserts, delete is idempotent; series list = latest title + count", () => {
    const db = new Database(":memory:");
    migrate(db, USER_MIGRATIONS);
    expect(putInstruction(db, "type", "1on1", "A", 1000)).toEqual({ scope: "type", key: "1on1", text: "A", updatedAt: new Date(1000).toISOString() });
    putInstruction(db, "type", "1on1", "B", 2000);
    putInstruction(db, "default", "", "D", 3000);
    expect(listInstructions(db).map((i) => [i.scope, i.key, i.text])).toEqual([["default", "", "D"], ["type", "1on1", "B"]]);
    deleteInstruction(db, "type", "1on1");
    deleteInstruction(db, "type", "1on1");
    expect(listInstructions(db)).toHaveLength(1);

    const base = {
      startedAt: "2026-09-01T09:00:00Z",
      endedAt: "2026-09-01T09:30:00Z",
      segments: [],
      asrModel: "x",
      meeting: { seriesId: "s1", title: "Old title", start: "2026-09-01T09:00:00Z", end: "2026-09-01T09:30:00Z", attendees: [] },
    };
    const up = (id: string, over: Record<string, unknown>) => upsertTranscript(db, "d", parseTranscriptUpload({ ...base, id, ...over }), "{}", 1);
    up("00000000-0000-4000-8000-000000000001", {});
    up("00000000-0000-4000-8000-000000000002", { startedAt: "2026-09-08T09:00:00Z", endedAt: "2026-09-08T09:30:00Z", meeting: { ...base.meeting, title: "New title" } });
    up("00000000-0000-4000-8000-000000000003", { meeting: null });
    expect(listSeries(db)).toEqual([{ seriesId: "s1", title: "New title", count: 2, lastStartedAt: "2026-09-08T09:00:00.000Z" }]);
  });
});
