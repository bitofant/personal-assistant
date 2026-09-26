import { describe, expect, it } from "vitest";
import { emptySearch, hasSearchInput, parseSearchHash, parseTranscriptHash, searchApiPath, searchHash, transcriptHash } from "./routes.js";

describe("hash routes", () => {
  it("search round-trips any query (quotes, #, /, &, unicode) and filters", () => {
    for (const q of [`bob "q4 roadmap"`, "a#b/c&d=e", "café ?", ""]) expect(parseSearchHash(searchHash({ q }))).toEqual({ ...emptySearch, q });
    const full = { q: "plan", from: "2026-09-01", to: "2026-09-30", with: "Zoë, bob@x.com" };
    expect(parseSearchHash(searchHash(full))).toEqual(full);
    expect(searchHash({ q: " a b ", with: "  " })).toBe("#/search?q=a%20b");
    expect(parseSearchHash("#/search")).toEqual(emptySearch);
    expect(parseSearchHash("#/searchx")).toBeNull();
    expect(parseSearchHash("#/")).toBeNull();
  });

  it("hasSearchInput: any non-blank field", () => {
    expect(hasSearchInput(emptySearch)).toBe(false);
    expect(hasSearchInput({ ...emptySearch, q: "  " })).toBe(false);
    expect(hasSearchInput({ ...emptySearch, with: "bob" })).toBe(true);
  });

  it("searchApiPath: local days → [from midnight, day after `to`) instants; one with per comma name", () => {
    const u = new URLSearchParams(searchApiPath({ q: " plan ", from: "2026-09-01", to: "2026-09-30", with: "alice, ,Bob B " }).split("?")[1]);
    expect(u.get("q")).toBe("plan");
    expect(u.get("from")).toBe(new Date(2026, 8, 1).toISOString());
    expect(u.get("to")).toBe(new Date(2026, 9, 1).toISOString()); // `to` day inclusive
    expect(u.getAll("with")).toEqual(["alice", "Bob B"]);
    expect(searchApiPath({ ...emptySearch, q: "x", from: "garbage", to: "2026-9-1" })).toBe("/search?q=x");
  });

  it("transcript with optional segment", () => {
    expect(parseTranscriptHash(transcriptHash("abc"))).toEqual({ id: "abc", seg: null });
    expect(parseTranscriptHash(transcriptHash("abc", 12))).toEqual({ id: "abc", seg: 12 });
    expect(parseTranscriptHash("#/t/abc/s/x")).toBeNull();
    expect(parseTranscriptHash("#/t/%E0")).toBeNull();
    expect(parseTranscriptHash("#/devices")).toBeNull();
  });
});
