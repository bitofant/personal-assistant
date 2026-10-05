import { describe, expect, it } from "vitest";
import type { LiveSegment } from "../shared/api.js";
import { isFollowing, LIVE_POLL_MS, LIVE_START_GRACE_MS, liveLines, liveStatusView, mergeLive, waitForFirstChunk } from "./liveState.js";

const seg = (stream: "mic" | "system", start: number, text: string, end = start + 1): LiveSegment => ({
  stream,
  start,
  end,
  speaker: stream === "mic" ? "Alice" : "Others",
  text,
});

describe("mergeLive", () => {
  it("late mic chunk lands in time order; equal starts keep arrival order", () => {
    const prev = [seg("system", 1, "a"), seg("system", 6, "c")];
    expect(mergeLive(prev, [seg("mic", 3, "b"), seg("mic", 6, "d")]).map((s) => s.text)).toEqual(["a", "b", "c", "d"]);
    expect(mergeLive(prev, [])).toBe(prev);
  });
});

describe("liveLines", () => {
  it("joins chunk-split runs of one stream; splits on stream change or pause", () => {
    const lines = liveLines([seg("system", 0, "shall we", 1), seg("system", 1.5, "start?", 2), seg("mic", 2.2, "yes"), seg("system", 3.5, "ok", 4), seg("system", 6, "later")]);
    expect(lines.map((l) => [l.stream, l.text, l.start])).toEqual([
      ["system", "shall we start?", 0],
      ["mic", "yes", 2.2],
      ["system", "ok", 3.5],
      ["system", "later", 6],
    ]);
  });
});

describe("liveStatusView", () => {
  const now = Date.parse("2026-10-01T10:00:00Z");
  it("live polls; quiet warns; ended polls slower; final stops", () => {
    expect(liveStatusView({ status: "live", lastChunkAt: "2026-10-01T09:59:58Z" }, now)).toMatchObject({ tone: "info", pollMs: LIVE_POLL_MS });
    expect(liveStatusView({ status: "live", lastChunkAt: "2026-10-01T09:58:00Z" }, now)).toMatchObject({ tone: "warn", pollMs: LIVE_POLL_MS });
    expect(liveStatusView({ status: "ended", lastChunkAt: "2026-10-01T09:58:00Z" }, now).pollMs).toBeGreaterThan(LIVE_POLL_MS);
    expect(liveStatusView({ status: "final", lastChunkAt: null }, now).pollMs).toBeNull();
  });
});

describe("isFollowing", () => {
  it("near the bottom = following; scrolled up = not", () => {
    expect(isFollowing(900, 100, 1000)).toBe(true);
    expect(isFollowing(850, 100, 1000)).toBe(true);
    expect(isFollowing(500, 100, 1000)).toBe(false);
  });
});

describe("waitForFirstChunk", () => {
  it("keeps waiting on 404 only right after opening", () => {
    expect(waitForFirstChunk(1000, 1000)).toBe(true);
    expect(waitForFirstChunk(1000, 1000 + LIVE_START_GRACE_MS - 1)).toBe(true);
    expect(waitForFirstChunk(1000, 1000 + LIVE_START_GRACE_MS)).toBe(false);
  });
});
