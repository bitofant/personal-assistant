import { describe, expect, it } from "vitest";
import { parseSearchHash, parseTranscriptHash, searchHash, transcriptHash } from "./routes.js";

describe("hash routes", () => {
  it("search round-trips any query (quotes, #, /, &, unicode)", () => {
    for (const q of [`bob "q4 roadmap"`, "a#b/c&d=e", "café ?", ""]) expect(parseSearchHash(searchHash(q))).toBe(q);
    expect(parseSearchHash("#/search")).toBe("");
    expect(parseSearchHash("#/searchx")).toBeNull();
    expect(parseSearchHash("#/")).toBeNull();
  });

  it("transcript with optional segment", () => {
    expect(parseTranscriptHash(transcriptHash("abc"))).toEqual({ id: "abc", seg: null });
    expect(parseTranscriptHash(transcriptHash("abc", 12))).toEqual({ id: "abc", seg: 12 });
    expect(parseTranscriptHash("#/t/abc/s/x")).toBeNull();
    expect(parseTranscriptHash("#/t/%E0")).toBeNull();
    expect(parseTranscriptHash("#/devices")).toBeNull();
  });
});
