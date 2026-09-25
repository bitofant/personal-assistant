import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { migrate, USER_MIGRATIONS } from "./db.js";
import { getTranscript, listTranscripts, parseTranscriptUpload, upsertTranscript } from "./transcripts.js";

const FIXTURE_RAW = readFileSync("shared/fixtures/transcript-upload.json", "utf8");
const fixture = () => JSON.parse(FIXTURE_RAW) as Record<string, any>;

describe("parseTranscriptUpload", () => {
  it("normalizes the shared fixture: uuid, UTC timestamps, emails", () => {
    const t = parseTranscriptUpload(fixture());
    expect(t.id).toBe("6f1c2b7e-3d4a-4e5f-9a8b-1c2d3e4f5a6b");
    expect(t.startedAt).toBe("2026-09-24T07:00:03.000Z");
    expect(t.meeting?.start).toBe("2026-09-24T07:00:00.000Z");
    expect(t.meeting?.organizer).toEqual({ name: "Alice Example", email: "alice@example.com" });
    expect(t.meeting?.attendees.map((a) => a.email)).toEqual(["alice@example.com", "bob@example.com"]);
    expect(t.segments).toHaveLength(3);
    expect(t.segments[2].speaker).toBeNull();
  });

  it("accepts ad-hoc (meeting null) and blank strings become null", () => {
    const t = parseTranscriptUpload({ ...fixture(), meeting: null, diarizationModel: "  " });
    expect(t.meeting).toBeNull();
    expect(t.diarizationModel).toBeNull();
  });

  it("drops all-null people", () => {
    const f = fixture();
    f.meeting.attendees.push({ name: " ", email: null }, {});
    expect(parseTranscriptUpload(f).meeting?.attendees).toHaveLength(2);
  });

  it("rejects bad ids, zoneless/invalid times, inverted ranges, bad segments", () => {
    const f = fixture();
    f.id = "not-a-uuid";
    f.startedAt = "2026-09-24T09:00:03"; // no zone
    f.meeting.end = "yesterday";
    f.segments[0].end = -1;
    f.segments[1].text = 42;
    delete f.asrModel;
    const run = () => parseTranscriptUpload(f);
    expect(run).toThrow(/id must be a UUID/);
    expect(run).toThrow(/startedAt must be/);
    expect(run).toThrow(/meeting.end must be/);
    expect(run).toThrow(/segments\[0\]/);
    expect(run).toThrow(/segments\[1\].text/);
    expect(run).toThrow(/asrModel required/);
    expect(() => parseTranscriptUpload({ ...fixture(), endedAt: "2026-09-24T06:00:00Z" })).toThrow(/endedAt before/);
  });
});

describe("transcript storage", () => {
  const db = () => {
    const d = new Database(":memory:");
    migrate(d, USER_MIGRATIONS);
    return d;
  };

  it("upsert is idempotent on id; keeps raw verbatim and received_at", () => {
    const d = db();
    const t = parseTranscriptUpload(fixture());
    expect(upsertTranscript(d, "dev1", t, FIXTURE_RAW, 1000)).toEqual({ id: t.id, created: true });
    const edited = { ...t, segments: t.segments.slice(0, 1) };
    expect(upsertTranscript(d, "dev1", edited, "{}", 2000)).toEqual({ id: t.id, created: false });

    const names = new Map([["dev1", "MacBook"]]);
    const got = getTranscript(d, t.id.toUpperCase(), names)!;
    expect(got.segments).toHaveLength(1);
    expect(got.receivedAt).toBe(new Date(1000).toISOString());
    expect(got.updatedAt).toBe(new Date(2000).toISOString());
    expect(got.deviceName).toBe("MacBook");
    expect((d.prepare("SELECT raw FROM transcripts").get() as { raw: string }).raw).toBe("{}");
  });

  it("list: newest first, ad-hoc attendee count unknown (null, not 0), revoked device name null", () => {
    const d = db();
    const a = parseTranscriptUpload(fixture());
    const b = parseTranscriptUpload({
      ...fixture(),
      id: "00000000-0000-4000-8000-000000000000",
      startedAt: "2026-09-25T10:00:00Z",
      endedAt: "2026-09-25T10:05:00Z",
      meeting: null,
    });
    upsertTranscript(d, "dev1", a, "", 1);
    upsertTranscript(d, "gone", b, "", 2);
    const list = listTranscripts(d, new Map([["dev1", "Mac"]]));
    expect(list.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(list[0]).toMatchObject({ attendeeCount: null, title: null, deviceName: null, segmentCount: 3 });
    expect(list[1]).toMatchObject({ attendeeCount: 2, title: "Alice / Bob 1:1", deviceName: "Mac" });
  });
});
