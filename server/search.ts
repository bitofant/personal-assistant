import type { SearchResponse, SearchSegmentHit, TextPart } from "../shared/api.js";
import type { Db } from "./db.js";
import { HttpError } from "./http.js";
import { transcriptListItems } from "./transcripts.js";

const MAX_TERMS = 10; // bounds query cost: one subquery per term
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

export function parseSearchRequest(params: URLSearchParams): { terms: string[]; limit: number } {
  const terms = parseSearchQuery(params.get("q") ?? "");
  if (!terms.length) throw new HttpError(400, "q required (words or \"quoted phrases\").");
  const raw = params.get("limit");
  let limit = DEFAULT_LIMIT;
  if (raw !== null) {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new HttpError(400, "limit must be an integer.");
    limit = Math.min(MAX_LIMIT, Math.max(1, n));
  }
  return { terms, limit };
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

/** AND of terms per transcript (terms may match meta or different segments); ranked by summed bm25. */
export function searchTranscripts(db: Db, terms: string[], limit: number, deviceNames: Map<string, string>): SearchResponse {
  if (!terms.length) return { results: [], truncated: false };
  const any = terms.join(" OR ");
  // ⚠️ Every FTS scan sits in its own MATERIALIZED CTE, joined to search_rows outside it: bm25()/highlight()
  // only work in a plain FTS scan, and inlined MATCH subqueries get re-run per row (minutes on 500k rows).
  const termCtes = terms.map(
    (_, i) => `f${i} AS MATERIALIZED (SELECT rowid AS rid FROM search_fts WHERE search_fts MATCH ?),
      t${i} AS MATERIALIZED (SELECT DISTINCT r.transcript_id FROM f${i} JOIN search_rows r ON r.id = f${i}.rid)`,
  );
  const hits = db
    .prepare(
      `WITH ${termCtes.join(",\n")},
       m AS MATERIALIZED (SELECT rowid AS rid, ${BM25} AS score FROM search_fts WHERE search_fts MATCH ?)
       SELECT r.transcript_id, sum(m.score) AS score, count(r.seg) AS seg_count, max(r.seg IS NULL) AS meta
       FROM m JOIN search_rows r ON r.id = m.rid
       WHERE ${terms.map((_, i) => `r.transcript_id IN t${i}`).join(" AND ")}
       GROUP BY r.transcript_id ORDER BY score, r.transcript_id LIMIT ?`,
    )
    .all(...terms, any, limit + 1) as TranscriptHit[];
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
