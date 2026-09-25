import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
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
] as const;

/** Opens data/app.db and lazily caches data/users/<id>.db handles. */
export class Store {
  readonly app: Db;
  private readonly userDbs = new Map<number, Db>();

  constructor(private readonly dataDir: string) {
    mkdirSync(join(dataDir, "users"), { recursive: true });
    this.app = openDb(join(dataDir, "app.db"), APP_MIGRATIONS);
  }

  user(userId: number): Db {
    // Integer id only: the path is never built from user input.
    if (!Number.isSafeInteger(userId) || userId < 1) throw new Error(`bad user id ${userId}`);
    let db = this.userDbs.get(userId);
    if (!db) {
      db = openDb(join(this.dataDir, "users", `${userId}.db`), USER_MIGRATIONS);
      this.userDbs.set(userId, db);
    }
    return db;
  }

  close(): void {
    for (const db of this.userDbs.values()) db.close();
    this.userDbs.clear();
    this.app.close();
  }
}
