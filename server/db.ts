import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export type Db = Database.Database;

/** Apply migrations[user_version..] in one transaction each. Append-only: never edit a shipped step. */
export function migrate(db: Db, migrations: readonly string[]): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > migrations.length)
    throw new Error(`DB schema v${current} is newer than this code (v${migrations.length}).`);
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function openDb(path: string, migrations: readonly string[]): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, migrations);
  return db;
}

// Shared DB: accounts, sessions, devices. Never user content.
export const APP_MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
    pairing_code TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    approved_at INTEGER,
    last_used_at INTEGER
  );
  CREATE INDEX devices_user ON devices(user_id);
  `,
  // Jobs in app.db so one worker can scan all users; payload = refs only (ids), never content.
  `
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    key TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    generation INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    run_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, type, key)
  );
  CREATE INDEX jobs_due ON jobs(status, run_at);
  `,
  // Last accepted transcript upload (incl. unchanged retries); last_used_at also counts status polls.
  `
  ALTER TABLE devices ADD COLUMN last_upload_at INTEGER;
  `,
] as const;

// Per-user DB: all of one user's content. Isolation by file, not by WHERE user_id.
export const USER_MIGRATIONS = [
  `
  CREATE TABLE transcripts (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    title TEXT,
    calendar_name TEXT,
    event_id TEXT,
    series_id TEXT,
    attendee_count INTEGER,
    segment_count INTEGER NOT NULL,
    raw TEXT NOT NULL,
    data TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX transcripts_started ON transcripts(started_at);
  CREATE INDEX transcripts_series ON transcripts(series_id);
  `,
  // One current summary per transcript; derived, regenerable from raw.
  `
  CREATE TABLE summaries (
    transcript_id TEXT PRIMARY KEY REFERENCES transcripts(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    meeting_type TEXT NOT NULL,
    instructions_source TEXT NOT NULL,
    instructions TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    transcript_updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // Custom summary instructions (resolution: series > type > default > built-in) + per-user settings.
  `
  CREATE TABLE instructions (
    scope TEXT NOT NULL CHECK (scope IN ('default', 'type', 'series')),
    key TEXT NOT NULL,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, key)
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  ALTER TABLE summaries ADD COLUMN meeting_type_source TEXT;
  `,
  // Keyword search: one row per segment + one meta row (title, attendees) per transcript, kept in sync from
  // transcripts.data by triggers (no code path can forget to reindex), backfilled here.
  // External-content FTS5 so reindexing deletes by indexed transcript_id, not an FTS full scan.
  `
  CREATE TABLE search_rows (
    id INTEGER PRIMARY KEY,
    transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    seg INTEGER,
    start REAL,
    speaker TEXT,
    title TEXT,
    attendees TEXT,
    text TEXT
  );
  CREATE INDEX search_rows_transcript ON search_rows(transcript_id);
  CREATE VIRTUAL TABLE search_fts USING fts5(
    title, attendees, text,
    content = 'search_rows', content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER search_rows_ai AFTER INSERT ON search_rows BEGIN
    INSERT INTO search_fts (rowid, title, attendees, text) VALUES (new.id, new.title, new.attendees, new.text);
  END;
  CREATE TRIGGER search_rows_ad AFTER DELETE ON search_rows BEGIN
    INSERT INTO search_fts (search_fts, rowid, title, attendees, text) VALUES ('delete', old.id, old.title, old.attendees, old.text);
  END;
  CREATE TRIGGER transcripts_search_ai AFTER INSERT ON transcripts BEGIN
    ${indexTranscriptSql("new", "")}
  END;
  CREATE TRIGGER transcripts_search_au AFTER UPDATE OF data, title ON transcripts
  WHEN old.data IS NOT new.data OR old.title IS NOT new.title BEGIN
    DELETE FROM search_rows WHERE transcript_id = old.id;
    ${indexTranscriptSql("new", "")}
  END;
  ${indexTranscriptSql("t", "FROM transcripts t")}
  `,
  // Long transcripts: number of transcript parts summarized separately then combined (1 = one call; NULL = older row).
  `
  ALTER TABLE summaries ADD COLUMN parts INTEGER;
  `,
  // Deleted transcript ids (no content): a device retry / re-upload must not resurrect a deletion.
  `
  CREATE TABLE deleted_transcripts (
    id TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
  );
  `,
  // User-given names for diarization labels, per transcript. Kept apart from transcripts.data (= what the device sent).
  `
  CREATE TABLE speaker_names (
    transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    name TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (transcript_id, label)
  );
  `,
  // Long-summary notes calls (parts/merges) done so far, keyed by sha256(route + prompt): a job retried after an
  // outage resumes instead of redoing every part. Cleared when the summary is saved.
  `
  CREATE TABLE summary_calls (
    transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (transcript_id, key)
  );
  `,
  // LLM speaker-name proposals. Separate from speaker_names: suggestions are never applied without the user.
  `
  CREATE TABLE speaker_suggestions (
    transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    name TEXT NOT NULL,
    evidence TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (transcript_id, label)
  );
  `,
  // Auto speaker names (voice/calendar match at upload) live in speaker_names, marked so a user name always wins and
  // only user names serve as voiceprints. Embeddings = per-label float32 vectors from the device's diarizer.
  `
  ALTER TABLE speaker_names ADD COLUMN source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'auto'));
  ALTER TABLE speaker_names ADD COLUMN reason TEXT;
  ALTER TABLE speaker_names ADD COLUMN score REAL;
  CREATE TABLE speaker_embeddings (
    transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    model TEXT NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (transcript_id, label)
  );
  CREATE INDEX speaker_embeddings_model ON speaker_embeddings(model);
  `,
  // Live preview while recording. Apart from `transcripts`: no summary/search/speaker matching on partial text.
  // Deleted when the final transcript arrives; live_chunks = idempotency per (stream, seq), even for empty chunks.
  `
  CREATE TABLE live_transcripts (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    meeting TEXT,
    ended INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_chunk_at INTEGER NOT NULL
  );
  CREATE TABLE live_chunks (
    transcript_id TEXT NOT NULL REFERENCES live_transcripts(id) ON DELETE CASCADE,
    stream TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (transcript_id, stream, seq)
  );
  CREATE TABLE live_segments (
    id INTEGER PRIMARY KEY,
    transcript_id TEXT NOT NULL REFERENCES live_transcripts(id) ON DELETE CASCADE,
    stream TEXT NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    speaker TEXT,
    text TEXT NOT NULL
  );
  CREATE INDEX live_segments_transcript ON live_segments(transcript_id, id);
  `,
] as const;

// Part of shipped migration 4 (append-only): changing what's indexed = new migration that drops + rebuilds.
// `t` = transcript row ref ("new" in triggers); `from` = FROM clause for backfill ("" in triggers).
// Speaker labels deliberately not indexed: diarization labels ("Speaker 2") would match everywhere.
function indexTranscriptSql(t: string, from: string): string {
  const people = `(SELECT group_concat(trim(coalesce(json_extract(p.v, '$.name'), '') || ' ' || coalesce(json_extract(p.v, '$.email'), '')), ' ; ')
      FROM (SELECT json_extract(${t}.data, '$.meeting.organizer') AS v
            UNION ALL SELECT value FROM json_each(${t}.data, '$.meeting.attendees')) p
      WHERE p.v IS NOT NULL)`;
  const segFrom = from ? `${from}, json_each(${t}.data, '$.segments') s` : `FROM json_each(${t}.data, '$.segments') s`;
  return `
    INSERT INTO search_rows (transcript_id, title, attendees)
      SELECT id, title, attendees FROM (SELECT ${t}.id AS id, ${t}.title AS title, ${people} AS attendees ${from})
      WHERE title IS NOT NULL OR attendees IS NOT NULL;
    INSERT INTO search_rows (transcript_id, seg, start, speaker, text)
      SELECT ${t}.id, s.key, json_extract(s.value, '$.start'), json_extract(s.value, '$.speaker'), json_extract(s.value, '$.text')
      ${segFrom};`;
}

/** Opens data/app.db and lazily caches data/users/<id>.db handles. */
export class Store {
  readonly app: Db;
  private readonly userDbs = new Map<number, Db>();
  /** Deleted accounts: a job/request in flight must not recreate their DB file. */
  private readonly deleted = new Set<number>();

  constructor(private readonly dataDir: string) {
    mkdirSync(join(dataDir, "users"), { recursive: true });
    this.app = openDb(join(dataDir, "app.db"), APP_MIGRATIONS);
  }

  user(userId: number): Db {
    // Integer id only: the path is never built from user input.
    if (!Number.isSafeInteger(userId) || userId < 1) throw new Error(`bad user id ${userId}`);
    if (this.deleted.has(userId)) throw new Error(`user ${userId} was deleted`);
    let db = this.userDbs.get(userId);
    if (!db) {
      db = openDb(join(this.dataDir, "users", `${userId}.db`), USER_MIGRATIONS);
      this.userDbs.set(userId, db);
    }
    return db;
  }

  /** Closes + deletes the user's DB file (and WAL/SHM). Caller deletes the app.db row. */
  deleteUserDb(userId: number): void {
    this.deleted.add(userId);
    this.userDbs.get(userId)?.close();
    this.userDbs.delete(userId);
    const base = join(this.dataDir, "users", `${userId}.db`);
    for (const f of [base, `${base}-wal`, `${base}-shm`]) rmSync(f, { force: true });
  }

  /** SQLite may hand a deleted account's id to a new signup (rowid reuse): fresh account, fresh DB. */
  userCreated(userId: number): void {
    this.deleted.delete(userId);
  }

  close(): void {
    for (const db of this.userDbs.values()) db.close();
    this.userDbs.clear();
    this.app.close();
  }
}
