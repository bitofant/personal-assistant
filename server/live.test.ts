import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { migrate, USER_MIGRATIONS } from "./db.js";
import { discardLive, getLive, ingestLiveChunk, LIVE_MAX_IDLE_MS, listLive, parseCursor, parseLiveChunk, purgeStaleLive } from "./live.js";
import { deleteTranscript, listTranscripts, parseTranscriptId, parseTranscriptUpload, upsertTranscript } from "./transcripts.js";

const chunkFixture = () => JSON.parse(readFileSync("shared/fixtures/live-chunk.json", "utf8")) as Record<string, any>;
const ID = "6f1c2b7e-3d4a-4e5f-9a8b-1c2d3e4f5a6b";
const db = () => {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON"); // as openDb: cleanup relies on cascades
  migrate(d, USER_MIGRATIONS);
  return d;
};
const seg = (start: number, text: string, speaker: string | null = "Others") => ({ start, end: start + 1, speaker, text });
const chunk = (stream: "mic" | "system", seq: number, segments: ReturnType<typeof seg>[], extra: Record<string, unknown> = {}) =>
  parseLiveChunk({ ...chunkFixture(), stream, seq, segments, ...extra });
const count = (d: Database.Database, sql: string) => (d.prepare(sql).get() as { n: number }).n;

describe("parseLiveChunk", () => {
  it("normalizes the shared fixture", () => {
    const c = parseLiveChunk(chunkFixture());
    expect(c).toMatchObject({ stream: "system", seq: 0, startedAt: "2026-09-24T07:00:03.000Z" });
    expect(c.meeting?.title).toBe("Alice / Bob 1:1");
    expect(c.segments).toEqual([{ start: 1.2, end: 4.8, speaker: "Others", text: "Morning, shall we start with the release?" }]);
    expect("ended" in c).toBe(false);
    expect(parseLiveChunk({ ...chunkFixture(), meeting: undefined, ended: true })).toMatchObject({ meeting: null, ended: true });
  });

  it("rejects bad stream / seq / segments / ended", () => {
    for (const bad of [{ stream: "both" }, { seq: -1 }, { seq: 1.5 }, { seq: "0" }, { segments: null }, { segments: [{ start: 2, end: 1, text: "x" }] }, { ended: "yes" }, { startedAt: "2026-09-24T07:00:03" }])
      expect(() => parseLiveChunk({ ...chunkFixture(), ...bad }), JSON.stringify(bad)).toThrow(expect.objectContaining({ status: 400 }));
    const many = Array.from({ length: 501 }, (_, i) => seg(i, "x"));
    expect(() => parseLiveChunk({ ...chunkFixture(), segments: many })).toThrow(/at most 500/);
  });

  it("path id must be a UUID; canonical lowercase", () => {
    expect(parseTranscriptId(ID.toUpperCase())).toBe(ID);
    expect(() => parseTranscriptId("../x")).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("parseCursor: invalid → 0", () => {
    expect([null, "", "abc", "-3", "1.5", "7"].map(parseCursor)).toEqual([0, 0, 0, 0, 0, 7]);
  });
});

describe("live storage", () => {
  it("chunks append; cursor returns only newer segments; mic + system merged by start", () => {
    const d = db();
    expect(ingestLiveChunk(d, "dev1", ID, chunk("system", 0, [seg(1, "hello"), seg(6, "second")]), 100)).toEqual({ accepted: true });
    expect(ingestLiveChunk(d, "dev1", ID, chunk("mic", 0, [seg(3, "hi there", "Me")]), 200)).toEqual({ accepted: true });
    const all = getLive(d, ID, 0, new Map([["dev1", "Work Mac"]]))!;
    expect(all).toMatchObject({ status: "live", deviceName: "Work Mac", startedAt: "2026-09-24T07:00:03.000Z", lastChunkAt: new Date(200).toISOString() });
    expect(all.segments.map((s) => [s.stream, s.text])).toEqual([["system", "hello"], ["mic", "hi there"], ["system", "second"]]);
    expect(getLive(d, ID, all.cursor, new Map())!.segments).toEqual([]);
    ingestLiveChunk(d, "dev1", ID, chunk("system", 1, [seg(9, "third")]), 300);
    const next = getLive(d, ID, all.cursor, new Map())!;
    expect(next.segments.map((s) => s.text)).toEqual(["third"]);
    expect(next.cursor).toBeGreaterThan(all.cursor);
  });

  it("idempotent on (stream, seq): a device retry doesn't duplicate text", () => {
    const d = db();
    const c = chunk("system", 0, [seg(1, "hello")]);
    ingestLiveChunk(d, "dev1", ID, c, 100);
    expect(ingestLiveChunk(d, "dev1", ID, c, 101)).toEqual({ accepted: true });
    ingestLiveChunk(d, "dev1", ID, chunk("mic", 0, [seg(2, "same seq, other stream", "Me")]), 102);
    expect(getLive(d, ID, 0, new Map())!.segments).toHaveLength(2);
  });

  it("ended marker sticks; list shows the preview with live status, last chunk as end", () => {
    const d = db();
    ingestLiveChunk(d, "dev1", ID, chunk("system", 0, [seg(1, "a"), seg(2, "b")]), 1000);
    expect(listLive(d, new Map())[0]).toMatchObject({ id: ID, title: "Alice / Bob 1:1", attendeeCount: 2, segmentCount: 2, live: "live", endedAt: new Date(1000).toISOString() });
    ingestLiveChunk(d, "dev1", ID, chunk("system", 1, [], { ended: true }), 2000);
    ingestLiveChunk(d, "dev1", ID, chunk("mic", 5, []), 3000); // late mic chunk doesn't reopen
    expect(getLive(d, ID, 0, new Map())!.status).toBe("ended");
    expect(listLive(d, new Map())[0].live).toBe("ended");
  });

  it("final upload replaces the preview; late chunks after it are refused, not stored", () => {
    const d = db();
    ingestLiveChunk(d, "dev1", ID, chunk("system", 0, [seg(1, "a")]), 100);
    const t = parseTranscriptUpload(JSON.parse(readFileSync("shared/fixtures/transcript-upload.json", "utf8")));
    expect(t.id).toBe(ID);
    upsertTranscript(d, "dev1", t, "", 200);
    expect(listLive(d, new Map())).toEqual([]);
    expect(count(d, "SELECT count(*) n FROM live_segments")).toBe(0);
    expect(count(d, "SELECT count(*) n FROM live_chunks")).toBe(0);
    expect(ingestLiveChunk(d, "dev1", ID, chunk("system", 1, [seg(5, "late")]), 300)).toEqual({ accepted: false });
    expect(listLive(d, new Map())).toEqual([]);
    expect(getLive(d, ID, 0, new Map())).toMatchObject({ status: "final", segments: [], lastChunkAt: null, meeting: { title: "Alice / Bob 1:1" } });
  });

  it("deleting a live preview tombstones it: further chunks and the final upload → 410", () => {
    const d = db();
    ingestLiveChunk(d, "dev1", ID, chunk("system", 0, [seg(1, "secret")]), 100);
    expect(deleteTranscript(d, ID, 200)).toBe(true);
    expect(getLive(d, ID, 0, new Map())).toBeNull();
    expect(count(d, "SELECT count(*) n FROM live_segments")).toBe(0);
    expect(() => ingestLiveChunk(d, "dev1", ID, chunk("system", 1, [seg(2, "x")]), 300)).toThrow(expect.objectContaining({ status: 410 }));
    const t = parseTranscriptUpload(JSON.parse(readFileSync("shared/fixtures/transcript-upload.json", "utf8")));
    expect(() => upsertTranscript(d, "dev1", t, "", 400)).toThrow(expect.objectContaining({ status: 410 }));
    expect(listTranscripts(d, new Map())).toEqual([]);
  });

  it("discard (device) drops the preview without a tombstone; stale previews purged", () => {
    const d = db();
    ingestLiveChunk(d, "dev1", ID, chunk("system", 0, [seg(1, "a")]), 100);
    discardLive(d, ID);
    expect(getLive(d, ID, 0, new Map())).toBeNull();
    expect(ingestLiveChunk(d, "dev1", ID, chunk("system", 1, [seg(1, "b")]), 200)).toEqual({ accepted: true });

    purgeStaleLive(d, 200 + LIVE_MAX_IDLE_MS); // exactly at the limit: kept
    expect(listLive(d, new Map())).toHaveLength(1);
    purgeStaleLive(d, 201 + LIVE_MAX_IDLE_MS);
    expect(listLive(d, new Map())).toEqual([]);
    expect(count(d, "SELECT count(*) n FROM live_segments")).toBe(0);
  });
});
