import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { migrate, USER_MIGRATIONS } from "./db.js";
import { parseSearchQuery, parseSearchRequest, searchTranscripts, splitHighlight } from "./search.js";
import { parseTranscriptUpload, upsertTranscript } from "./transcripts.js";

const fixture = () => JSON.parse(readFileSync("shared/fixtures/transcript-upload.json", "utf8")) as Record<string, any>;
const ID2 = "00000000-0000-4000-8000-000000000002";

describe("parseSearchQuery", () => {
  it("words → quoted prefix terms; quoted phrases → exact phrase", () => {
    expect(parseSearchQuery(`Q4 "hiring plan" road`)).toEqual([`"Q4"*`, `"hiring plan"`, `"road"*`]);
  });

  it("unbalanced quote = phrase to end; FTS syntax is literal, never operators", () => {
    expect(parseSearchQuery(`say "hi there`)).toEqual([`"say"*`, `"hi there"`]);
    expect(parseSearchQuery(`a OR b NOT c* title:x NEAR(`)).toEqual([`"a"*`, `"OR"*`, `"b"*`, `"NOT"*`, `"c*"*`, `"title:x"*`, `"NEAR("*`]);
    expect(parseSearchQuery(`ab"cd`)).toEqual([`"ab"*`, `"cd"`]);
  });

  it("drops terms without letters/digits and duplicates; blank → []", () => {
    expect(parseSearchQuery(` - "" * plan plan "  " `)).toEqual([`"plan"*`]);
    expect(parseSearchQuery("   ")).toEqual([]);
  });

  it("caps the number of terms", () => {
    expect(parseSearchQuery(Array.from({ length: 30 }, (_, i) => `w${i}`).join(" "))).toHaveLength(10);
  });
});

describe("parseSearchRequest", () => {
  const p = (qs: string) => parseSearchRequest(new URLSearchParams(qs));
  it("q required (blank or only punctuation → 400); limit defaults to 20, clamped 1–50", () => {
    expect(() => p("")).toThrow(/q required/);
    expect(() => p("q=%20-%20")).toThrow(/q required/);
    expect(p("q=plan")).toEqual({ terms: [`"plan"*`], limit: 20 });
    expect(p("q=plan&limit=500").limit).toBe(50);
    expect(p("q=plan&limit=0").limit).toBe(1);
    expect(() => p("q=plan&limit=abc")).toThrow(/limit/);
  });
});

describe("splitHighlight", () => {
  it("splits marker-delimited matches into parts; drops empty runs", () => {
    expect(splitHighlight("a \u0002b\u0003 c \u0002d\u0003")).toEqual([
      { text: "a ", match: false },
      { text: "b", match: true },
      { text: " c ", match: false },
      { text: "d", match: true },
    ]);
    expect(splitHighlight("plain")).toEqual([{ text: "plain", match: false }]);
  });
});

describe("searchTranscripts", () => {
  const db = () => {
    const d = new Database(":memory:");
    migrate(d, USER_MIGRATIONS);
    upsertTranscript(d, "dev1", parseTranscriptUpload(fixture()), "", 1);
    return d;
  };
  const names = new Map([["dev1", "Mac"]]);
  const search = (d: Database.Database, q: string, limit = 20) => searchTranscripts(d, parseSearchQuery(q), limit, names);

  it("segment hit: highlighted parts, speaker, index; list item joined", () => {
    const r = search(db(), "roadmap");
    expect(r.truncated).toBe(false);
    expect(r.results).toHaveLength(1);
    const [hit] = r.results;
    expect(hit.transcript).toMatchObject({ id: "6f1c2b7e-3d4a-4e5f-9a8b-1c2d3e4f5a6b", title: "Alice / Bob 1:1", deviceName: "Mac" });
    expect(hit.metaMatch).toBe(false);
    expect(hit.segmentMatchCount).toBe(1);
    expect(hit.segments).toEqual([
      {
        index: 1,
        start: 4.6,
        speaker: "Speaker 2",
        parts: [
          { text: "Good, we mostly talked about the Q4 ", match: false },
          { text: "roadmap", match: true },
          { text: ".", match: false },
        ],
      },
    ]);
  });

  it("attendee names + emails and title are searchable (meta match, no segment hits)", () => {
    const d = db();
    for (const q of ["bob", "BOB@example.com", "builder", "1:1"]) {
      const r = search(d, q);
      expect(r.results, q).toHaveLength(1);
      expect(r.results[0]).toMatchObject({ metaMatch: true, segmentMatchCount: 0, segments: [] });
    }
  });

  it("terms AND across the whole transcript (meta + different segments); missing term → nothing", () => {
    const d = db();
    expect(search(d, "bob roadmap hiring").results).toHaveLength(1);
    expect(search(d, "roadmap zebra").results).toHaveLength(0);
  });

  it("multi-term query still highlights segment text (only the terms found there)", () => {
    const [hit] = search(db(), `bob "q4 roadmap"`).results;
    expect(hit.segments[0].parts.filter((p) => p.match).map((p) => p.text)).toEqual(["Q4 roadmap"]);
  });

  it("prefix words, exact phrases, case + accent insensitive", () => {
    const d = db();
    expect(search(d, "ROAD").results).toHaveLength(1);
    expect(search(d, `"hiring plan"`).results[0].segments.map((s) => s.index)).toEqual([2]);
    expect(search(d, `"plan hiring"`).results).toHaveLength(0);
    const f = { ...fixture(), id: ID2, meeting: null, segments: [{ start: 1, end: 2, speaker: null, text: "Koffie in het café." }] };
    upsertTranscript(d, "dev1", parseTranscriptUpload(f), "", 2);
    expect(search(d, "CAFE").results.map((r) => r.transcript.id)).toEqual([ID2]);
  });

  it("speaker labels are not indexed (diarization labels would match everything)", () => {
    expect(search(db(), "speaker").results).toHaveLength(0);
  });

  it("re-upload replaces the index; identical re-upload doesn't duplicate", () => {
    const d = db();
    upsertTranscript(d, "dev1", parseTranscriptUpload(fixture()), "", 2);
    expect(search(d, "roadmap").results[0].segmentMatchCount).toBe(1);
    const f = fixture();
    f.segments[1].text = "We discussed the budget.";
    f.meeting.title = "Budget sync";
    upsertTranscript(d, "dev1", parseTranscriptUpload(f), "", 3);
    expect(search(d, "roadmap").results).toHaveLength(0);
    expect(search(d, "1:1").results).toHaveLength(0);
    expect(search(d, "budget").results[0]).toMatchObject({ metaMatch: true, segmentMatchCount: 1 });
  });

  it("migration backfills transcripts stored before search existed", () => {
    const d = new Database(":memory:");
    migrate(d, USER_MIGRATIONS.slice(0, 3));
    upsertTranscript(d, "dev1", parseTranscriptUpload(fixture()), "", 1);
    migrate(d, USER_MIGRATIONS);
    expect(search(d, "bob roadmap").results).toHaveLength(1);
  });

  it("title match outranks a passing mention in speech; limit → truncated", () => {
    const d = db();
    const titled = { ...fixture(), id: ID2, meeting: { ...fixture().meeting, title: "Roadmap review" }, segments: [{ start: 0, end: 1, speaker: null, text: "Hello all." }] };
    upsertTranscript(d, "dev1", parseTranscriptUpload(titled), "", 2);
    const r = search(d, "roadmap");
    expect(r.results.map((x) => x.transcript.id)).toEqual([ID2, "6f1c2b7e-3d4a-4e5f-9a8b-1c2d3e4f5a6b"]);
    expect(r.results[0]).toMatchObject({ metaMatch: true, segmentMatchCount: 0 });

    const one = search(d, "roadmap", 1);
    expect(one.results).toHaveLength(1);
    expect(one.truncated).toBe(true);
  });

  it("max 3 segment hits, best-ranked, shown in transcript order", () => {
    const d = db();
    const segs = [
      { start: 0, end: 1, speaker: null, text: "roadmap and some other long words that dilute the match a lot here" },
      { start: 1, end: 2, speaker: null, text: "roadmap roadmap" },
      { start: 2, end: 3, speaker: null, text: "unrelated" },
      { start: 3, end: 4, speaker: null, text: "roadmap" },
      { start: 4, end: 5, speaker: null, text: "the roadmap" },
    ];
    upsertTranscript(d, "dev1", parseTranscriptUpload({ ...fixture(), id: ID2, meeting: null, segments: segs }), "", 2);
    const hit = search(d, "roadmap").results.find((x) => x.transcript.id === ID2)!;
    expect(hit.segmentMatchCount).toBe(4);
    expect(hit.segments.map((s) => s.index)).toEqual([1, 3, 4]); // weakest (diluted) match dropped
  });

  it("no terms → empty result (no query run)", () => {
    expect(searchTranscripts(db(), [], 20, names)).toEqual({ results: [], truncated: false });
  });
});
