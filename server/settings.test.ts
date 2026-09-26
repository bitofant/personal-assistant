import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate, USER_MIGRATIONS } from "./db.js";
import { effectiveChoice, getSummaryLlm, parseRouteChoice, setSummaryLlm, toRouteRef } from "./settings.js";

const choices = [
  { provider: "local", model: "m", isDefault: true },
  { provider: "paid", model: "big", isDefault: false },
];

describe("route choice", () => {
  it("toRouteRef keeps only provider/model strings", () => {
    expect(toRouteRef({ provider: "a", model: "b", x: 1 })).toEqual({ provider: "a", model: "b" });
    expect(toRouteRef({ provider: "a" })).toBeNull();
    expect(toRouteRef("a/b")).toBeNull();
  });

  it("parseRouteChoice: null = default; must be a configured choice", () => {
    expect(parseRouteChoice(null, choices)).toBeNull();
    expect(parseRouteChoice(undefined, choices)).toBeNull();
    expect(parseRouteChoice({ provider: "paid", model: "big" }, choices)).toEqual({ provider: "paid", model: "big" });
    expect(() => parseRouteChoice({ provider: "paid", model: "other" }, choices)).toThrow(/configured/);
    expect(() => parseRouteChoice("paid", choices)).toThrow(/configured/);
  });

  it("effectiveChoice drops a pick no longer in config", () => {
    expect(effectiveChoice({ provider: "paid", model: "big" }, choices)).toEqual({ provider: "paid", model: "big" });
    expect(effectiveChoice({ provider: "gone", model: "x" }, choices)).toBeNull();
    expect(effectiveChoice(null, choices)).toBeNull();
  });

  it("stored per user DB; null clears", () => {
    const db = new Database(":memory:");
    migrate(db, USER_MIGRATIONS);
    expect(getSummaryLlm(db)).toBeNull();
    setSummaryLlm(db, { provider: "paid", model: "big" });
    expect(getSummaryLlm(db)).toEqual({ provider: "paid", model: "big" });
    setSummaryLlm(db, null);
    expect(getSummaryLlm(db)).toBeNull();
  });
});
