import type { SearchResponse, SearchSegmentHit, TextPart } from "../shared/api.js";
import type { Db } from "./db.js";
import { HttpError } from "./http.js";
import { parseIsoTime, transcriptListItems } from "./transcripts.js";

const MAX_TERMS = 10; // bounds query cost: one subquery per term
const MAX_WITH = 5; // same: one subquery per attendee filter
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const SEGMENT_HITS = 3;
// bm25 column weights (title, attendees, text): a title/attendee hit says more than one spoken mention.
const BM25 = "bm25(search_fts, 10.0, 5.0, 1.0)";
// Highlight markers: control chars ASR never emits; split into parts server-side, never rendered as HTML.
const OPEN = "\u0002";
const CLOSE = "\u0003";

/**
 * User query → FTS5 terms. Every term is a quoted string, so FTS syntax (OR, NEAR, col:, *) is always literal
 * and can't error or target columns. Words = prefix match; "quoted" = exact phrase.
 */
export function parseSearchQuery(q: string): string[] {
  const terms: string[] = [];
  for (const m of q.matchAll(/"([^"]*)"?|([^\s"]+)/g)) {
    const phrase = m[1] !== undefined;
    const text = (phrase ? m[1] : m[2]).trim().replace(/\s+/g, " ");
    // No letters/digits = no tokens; an empty FTS phrase would AND the whole query to nothing.
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    const term = `"${text.replaceAll('"', '""')}"${phrase ? "" : "*"}`;
    if (!terms.includes(term)) terms.push(term);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

export interface SearchFilters {
  /** UTC ISO; recording start ≥ from. */
  from: string | null;
  /** UTC ISO; recording start < to. */
  to: string | null;
  /** FTS queries on the attendees column (attendee + organizer names/emails); all must match. */
  with: string[];
}

export interface SearchRequest {
  terms: string[];
  limit: number;
  filters: SearchFilters;
}

export function parseSearchRequest(params: URLSearchParams): SearchRequest {
  const terms = parseSearchQuery(params.get("q") ?? "");
  const time = (name: "from" | "to") => {
    const v = params.get(name);
    if (v === null || v === "") return null;
    const t = parseIsoTime(v);
    if (t === null) throw new HttpError(400, `${name} must be an ISO 8601 timestamp with zone.`);
    return t;
  };
  const from = time("from");
  const to = time("to");
  if (from && to && from >= to) throw new HttpError(400, "from must be before to.");
  const people = params.getAll("with").map((v) => v.trim().replace(/\s+/g, " ")).filter((v) => v);
  if (people.length > MAX_WITH) throw new HttpError(400, `at most ${MAX_WITH} with filters.`);
  // Quoted phrase-prefix pinned to the attendees column: user text can't escape into FTS syntax.
  const withQ = people.map((v) => {
    if (!/[\p{L}\p{N}]/u.test(v)) throw new HttpError(400, "with must contain letters or digits.");
    return `attendees : "${v.replaceAll('"', '""')}"*`;
  });
  const filters = { from, to, with: withQ };
  if (!terms.length && !hasFilters(filters)) throw new HttpError(400, 'q required (words or "quoted phrases") unless filtering.');
  const raw = params.get("limit");
  let limit = DEFAULT_LIMIT;
  if (raw !== null) {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new HttpError(400, "limit must be an integer.");
    limit = Math.min(MAX_LIMIT, Math.max(1, n));
  }
  return { terms, limit, filters };
}

const hasFilters = (f: SearchFilters) => f.from !== null || f.to !== null || f.with.length > 0;

/** CTEs ending in `ok(id, started_at)` = transcripts passing the filters; same MATERIALIZED rule as term CTEs. */
function filterCtes(f: SearchFilters): { ctes: string[]; params: unknown[] } {
  const ctes = f.with.map(
    (_, i) => `a${i} AS MATERIALIZED (SELECT rowid AS rid FROM search_fts WHERE search_fts MATCH ?),
      w${i} AS MATERIALIZED (SELECT DISTINCT r.transcript_id FROM a${i} JOIN search_rows r ON r.id = a${i}.rid)`,
  );
  const where = ["1"];
  const params: unknown[] = [...f.with];
  if (f.from) { where.push("started_at >= ?"); params.push(f.from); }
  if (f.to) { where.push("started_at < ?"); params.push(f.to); }
  f.with.forEach((_, i) => where.push(`id IN w${i}`));
  ctes.push(`ok AS MATERIALIZED (SELECT id, started_at FROM transcripts WHERE ${where.join(" AND ")})`);
  return { ctes, params };
}

/** FTS5 highlight() output → plain/matched runs. */
export function splitHighlight(s: string): TextPart[] {
  const parts: TextPart[] = [];
  for (const [i, chunk] of s.split(OPEN).entries()) {
    const [a, b] = i === 0 ? [null, chunk] : splitOnce(chunk, CLOSE);
    if (a) parts.push({ text: a, match: true });
    if (b) parts.push({ text: b, match: false });
  }
  return parts;
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

interface TranscriptHit {
  transcript_id: string;
  score: number;
  seg_count: number;
  meta: number;
}

interface SegmentRow {
  rid: number;
  transcript_id: string;
  seg: number;
  start: number;
  speaker: string | null;
}

/**
 * AND of terms per transcript (terms may match meta or different segments); ranked by summed bm25.
 * Filters only narrow (never score). No terms = filtered list, newest first.
 */
export function searchTranscripts(db: Db, req: SearchRequest, deviceNames: Map<string, string>): SearchResponse {
  const { terms, limit, filters } = req;
  const filtered = hasFilters(filters);
  if (!terms.length && !filtered) return { results: [], truncated: false };
  const f = filtered ? filterCtes(filters) : { ctes: [], params: [] };
  const any = terms.join(" OR ");
  let hits: TranscriptHit[];
  if (!terms.length) {
    hits = db
      .prepare(`WITH ${f.ctes.join(",\n")} SELECT id AS transcript_id, 0 AS score, 0 AS seg_count, 0 AS meta FROM ok ORDER BY started_at DESC, id LIMIT ?`)
      .all(...f.params, limit + 1) as TranscriptHit[];
  } else {
    // ⚠️ Every FTS scan sits in its own MATERIALIZED CTE, joined to search_rows outside it: bm25()/highlight()
    // only work in a plain FTS scan, and inlined MATCH subqueries get re-run per row (minutes on 500k rows).
    const termCtes = terms.map(
      (_, i) => `f${i} AS MATERIALIZED (SELECT rowid AS rid FROM search_fts WHERE search_fts MATCH ?),
      t${i} AS MATERIALIZED (SELECT DISTINCT r.transcript_id FROM f${i} JOIN search_rows r ON r.id = f${i}.rid)`,
    );
    const conds = terms.map((_, i) => `r.transcript_id IN t${i}`);
    if (filtered) conds.push("r.transcript_id IN (SELECT id FROM ok)");
    hits = db
      .prepare(
        `WITH ${[...f.ctes, ...termCtes].join(",\n")},
         m AS MATERIALIZED (SELECT rowid AS rid, ${BM25} AS score FROM search_fts WHERE search_fts MATCH ?)
         SELECT r.transcript_id, sum(m.score) AS score, count(r.seg) AS seg_count, max(r.seg IS NULL) AS meta
         FROM m JOIN search_rows r ON r.id = m.rid
         WHERE ${conds.join(" AND ")}
         GROUP BY r.transcript_id ORDER BY score, r.transcript_id LIMIT ?`,
      )
      .all(...f.params, ...terms, any, limit + 1) as TranscriptHit[];
  }
  const truncated = hits.length > limit;
  const top = hits.slice(0, limit);
  const ids = top.filter((h) => h.seg_count > 0).map((h) => h.transcript_id);

  // Best few segments per result transcript; highlight() only for those (it's per-row work).
  const segRows = ids.length
    ? (db
        .prepare(
          `WITH m AS MATERIALIZED (SELECT rowid AS rid, ${BM25} AS score FROM search_fts WHERE search_fts MATCH ?)
           SELECT rid, transcript_id, seg, start, speaker FROM (
             SELECT m.rid, r.transcript_id, r.seg, r.start, r.speaker,
               row_number() OVER (PARTITION BY r.transcript_id ORDER BY m.score, r.seg) AS rn
             FROM m JOIN search_rows r ON r.id = m.rid
             WHERE r.seg IS NOT NULL AND r.transcript_id IN (SELECT value FROM json_each(?))
           ) WHERE rn <= ${SEGMENT_HITS} ORDER BY transcript_id, seg`,
        )
        .all(any, JSON.stringify(ids)) as SegmentRow[])
    : [];
  // ⚠️ CAST: better-sqlite3 binds JS numbers as REAL and FTS5 silently ignores `rowid = <real>` → wrong row.
  const highlight = db.prepare(
    `SELECT highlight(search_fts, 2, '${OPEN}', '${CLOSE}') AS h FROM search_fts WHERE search_fts MATCH ? AND rowid = CAST(? AS INTEGER)`,
  );
  const segsByTranscript = new Map<string, SearchSegmentHit[]>();
  for (const s of segRows) {
    const h = (highlight.get(any, s.rid) as { h: string } | undefined)?.h ?? "";
    const list = segsByTranscript.get(s.transcript_id) ?? [];
    list.push({ index: s.seg, start: s.start, speaker: s.speaker, parts: splitHighlight(h) });
    segsByTranscript.set(s.transcript_id, list);
  }

  const items = transcriptListItems(db, top.map((h) => h.transcript_id), deviceNames);
  const results = top.flatMap((h) => {
    const transcript = items.get(h.transcript_id);
    if (!transcript) return [];
    return [{ transcript, metaMatch: h.meta === 1, segmentMatchCount: h.seg_count, segments: segsByTranscript.get(h.transcript_id) ?? [] }];
  });
  return { results, truncated };
}
