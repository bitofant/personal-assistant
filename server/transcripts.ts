import type {
  MeetingMeta,
  Person,
  TranscriptDetail,
  TranscriptListItem,
  TranscriptSegment,
  TranscriptUpload,
  TranscriptUploadResponse,
} from "../shared/api.js";
import type { Db } from "./db.js";
import { HttpError, isRecord } from "./http.js";

// Long meetings with many segments; well above a 3h transcript.
export const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validate + normalize an upload (pure). Unknown fields ignored for forward compat; raw body is kept verbatim anyway. */
export function parseTranscriptUpload(raw: unknown): TranscriptUpload {
  const errors: string[] = [];
  const r = isRecord(raw) ? raw : (errors.push("body must be an object"), {} as Record<string, unknown>);

  const id = typeof r.id === "string" ? r.id.trim().toLowerCase() : "";
  if (!UUID_RE.test(id)) errors.push("id must be a UUID");

  const startedAt = isoTime(r.startedAt, "startedAt", errors);
  const endedAt = isoTime(r.endedAt, "endedAt", errors);
  if (startedAt && endedAt && endedAt < startedAt) errors.push("endedAt before startedAt");

  let meeting: MeetingMeta | null = null;
  if (r.meeting != null) {
    if (!isRecord(r.meeting)) errors.push("meeting must be an object or null");
    else meeting = parseMeeting(r.meeting, errors);
  }

  const segments: TranscriptSegment[] = [];
  if (!Array.isArray(r.segments)) errors.push("segments must be an array");
  else
    for (const [i, s] of r.segments.entries()) {
      const at = `segments[${i}]`;
      if (!isRecord(s)) { errors.push(`${at} must be an object`); continue; }
      const ok = isTime(s.start) && isTime(s.end) && (s.end as number) >= (s.start as number);
      if (!ok) errors.push(`${at}: start/end must be seconds >= 0 with end >= start`);
      if (typeof s.text !== "string") errors.push(`${at}.text must be a string`);
      if (s.speaker != null && typeof s.speaker !== "string") errors.push(`${at}.speaker must be a string or null`);
      if (errors.length > 20) break; // don't build a megabyte error message
      segments.push({ start: s.start as number, end: s.end as number, speaker: str(s.speaker), text: String(s.text) });
    }

  const asrModel = str(r.asrModel);
  if (!asrModel) errors.push("asrModel required");
  if (r.diarizationModel != null && typeof r.diarizationModel !== "string") errors.push("diarizationModel must be a string or null");

  if (errors.length) throw new HttpError(400, `Invalid transcript:\n  - ${errors.slice(0, 20).join("\n  - ")}`);
  return { id, startedAt: startedAt!, endedAt: endedAt!, meeting, segments, asrModel: asrModel!, diarizationModel: str(r.diarizationModel) };
}

function parseMeeting(m: Record<string, unknown>, errors: string[]): MeetingMeta {
  for (const k of ["calendarName", "eventId", "seriesId", "title"])
    if (m[k] != null && typeof m[k] !== "string") errors.push(`meeting.${k} must be a string or null`);
  const start = isoTime(m.start, "meeting.start", errors);
  const end = isoTime(m.end, "meeting.end", errors);
  if (m.attendees != null && !Array.isArray(m.attendees)) errors.push("meeting.attendees must be an array");
  const attendees = (Array.isArray(m.attendees) ? m.attendees : [])
    .map((a, i) => parsePerson(a, `meeting.attendees[${i}]`, errors))
    .filter((p): p is Person => p !== null);
  return {
    calendarName: str(m.calendarName),
    eventId: str(m.eventId),
    seriesId: str(m.seriesId),
    title: str(m.title),
    start: start ?? "",
    end: end ?? "",
    organizer: parsePerson(m.organizer, "meeting.organizer", errors),
    attendees,
  };
}

/** Canonical person: trimmed name, lowercase email; all-null = dropped. */
function parsePerson(p: unknown, at: string, errors: string[]): Person | null {
  if (p == null) return null;
  if (!isRecord(p)) { errors.push(`${at} must be an object`); return null; }
  const name = str(p.name);
  const email = str(p.email)?.toLowerCase() ?? null;
  return name || email ? { name, email } : null;
}

/** Trimmed non-empty string, else null (missing ≠ ""). */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isTime(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Canonical UTC ISO; requires an explicit zone so a device's local time can't be misread. */
export function parseIsoTime(v: unknown): string | null {
  const ok = typeof v === "string" && /(Z|[+-]\d\d:?\d\d)$/.test(v) && !Number.isNaN(Date.parse(v));
  return ok ? new Date(v as string).toISOString() : null;
}

function isoTime(v: unknown, at: string, errors: string[]): string | null {
  const t = parseIsoTime(v);
  if (t === null) errors.push(`${at} must be an ISO 8601 timestamp with zone`);
  return t;
}

// ---- storage (per-user DB) ----

/** `changed` = new or different content; identical re-upload (device retry) = false, so no re-summarize. */
export function upsertTranscript(
  db: Db,
  deviceId: string,
  t: TranscriptUpload,
  raw: string,
  now: number,
): TranscriptUploadResponse & { changed: boolean } {
  if (db.prepare("SELECT 1 FROM deleted_transcripts WHERE id = ?").get(t.id))
    throw new HttpError(410, "This transcript was deleted on the server; it won't be stored again.");
  const data = JSON.stringify(t);
  const prev = db.prepare("SELECT data FROM transcripts WHERE id = ?").get(t.id) as { data: string } | undefined;
  db.prepare(
    `INSERT INTO transcripts (id, device_id, started_at, ended_at, title, calendar_name, event_id, series_id,
       attendee_count, segment_count, raw, data, received_at, updated_at)
     VALUES (@id, @deviceId, @startedAt, @endedAt, @title, @calendarName, @eventId, @seriesId,
       @attendeeCount, @segmentCount, @raw, @data, @now, @now)
     ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id, started_at = excluded.started_at,
       ended_at = excluded.ended_at, title = excluded.title, calendar_name = excluded.calendar_name,
       event_id = excluded.event_id, series_id = excluded.series_id, attendee_count = excluded.attendee_count,
       segment_count = excluded.segment_count, raw = excluded.raw, data = excluded.data,
       -- updated_at = content last changed; drives summary staleness, so a no-op re-upload keeps it.
       updated_at = CASE WHEN data = excluded.data THEN updated_at ELSE excluded.updated_at END`,
  ).run({
    id: t.id,
    deviceId,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    title: t.meeting?.title ?? null,
    calendarName: t.meeting?.calendarName ?? null,
    eventId: t.meeting?.eventId ?? null,
    seriesId: t.meeting?.seriesId ?? null,
    // Ad-hoc call: attendee count unknown, not 0.
    attendeeCount: t.meeting ? t.meeting.attendees.length : null,
    segmentCount: t.segments.length,
    raw,
    data,
    now,
  });
  return { id: t.id, created: !prev, changed: prev?.data !== data };
}

interface Row {
  id: string;
  device_id: string;
  started_at: string;
  ended_at: string;
  title: string | null;
  calendar_name: string | null;
  attendee_count: number | null;
  segment_count: number;
  data: string;
  received_at: number;
  updated_at: number;
}

const LIST_COLUMNS = "id, device_id, started_at, ended_at, title, calendar_name, attendee_count, segment_count";

function toListItem(r: Row, deviceNames: Map<string, string>): TranscriptListItem {
  return {
    id: r.id,
    title: r.title,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    calendarName: r.calendar_name,
    attendeeCount: r.attendee_count,
    segmentCount: r.segment_count,
    deviceName: deviceNames.get(r.device_id) ?? null,
  };
}

export function listTranscripts(db: Db, deviceNames: Map<string, string>): TranscriptListItem[] {
  const rows = db.prepare(`SELECT ${LIST_COLUMNS} FROM transcripts ORDER BY started_at DESC`).all() as Row[];
  return rows.map((r) => toListItem(r, deviceNames));
}

/** List items for canonical ids, keyed by id (missing ids absent). */
export function transcriptListItems(db: Db, ids: string[], deviceNames: Map<string, string>): Map<string, TranscriptListItem> {
  const rows = db
    .prepare(`SELECT ${LIST_COLUMNS} FROM transcripts WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as Row[];
  return new Map(rows.map((r) => [r.id, toListItem(r, deviceNames)]));
}

/** `id` must already be canonical (lowercase). */
export function transcriptExists(db: Db, id: string): boolean {
  return db.prepare("SELECT 1 FROM transcripts WHERE id = ?").get(id) !== undefined;
}

/**
 * Deletes a transcript + (FK cascade) its summary and search rows (FTS via their delete trigger), and leaves a
 * tombstone so re-uploads get 410. False = no such transcript. Caller drops app.db jobs (other DB).
 */
export function deleteTranscript(db: Db, id: string, now: number): boolean {
  const canonical = id.toLowerCase();
  return db.transaction(() => {
    if (db.prepare("DELETE FROM transcripts WHERE id = ?").run(canonical).changes === 0) return false;
    db.prepare("INSERT OR REPLACE INTO deleted_transcripts (id, deleted_at) VALUES (?, ?)").run(canonical, now);
    return true;
  })();
}

// Summary fields live elsewhere (summaries table, app.db jobs); app.ts joins them.
export function getTranscript(db: Db, id: string, deviceNames: Map<string, string>): Omit<TranscriptDetail, "summary" | "summaryJob"> | null {
  const r = db.prepare("SELECT * FROM transcripts WHERE id = ?").get(id.toLowerCase()) as Row | undefined;
  if (!r) return null;
  return {
    ...(JSON.parse(r.data) as TranscriptUpload),
    deviceId: r.device_id,
    deviceName: deviceNames.get(r.device_id) ?? null,
    receivedAt: new Date(r.received_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
