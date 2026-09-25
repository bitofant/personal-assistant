import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { APP_MIGRATIONS, migrate, USER_MIGRATIONS } from "./db.js";

describe("migrate", () => {
  it("applies pending steps once and records user_version", () => {
    const db = new Database(":memory:");
    migrate(db, ["CREATE TABLE a (x)"]);
    migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (y)"]); // re-running step 0 would throw
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  });

  it("rolls back a failing step atomically", () => {
    const db = new Database(":memory:");
    expect(() => migrate(db, ["CREATE TABLE a (x); CREATE TABLE a (x)"])).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM sqlite_master").get()).toEqual({ n: 0 });
  });

  it("refuses a DB newer than the code", () => {
    const db = new Database(":memory:");
    db.pragma("user_version = 5");
    expect(() => migrate(db, ["CREATE TABLE a (x)"])).toThrow(/newer than this code/);
  });

  it("shipped migrations apply cleanly", () => {
    for (const m of [APP_MIGRATIONS, USER_MIGRATIONS]) {
      const db = new Database(":memory:");
      migrate(db, m);
      expect(db.pragma("user_version", { simple: true })).toBe(m.length);
    }
  });
});
