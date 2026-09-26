// `npm run backup`: consistent snapshot of data/app.db + data/users/*.db, then prune. Run by a systemd user timer.
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";

const SNAPSHOT_RE = /^\d{8}-\d{6}Z$/;
const PARTIAL_SUFFIX = ".partial";

// ---- pure ----

/** UTC stamp: sorts lexically = chronologically, no DST collisions. */
export function snapshotName(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d+Z$/, "Z");
}

/** Beyond the newest `keep` snapshots + leftover partials (crashed runs) go; unrecognized names are never touched. */
export function planPrune(entries: readonly string[], keep: number): string[] {
  const snapshots = entries.filter((e) => SNAPSHOT_RE.test(e)).sort().reverse();
  const partials = entries.filter((e) => e.endsWith(PARTIAL_SUFFIX) && SNAPSHOT_RE.test(e.slice(0, -PARTIAL_SUFFIX.length)));
  return [...partials, ...snapshots.slice(keep)];
}

/** Paths relative to the data dir: app.db + users/<id>.db (the only files Store creates). */
export function dbFiles(dataDir: string): string[] {
  if (!existsSync(join(dataDir, "app.db"))) throw new Error(`no app.db in ${dataDir}: nothing to back up`);
  const usersDir = join(dataDir, "users");
  const users = existsSync(usersDir) ? readdirSync(usersDir).filter((f) => /^\d+\.db$/.test(f)).sort() : [];
  return ["app.db", ...users.map((f) => join("users", f))];
}

// ---- I/O ----

export interface BackupResult {
  snapshot: string;
  files: string[];
  removed: string[];
}

/**
 * VACUUM INTO = online-safe consistent copy (read transaction; server keeps running, WAL included), compacted.
 * Written to <stamp>.partial, quick_check'ed, then renamed → a listed snapshot is always complete.
 */
export function backupData(dataDir: string, backup: { dir: string; keep: number }, now: number): BackupResult {
  const files = dbFiles(dataDir);
  const snapshot = snapshotName(now);
  const tmp = join(backup.dir, snapshot + PARTIAL_SUFFIX);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "users"), { recursive: true });
  for (const f of files) {
    // Plain open, no migrate(): a backup must never change the schema.
    const src = new Database(join(dataDir, f), { fileMustExist: true });
    try {
      src.pragma("busy_timeout = 5000");
      src.prepare("VACUUM INTO ?").run(join(tmp, f));
    } finally {
      src.close();
    }
    const copy = new Database(join(tmp, f), { readonly: true });
    try {
      const check = copy.pragma("quick_check", { simple: true });
      if (check !== "ok") throw new Error(`backup of ${f} failed quick_check: ${String(check)}`);
    } finally {
      copy.close();
    }
  }
  renameSync(tmp, join(backup.dir, snapshot));
  const removed = planPrune(readdirSync(backup.dir), backup.keep);
  for (const r of removed) rmSync(join(backup.dir, r), { recursive: true, force: true });
  return { snapshot, files, removed };
}

/** `npm run backup` entry (server/backup-main.ts): config.json + ./data from cwd. */
export function runBackup(): string {
  const config = loadConfig();
  const dir = resolve(process.cwd(), config.backup.dir);
  const r = backupData(resolve(process.cwd(), "data"), { dir, keep: config.backup.keep }, Date.now());
  return `backup ${join(dir, r.snapshot)}: ${r.files.length} db file(s)${r.removed.length ? `; pruned ${r.removed.join(", ")}` : ""}`;
}
