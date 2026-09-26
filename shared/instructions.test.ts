import { describe, expect, it } from "vitest";
import type { CustomInstruction } from "./api.js";
import { applicableInstructions, BUILTIN_INSTRUCTIONS, describeInstructionsSource, MEETING_TYPE_IDS, resolveInstructions } from "./instructions.js";

const NONE = { series: null, type: null, default: null };
const c = (scope: CustomInstruction["scope"], key: string, text: string): CustomInstruction => ({ scope, key, text, updatedAt: "" });

describe("resolveInstructions", () => {
  it("built-in per type when nothing custom", () => {
    expect(resolveInstructions("1on1", "s1", NONE)).toEqual({ source: "builtin:1on1", text: BUILTIN_INSTRUCTIONS["1on1"] });
  });

  it("series > type > default > built-in", () => {
    const all = { series: "S", type: "T", default: "D" };
    expect(resolveInstructions("meeting", "s1", all)).toEqual({ source: "series:s1", text: "S" });
    expect(resolveInstructions("meeting", null, all)).toEqual({ source: "type:meeting", text: "T" });
    expect(resolveInstructions("meeting", "s1", { ...all, series: null })).toEqual({ source: "type:meeting", text: "T" });
    expect(resolveInstructions("meeting", "s1", { ...NONE, default: "D" })).toEqual({ source: "default", text: "D" });
  });

  it("every type has a built-in", () => {
    for (const t of MEETING_TYPE_IDS) expect(BUILTIN_INSTRUCTIONS[t]).toMatch(/Summarize/);
  });
});

describe("applicableInstructions", () => {
  const all = [c("default", "", "D"), c("type", "1on1", "T1"), c("type", "meeting", "TM"), c("series", "s1", "S1"), c("series", "s2", "S2")];
  it("picks by type and series id (exact)", () => {
    expect(applicableInstructions(all, "1on1", "s2")).toEqual({ series: "S2", type: "T1", default: "D" });
    expect(applicableInstructions(all, "standup", "S1")).toEqual({ series: null, type: null, default: "D" });
    expect(applicableInstructions(all, "meeting", null)).toEqual({ series: null, type: "TM", default: "D" });
  });
});

describe("describeInstructionsSource", () => {
  it("labels every source kind; unknown verbatim", () => {
    expect(describeInstructionsSource("builtin:1on1")).toBe("built-in 1:1 instructions");
    expect(describeInstructionsSource("type:standup")).toBe("your Stand-up instructions");
    expect(describeInstructionsSource("default")).toBe("your default instructions");
    expect(describeInstructionsSource("series:a:b")).toBe("this series' instructions");
    expect(describeInstructionsSource("weird")).toBe("weird");
  });
});
