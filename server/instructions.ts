import type { CustomInstruction, InstructionScope, SeriesInfo } from "../shared/api.js";
import { isMeetingType } from "../shared/instructions.js";
import type { Db } from "./db.js";
import { HttpError, isRecord } from "./http.js";

export const MAX_INSTRUCTIONS_CHARS = 20_000;

// ---- pure ----

/** Validate (scope, key) from the URL; canonical key: "" for default, trimmed otherwise. */
export function parseInstructionTarget(scope: string, key: string | undefined): { scope: InstructionScope; key: string } {
  if (scope === "default") {
    if (key !== undefined) throw new HttpError(404, "Unknown instructions path.");
    return { scope, key: "" };
  }
  const k = (key ?? "").trim();
  if (scope === "type") {
    if (!isMeetingType(k)) throw new HttpError(400, `Unknown meeting type "${k}".`);
    return { scope, key: k };
  }
  if (scope === "series") {
    // Series ids are opaque calendar ids (case-sensitive): trim only, same as ingest.
    if (!k || k.length > 500) throw new HttpError(400, "Series id must be 1-500 characters.");
    return { scope, key: k };
  }
  throw new HttpError(404, "Unknown instructions scope.");
}

export function parseInstructionText(body: unknown): string {
  const text = isRecord(body) && typeof body.text === "string" ? body.text.trim() : "";
  if (!text) throw new HttpError(400, "text required (DELETE to fall back to inherited instructions).");
  if (text.length > MAX_INSTRUCTIONS_CHARS) throw new HttpError(400, `text exceeds ${MAX_INSTRUCTIONS_CHARS} characters.`);
  return text;
}

// ---- storage (per-user DB) ----

interface Row {
  scope: InstructionScope;
  key: string;
  text: string;
  updated_at: number;
}

const toApi = (r: Row): CustomInstruction => ({ scope: r.scope, key: r.key, text: r.text, updatedAt: new Date(r.updated_at).toISOString() });

export function listInstructions(db: Db): CustomInstruction[] {
  return (db.prepare("SELECT * FROM instructions ORDER BY scope, key").all() as Row[]).map(toApi);
}

export function putInstruction(db: Db, scope: InstructionScope, key: string, text: string, now: number): CustomInstruction {
  const row = db
    .prepare(
      `INSERT INTO instructions (scope, key, text, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at RETURNING *`,
    )
    .get(scope, key, text, now) as Row;
  return toApi(row);
}

export function deleteInstruction(db: Db, scope: InstructionScope, key: string): void {
  db.prepare("DELETE FROM instructions WHERE scope = ? AND key = ?").run(scope, key);
}

/** Recurring series in the user's transcripts, most recent first; title = latest occurrence's. */
export function listSeries(db: Db): SeriesInfo[] {
  const rows = db
    .prepare(
      `SELECT series_id, COUNT(*) AS count, MAX(started_at) AS last_started_at,
         (SELECT title FROM transcripts t2 WHERE t2.series_id = t.series_id ORDER BY started_at DESC LIMIT 1) AS title
       FROM transcripts t WHERE series_id IS NOT NULL GROUP BY series_id ORDER BY last_started_at DESC`,
    )
    .all() as { series_id: string; count: number; last_started_at: string; title: string | null }[];
  return rows.map((r) => ({ seriesId: r.series_id, title: r.title, count: r.count, lastStartedAt: r.last_started_at }));
}
