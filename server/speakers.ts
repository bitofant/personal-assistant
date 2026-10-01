import type { TranscriptUpload } from "../shared/api.js";
import type { Db } from "./db.js";
import { HttpError, isRecord } from "./http.js";

// User names for diarization labels ("Speaker 2" → "Bob"), per transcript. Raw segments never change; names are
// applied where text is shown or sent to the LLM.

export const MAX_SPEAKER_NAME = 100;

/** Distinct non-null speaker labels, in order of first appearance. */
export function speakerLabels(t: Pick<TranscriptUpload, "segments">): string[] {
  return [...new Set(t.segments.map((s) => s.speaker).filter((s): s is string => s !== null))];
}

/**
 * `{names: {label: name|null}}` → label → trimmed name (null = remove). Labels must occur in the transcript.
 * Control chars rejected: a name with a newline could forge "[m:ss] Speaker:" lines in the LLM prompt.
 */
export function parseSpeakerNames(raw: unknown, labels: readonly string[]): Map<string, string | null> {
  if (!isRecord(raw) || !isRecord(raw.names)) throw new HttpError(400, "names must be an object (label → name or null).");
  const known = new Set(labels);
  const out = new Map<string, string | null>();
  for (const [label, v] of Object.entries(raw.names)) {
    if (!known.has(label)) throw new HttpError(400, `No speaker "${label}" in this transcript.`);
    if (v !== null && typeof v !== "string") throw new HttpError(400, `Name for "${label}" must be a string or null.`);
    const name = v?.trim() || null;
    if (name && name.length > MAX_SPEAKER_NAME) throw new HttpError(400, `Name for "${label}" is too long (max ${MAX_SPEAKER_NAME}).`);
    // eslint-disable-next-line no-control-regex
    if (name && /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, `Name for "${label}" contains control characters.`);
    out.set(label, name);
  }
  return out;
}

export function getSpeakerNames(db: Db, transcriptId: string): Record<string, string> {
  const rows = db.prepare("SELECT label, name FROM speaker_names WHERE transcript_id = ? ORDER BY label").all(transcriptId.toLowerCase()) as {
    label: string;
    name: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.label, r.name]));
}

/**
 * Applies changes; bumps transcripts.updated_at if any name changed → existing summary shows as stale (it used the
 * old names). Returns the full map, or null if the transcript doesn't exist.
 */
export function setSpeakerNames(db: Db, transcriptId: string, changes: Map<string, string | null>, now: number): Record<string, string> | null {
  const id = transcriptId.toLowerCase();
  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM transcripts WHERE id = ?").get(id)) return null;
    const before = getSpeakerNames(db, id);
    const del = db.prepare("DELETE FROM speaker_names WHERE transcript_id = ? AND label = ?");
    const put = db.prepare(
      `INSERT INTO speaker_names (transcript_id, label, name, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (transcript_id, label) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    );
    let changed = false;
    for (const [label, name] of changes) {
      if ((before[label] ?? null) === name) continue;
      changed = true;
      if (name === null) del.run(id, label);
      else put.run(id, label, name, now);
    }
    if (changed) db.prepare("UPDATE transcripts SET updated_at = max(updated_at + 1, ?) WHERE id = ?").run(now, id);
    return getSpeakerNames(db, id);
  })();
}

/** Segments with labels replaced by names (pure). Unnamed labels stay as they are. */
export function applySpeakerNames<T extends Pick<TranscriptUpload, "segments">>(t: T, names: Record<string, string>): T {
  if (!Object.keys(names).length) return t;
  // hasOwn: a label like "constructor" must not pick up Object.prototype.
  const named = (l: string | null): l is string => l !== null && Object.hasOwn(names, l);
  return { ...t, segments: t.segments.map((s) => (named(s.speaker) ? { ...s, speaker: names[s.speaker] } : s)) };
}
