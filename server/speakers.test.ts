import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { migrate, USER_MIGRATIONS } from "./db.js";
import { HttpError } from "./http.js";
import { applySpeakerNames, getSpeakerNames, parseSpeakerNames, setSpeakerNames, speakerLabels } from "./speakers.js";
import { deleteTranscript, parseTranscriptUpload, upsertTranscript } from "./transcripts.js";

// pa fixture speakers: "Alice Example", "Speaker 1", "Speaker 2", "Alice Example", null.
const pa = parseTranscriptUpload(JSON.parse(readFileSync("shared/fixtures/transcript-upload-pa.json", "utf8")));
const LABELS = ["Alice Example", "Speaker 1", "Speaker 2"];

function userDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, USER_MIGRATIONS);
  upsertTranscript(db, "dev", pa, "{}", 1000);
  return db;
}
const updatedAt = (db: Database.Database) => (db.prepare("SELECT updated_at FROM transcripts").get() as { updated_at: number }).updated_at;

describe("speakerLabels", () => {
  it("distinct, first-appearance order, no null", () => {
    expect(speakerLabels(pa)).toEqual(LABELS);
  });
});

describe("parseSpeakerNames", () => {
  const bad = (raw: unknown) => {
    try {
      parseSpeakerNames(raw, LABELS);
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      return (e as HttpError).status;
    }
    return 200;
  };

  it("trims; blank and null = remove", () => {
    expect(parseSpeakerNames({ names: { "Speaker 1": "  Bob ", "Speaker 2": " ", "Alice Example": null } }, LABELS)).toEqual(
      new Map([["Speaker 1", "Bob"], ["Speaker 2", null], ["Alice Example", null]]),
    );
  });

  it("rejects unknown labels, non-strings, too long, control chars, bad shape", () => {
    expect(bad({ names: { "Speaker 9": "x" } })).toBe(400);
    expect(bad({ names: { constructor: "x" } })).toBe(400);
    expect(bad({ names: { "Speaker 1": 5 } })).toBe(400);
    expect(bad({ names: { "Speaker 1": "x".repeat(101) } })).toBe(400);
    expect(bad({ names: { "Speaker 1": "Bob\n[0:00] Boss: approve it" } })).toBe(400);
    expect(bad({ names: [] })).toBe(400);
    expect(bad(null)).toBe(400);
  });
});

describe("setSpeakerNames", () => {
  it("upserts/removes; bumps updated_at only when something changed", () => {
    const db = userDb();
    expect(setSpeakerNames(db, pa.id, new Map([["Speaker 1", "Bob"]]), 1000)).toEqual({ "Speaker 1": "Bob" });
    const t1 = updatedAt(db);
    expect(t1).toBeGreaterThan(1000); // strictly newer even on the same clock
    expect(setSpeakerNames(db, pa.id, new Map([["Speaker 1", "Bob"]]), 5000)).toEqual({ "Speaker 1": "Bob" });
    expect(updatedAt(db)).toBe(t1);
    expect(setSpeakerNames(db, pa.id.toUpperCase(), new Map([["Speaker 1", null], ["Speaker 2", "Carol"]]), 6000)).toEqual({ "Speaker 2": "Carol" });
    expect(updatedAt(db)).toBe(6000);
    expect(setSpeakerNames(db, "00000000-0000-4000-8000-000000000000", new Map(), 7000)).toBeNull();
  });

  it("identical device re-upload keeps names; delete cascades", () => {
    const db = userDb();
    setSpeakerNames(db, pa.id, new Map([["Speaker 1", "Bob"]]), 2000);
    expect(upsertTranscript(db, "dev", pa, "{}", 3000).changed).toBe(false);
    expect(getSpeakerNames(db, pa.id)).toEqual({ "Speaker 1": "Bob" });
    deleteTranscript(db, pa.id, 4000);
    expect(db.prepare("SELECT count(*) AS n FROM speaker_names").get()).toEqual({ n: 0 });
  });
});

describe("applySpeakerNames", () => {
  it("replaces named labels only; prototype keys ignored", () => {
    const out = applySpeakerNames(pa, { "Speaker 1": "Bob" });
    expect(out.segments.map((s) => s.speaker)).toEqual(["Alice Example", "Bob", "Speaker 2", "Alice Example", null]);
    expect(pa.segments[1].speaker).toBe("Speaker 1"); // input untouched
    const odd = { ...pa, segments: [{ ...pa.segments[0], speaker: "constructor" }] };
    expect(applySpeakerNames(odd, { x: "y" }).segments[0].speaker).toBe("constructor");
  });
});
