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
    expect(p("q=plan")).toMatchObject({ terms: [`"plan"*`], limit: 20 });
    expect(p("q=plan&limit=500").limit).toBe(50);
    expect(p("q=plan&limit=0").limit).toBe(1);
    expect(() => p("q=plan&limit=abc")).toThrow(/limit/);
  });

  it("filters: from/to → UTC ISO (zone required, from < to); with → attendee-column phrase-prefix", () => {
    expect(p("q=plan").filters).toEqual({ from: null, to: null, with: [] });
    const f = p("q=plan&from=2026-09-01T00:00:00%2B02:00&to=2026-10-01T00:00:00Z&with=Bob&with=%20alice%20%20ex%20").filters;
    expect(f).toEqual({ from: "2026-08-31T22:00:00.000Z", to: "2026-10-01T00:00:00.000Z", with: [`attendees : "Bob"*`, `attendees : "alice ex"*`] });
    expect(() => p("q=plan&from=2026-09-01")).toThrow(/from/);
    expect(() => p("q=plan&to=nope")).toThrow(/to/);
    expect(() => p("q=plan&from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z")).toThrow(/before/);
    expect(() => p("q=plan&with=%20-%20")).toThrow(/with/);
    expect(() => p(`q=plan${"&with=a".repeat(6)}`)).toThrow(/with/);
    expect(p(`with=${encodeURIComponent('x" OR y')}`).filters.with).toEqual([`attendees : "x"" OR y"*`]);
  });

  it("q optional when a filter is given", () => {
    expect(p("from=2026-09-01T00:00:00Z")).toMatchObject({ terms: [] });
    expect(p("with=bob").terms).toEqual([]);
    expect(() => p("q=&limit=5")).toThrow(/q required/);
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
  const noFilters = { from: null, to: null, with: [] };
  const search = (d: Database.Database, q: string, limit = 20) => searchTranscripts(d, { terms: parseSearchQuery(q), limit, filters: noFilters }, names);
  const filtered = (d: Database.Database, qs: string) => searchTranscripts(d, parseSearchRequest(new URLSearchParams(qs)), names);
  const ids = (r: { results: { transcript: { id: string } }[] }) => r.results.map((x) => x.transcript.id);

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
    // Raw insert: today's upsertTranscript needs tables from later migrations.
    const t = parseTranscriptUpload(fixture());
    d.prepare(
      `INSERT INTO transcripts (id, device_id, started_at, ended_at, title, segment_count, raw, data, received_at, updated_at)
       VALUES (?, 'dev1', ?, ?, ?, ?, '', ?, 1, 1)`,
    ).run(t.id, t.startedAt, t.endedAt, t.meeting?.title ?? null, t.segments.length, JSON.stringify(t));
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

  it("no terms and no filters → empty result (no query run)", () => {
    expect(searchTranscripts(db(), { terms: [], limit: 20, filters: noFilters }, names)).toEqual({ results: [], truncated: false });
  });

  describe("filters", () => {
    const FIX = "6f1c2b7e-3d4a-4e5f-9a8b-1c2d3e4f5a6b"; // started 2026-09-24T07:00:03Z, Alice + Bob
    const ID3 = "00000000-0000-4000-8000-000000000003";
    const withTwo = () => {
      const d = db();
      const later = { ...fixture(), id: ID2, startedAt: "2026-10-02T10:00:00Z", endedAt: "2026-10-02T10:30:00Z",
        meeting: { ...fixture().meeting, title: "Roadmap with Zoë", organizer: null, attendees: [{ name: "Zoë Müller", email: "zoe@corp.example" }] } };
      upsertTranscript(d, "dev1", parseTranscriptUpload(later), "", 2);
      const adhoc = { ...fixture(), id: ID3, startedAt: "2026-09-10T10:00:00Z", endedAt: "2026-09-10T10:05:00Z", meeting: null };
      upsertTranscript(d, "dev1", parseTranscriptUpload(adhoc), "", 3);
      return d;
    };

    it("date range: from inclusive, to exclusive, on recording start", () => {
      const d = withTwo();
      expect(ids(filtered(d, "q=roadmap"))).toHaveLength(3);
      expect(ids(filtered(d, "q=roadmap&from=2026-09-24T07:00:03Z&to=2026-10-02T10:00:00Z"))).toEqual([FIX]);
      expect(ids(filtered(d, "q=roadmap&from=2026-09-24T07:00:04Z")).sort()).toEqual([ID2]);
      expect(ids(filtered(d, "q=roadmap&to=2026-09-24T07:00:03Z"))).toEqual([ID3]);
    });

    it("with: attendee/organizer name or email prefix, case + accent insensitive; several = all present", () => {
      const d = withTwo();
      expect(ids(filtered(d, "q=roadmap&with=zoe"))).toEqual([ID2]);
      expect(ids(filtered(d, "q=roadmap&with=MULLER"))).toEqual([ID2]);
      expect(ids(filtered(d, "q=roadmap&with=bob%40example.com"))).toEqual([FIX]);
      expect(ids(filtered(d, "q=roadmap&with=alice&with=bob"))).toEqual([FIX]);
      expect(ids(filtered(d, "q=roadmap&with=alice&with=zoe"))).toEqual([]);
      // Speech/title mentions don't count as attendance.
      expect(ids(filtered(d, "q=roadmap&with=roadmap"))).toEqual([]);
    });

    it("filter doesn't change ranking inputs: metaMatch only from q", () => {
      const [hit] = filtered(withTwo(), "q=hiring&with=bob").results;
      expect(hit).toMatchObject({ metaMatch: false, segmentMatchCount: 1 });
    });

    it("filters without q: newest first, no segment hits; limit → truncated", () => {
      const d = withTwo();
      const r = filtered(d, "from=2026-09-01T00:00:00Z");
      expect(ids(r)).toEqual([ID2, FIX, ID3]);
      expect(r.results[0]).toMatchObject({ metaMatch: false, segmentMatchCount: 0, segments: [] });
      expect(ids(filtered(d, "with=alice"))).toEqual([FIX]);
      const one = filtered(d, "from=2026-09-01T00:00:00Z&limit=1");
      expect(one).toMatchObject({ truncated: true });
      expect(ids(one)).toEqual([ID2]);
    });
  });
});
