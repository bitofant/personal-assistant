import type { LiveChunk, LiveChunkResponse, LiveSegment, LiveStream, LiveTranscriptResponse, MeetingMeta, TranscriptListItem } from "../shared/api.js";
import type { Db } from "./db.js";
import { HttpError, isRecord } from "./http.js";
import { isoTime, parseMeeting, parseSegments } from "./transcripts.js";

// A chunk = a few seconds of speech; generous but bounded.
export const MAX_LIVE_CHUNK_BYTES = 1024 * 1024;
const MAX_LIVE_SEGMENTS = 500;
/** No chunk for this long and still no final transcript → preview dropped (Mac crashed / gave up). */
export const LIVE_MAX_IDLE_MS = 24 * 3600_000;
const STREAMS: readonly LiveStream[] = ["mic", "system"];

/** Validate + normalize a live chunk (pure). */
export function parseLiveChunk(raw: unknown): LiveChunk {
  const errors: string[] = [];
  const r = isRecord(raw) ? raw : (errors.push("body must be an object"), {} as Record<string, unknown>);
  const stream = STREAMS.find((s) => s === r.stream);
  if (!stream) errors.push(`stream must be one of ${STREAMS.join(", ")}`);
  if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 0) errors.push("seq must be an integer >= 0");
  const startedAt = isoTime(r.startedAt, "startedAt", errors);
  let meeting: MeetingMeta | null = null;
  if (r.meeting != null) {
    if (!isRecord(r.meeting)) errors.push("meeting must be an object or null");
    else meeting = parseMeeting(r.meeting, errors);
  }
  if (Array.isArray(r.segments) && r.segments.length > MAX_LIVE_SEGMENTS) errors.push(`at most ${MAX_LIVE_SEGMENTS} segments per chunk`);
  const segments = errors.length ? [] : parseSegments(r.segments, errors);
  if (r.ended != null && typeof r.ended !== "boolean") errors.push("ended must be a boolean");
  if (errors.length) throw new HttpError(400, `Invalid live chunk:\n  - ${errors.slice(0, 20).join("\n  - ")}`);
  const c: LiveChunk = { stream: stream!, seq: r.seq as number, startedAt: startedAt!, meeting, segments };
  if (r.ended === true) c.ended = true;
  return c;
}

/** `id` must be canonical (lowercase UUID). Tombstoned → 410; final transcript stored → not accepted (late chunk). */
export function ingestLiveChunk(db: Db, deviceId: string, id: string, c: LiveChunk, now: number): LiveChunkResponse {
  return db.transaction((): LiveChunkResponse => {
    if (db.prepare("SELECT 1 FROM deleted_transcripts WHERE id = ?").get(id))
      throw new HttpError(410, "This transcript was deleted on the server; it won't be stored again.");
    // A late chunk must not resurrect a preview next to the real transcript.
    if (db.prepare("SELECT 1 FROM transcripts WHERE id = ?").get(id)) return { accepted: false };
    db.prepare(
      `INSERT INTO live_transcripts (id, device_id, started_at, meeting, ended, created_at, last_chunk_at)
       VALUES (@id, @deviceId, @startedAt, @meeting, @ended, @now, @now)
       ON CONFLICT(id) DO UPDATE SET meeting = excluded.meeting, ended = max(ended, excluded.ended),
         last_chunk_at = excluded.last_chunk_at`,
    ).run({ id, deviceId, startedAt: c.startedAt, meeting: c.meeting && JSON.stringify(c.meeting), ended: c.ended ? 1 : 0, now });
    const fresh = db.prepare("INSERT OR IGNORE INTO live_chunks (transcript_id, stream, seq) VALUES (?, ?, ?)").run(id, c.stream, c.seq).changes;
    if (!fresh) return { accepted: true }; // retry of a chunk already stored
    const ins = db.prepare("INSERT INTO live_segments (transcript_id, stream, start, end, speaker, text) VALUES (?, ?, ?, ?, ?, ?)");
    for (const s of c.segments) ins.run(id, c.stream, s.start, s.end, s.speaker, s.text);
    return { accepted: true };
  })();
}

/** Recording discarded on the Mac: drop the preview, no tombstone (nothing the user deleted). */
export function discardLive(db: Db, id: string): void {
  db.prepare("DELETE FROM live_transcripts WHERE id = ?").run(id);
}

export function purgeStaleLive(db: Db, now: number): void {
  db.prepare("DELETE FROM live_transcripts WHERE last_chunk_at < ?").run(now - LIVE_MAX_IDLE_MS);
}

interface LiveRow {
  id: string;
  device_id: string;
  started_at: string;
  meeting: string | null;
  ended: number;
  last_chunk_at: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Live previews as list items (`endedAt` = last chunk). */
export function listLive(db: Db, deviceNames: Map<string, string>): TranscriptListItem[] {
  const rows = db
    .prepare("SELECT l.*, (SELECT count(*) FROM live_segments s WHERE s.transcript_id = l.id) AS n FROM live_transcripts l")
    .all() as (LiveRow & { n: number })[];
  return rows.map((r) => {
    const m = r.meeting ? (JSON.parse(r.meeting) as MeetingMeta) : null;
    return {
      id: r.id,
      title: m?.title ?? null,
      startedAt: r.started_at,
      endedAt: iso(r.last_chunk_at),
      calendarName: m?.calendarName ?? null,
      attendeeCount: m ? m.attendees.length : null,
      segmentCount: r.n,
      deviceName: deviceNames.get(r.device_id) ?? null,
      live: r.ended ? "ended" : "live",
    };
  });
}

/** Segments with cursor > `after`, in start order. null = neither live nor final transcript. */
export function getLive(db: Db, id: string, after: number, deviceNames: Map<string, string>): LiveTranscriptResponse | null {
  const r = db.prepare("SELECT * FROM live_transcripts WHERE id = ?").get(id) as LiveRow | undefined;
  if (!r) {
    const t = db.prepare("SELECT started_at, device_id, data FROM transcripts WHERE id = ?").get(id) as
      | { started_at: string; device_id: string; data: string }
      | undefined;
    if (!t) return null;
    const meeting = (JSON.parse(t.data) as { meeting: MeetingMeta | null }).meeting;
    return { id, status: "final", startedAt: t.started_at, meeting, deviceName: deviceNames.get(t.device_id) ?? null, lastChunkAt: null, segments: [], cursor: after };
  }
  const rows = db
    .prepare("SELECT id, stream, start, end, speaker, text FROM live_segments WHERE transcript_id = ? AND id > ? ORDER BY id")
    .all(id, after) as (LiveSegment & { id: number })[];
  const cursor = rows.length ? rows[rows.length - 1].id : after;
  const segments = rows
    .map(({ id: _id, ...s }) => s)
    .sort((a, b) => a.start - b.start);
  return {
    id,
    status: r.ended ? "ended" : "live",
    startedAt: r.started_at,
    meeting: r.meeting ? (JSON.parse(r.meeting) as MeetingMeta) : null,
    deviceName: deviceNames.get(r.device_id) ?? null,
    lastChunkAt: iso(r.last_chunk_at),
    segments,
    cursor,
  };
}

/** `after` query param: missing/invalid → 0 (everything). */
export function parseCursor(v: string | null): number {
  const n = Number(v);
  return v !== null && Number.isSafeInteger(n) && n > 0 ? n : 0;
}
