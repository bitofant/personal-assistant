import { describe, expect, it } from "vitest";
import { displaySpeaker, nameSuggestions, speakerEdits, speakerLabels, suggestionFor, suggestJobView, matchFor, matchReason } from "./speakers.js";

const seg = (speaker: string | null) => ({ start: 0, end: 1, speaker, text: "x" });

describe("speaker helpers", () => {
  it("displaySpeaker: name if set, else label; prototype keys ignored", () => {
    expect(displaySpeaker("Speaker 1", { "Speaker 1": "Bob" })).toBe("Bob");
    expect(displaySpeaker("Speaker 2", { "Speaker 1": "Bob" })).toBe("Speaker 2");
    expect(displaySpeaker("constructor", {})).toBe("constructor");
    expect(displaySpeaker(null, { "Speaker 1": "Bob" })).toBeNull();
  });

  it("speakerLabels: first-appearance order, no null", () => {
    expect(speakerLabels({ segments: [seg("B"), seg(null), seg("A"), seg("B")] })).toEqual(["B", "A"]);
  });

  it("nameSuggestions: organizer + attendees with a name, deduped", () => {
    const meeting = {
      calendarName: null, eventId: null, seriesId: null, title: null, start: "", end: "",
      organizer: { name: "Alice", email: "a@x" },
      attendees: [{ name: "Alice", email: "a@x" }, { name: null, email: "c@x" }, { name: "Bob", email: null }],
    };
    expect(nameSuggestions({ meeting })).toEqual(["Alice", "Bob"]);
    expect(nameSuggestions({ meeting: null })).toEqual([]);
  });

  it("speakerEdits: only changes; blank removes; unchanged/untouched omitted", () => {
    const names = { "Speaker 1": "Bob" };
    expect(speakerEdits(names, { "Speaker 1": " Bob ", "Speaker 2": "" })).toEqual({});
    expect(speakerEdits(names, { "Speaker 1": "", "Speaker 2": " Carol " })).toEqual({ "Speaker 1": null, "Speaker 2": "Carol" });
  });
});

describe("speaker suggestions (web)", () => {
  const sugg = { "Speaker 1": { name: "Bob", evidence: "hi Bob" } };
  it("suggestionFor: only unnamed labels, hidden once typed", () => {
    expect(suggestionFor("Speaker 1", {}, "", sugg)).toEqual(sugg["Speaker 1"]);
    expect(suggestionFor("Speaker 1", {}, " Bob ", sugg)).toBeNull();
    expect(suggestionFor("Speaker 1", { "Speaker 1": "Carol" }, "Carol", sugg)).toBeNull(); // user label wins
    expect(suggestionFor("Speaker 2", {}, "", sugg)).toBeNull();
    expect(suggestionFor("constructor", {}, "", sugg)).toBeNull();
  });

  it("suggestJobView: progress, backoff, failure, empty result", () => {
    const job = (status: "queued" | "running" | "done" | "failed", lastError: string | null = null) => ({ status, attempts: 1, lastError, nextAttemptAt: status === "queued" ? "2026-10-01T10:00:00.000Z" : null });
    expect(suggestJobView(null, 0)).toMatchObject({ message: null, inProgress: false, pollMs: null });
    expect(suggestJobView(job("queued"), 0)).toMatchObject({ inProgress: true, pollMs: 2000 });
    expect(suggestJobView(job("running"), 0)).toMatchObject({ inProgress: true, pollMs: 2000 });
    expect(suggestJobView(job("queued", "LLM down"), 0, "UTC")).toMatchObject({ tone: "warn", inProgress: true, pollMs: 15000, message: expect.stringContaining("LLM down") });
    expect(suggestJobView(job("failed", "boom"), 0)).toMatchObject({ tone: "error", inProgress: false, message: expect.stringContaining("boom") });
    expect(suggestJobView(job("done"), 0).message).toMatch(/No names found/);
    expect(suggestJobView(job("done"), 2).message).toBeNull();
  });
});

describe("voice/calendar matches", () => {
  const voice = { name: "Bob", reason: "voice" as const, score: 0.8234 };
  const cal = { name: "Carol", reason: "calendar" as const, score: null };
  it("reason text", () => {
    expect(matchReason(voice)).toBe("voice match 0.82");
    expect(matchReason(cal)).toBe("only invitee left");
  });
  it("offered only for unnamed labels, not when typed in or same as the LLM suggestion", () => {
    const matches = { "Speaker 1": voice, "Speaker 2": cal };
    expect(matchFor("Speaker 1", {}, "", matches, null)).toEqual(voice);
    expect(matchFor("Speaker 1", { "Speaker 1": "Bob" }, "Bob", matches, null)).toBeNull();
    expect(matchFor("Speaker 1", {}, " Bob ", matches, null)).toBeNull();
    expect(matchFor("Speaker 1", {}, "", matches, { name: "Bob", evidence: null })).toBeNull();
    expect(matchFor("Speaker 2", {}, "", matches, { name: "Dan", evidence: null })).toEqual(cal);
    expect(matchFor("constructor", {}, "", matches, null)).toBeNull();
  });
});
