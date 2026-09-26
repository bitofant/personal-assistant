import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { backupData, planPrune, snapshotName } from "./backup.js";
import { Store } from "./db.js";
import { parseTranscriptUpload, upsertTranscript } from "./transcripts.js";

describe("snapshotName", () => {
  it("UTC, sortable", () => {
    expect(snapshotName(Date.UTC(2026, 8, 26, 3, 30, 5, 123))).toBe("20260926-033005Z");
  });
});

describe("planPrune", () => {
  it("keeps the newest N, drops leftover partials, ignores anything else", () => {
    const entries = ["20260901-000000Z", "20260903-000000Z", "20260902-000000Z", "20260904-000000Z.partial", "notes.txt", "x.partial"];
    expect(planPrune(entries, 2)).toEqual(["20260904-000000Z.partial", "20260901-000000Z"]);
    expect(planPrune(entries, 5)).toEqual(["20260904-000000Z.partial"]);
  });
});

describe("backupData", () => {
  it("snapshots app.db + every user db while the server has them open (WAL included), then prunes", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-backup-"));
    const data = join(root, "data");
    const dir = join(root, "backups");
    const store = new Store(data);
    try {
      store.app.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'alice', 'x', 0), (2, 'bob', 'x', 0)").run();
      const t = parseTranscriptUpload(JSON.parse(readFileSync("shared/fixtures/transcript-upload.json", "utf8")));
      upsertTranscript(store.user(1), "dev", t, "{}", 1000); // uncheckpointed: lives in the -wal file
      store.user(2);

      mkdirSync(join(dir, "20200101-000000Z.partial"), { recursive: true }); // crashed earlier run
      writeFileSync(join(dir, "README"), "mine");
      const r1 = backupData(data, { dir, keep: 2 }, Date.UTC(2026, 8, 1));
      expect(r1).toEqual({ snapshot: "20260901-000000Z", files: ["app.db", "users/1.db", "users/2.db"], removed: ["20200101-000000Z.partial"] });

      const copy = new Database(join(dir, r1.snapshot, "users", "1.db"), { readonly: true });
      expect(copy.prepare("SELECT id FROM transcripts").all()).toEqual([{ id: t.id }]);
      expect(copy.pragma("user_version", { simple: true })).toBe(store.user(1).pragma("user_version", { simple: true }));
      copy.close();

      backupData(data, { dir, keep: 2 }, Date.UTC(2026, 8, 2));
      const r3 = backupData(data, { dir, keep: 2 }, Date.UTC(2026, 8, 3));
      expect(r3.removed).toEqual(["20260901-000000Z"]);
      expect(readdirSync(dir).sort()).toEqual(["20260902-000000Z", "20260903-000000Z", "README"]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no app.db = error, nothing written", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-backup-"));
    try {
      expect(() => backupData(join(root, "data"), { dir: join(root, "b"), keep: 1 }, 0)).toThrow(/no app.db/);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
