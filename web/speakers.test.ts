import { describe, expect, it } from "vitest";
import { displaySpeaker, nameSuggestions, speakerEdits, speakerLabels } from "./speakers.js";

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
