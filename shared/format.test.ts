import { describe, expect, it } from "vitest";
import { formatDateTime, formatDuration, formatOffset, formatValue, MISSING } from "./format.js";

describe("format", () => {
  it("formatOffset", () => {
    expect(formatOffset(0)).toBe("0:00");
    expect(formatOffset(75.9)).toBe("1:15");
    expect(formatOffset(3725)).toBe("1:02:05");
    expect(formatOffset(null)).toBe(MISSING);
  });

  it("formatDuration", () => {
    expect(formatDuration("2026-09-24T07:00:00Z", "2026-09-24T07:31:00Z")).toBe("31m");
    expect(formatDuration("2026-09-24T07:00:00Z", "2026-09-24T08:05:00Z")).toBe("1h 05m");
    expect(formatDuration("2026-09-24T08:00:00Z", "2026-09-24T07:00:00Z")).toBe(MISSING);
    expect(formatDuration(null, "2026-09-24T07:00:00Z")).toBe(MISSING);
  });

  it("formatDateTime in a given zone; bad input → missing", () => {
    expect(formatDateTime("2026-09-24T07:00:03Z", "Europe/Brussels")).toBe("2026-09-24 09:00");
    expect(formatDateTime("2026-09-24T23:30:00Z", "UTC")).toBe("2026-09-24 23:30");
    expect(formatDateTime("garbage")).toBe(MISSING);
    expect(formatDateTime(null)).toBe(MISSING);
  });

  it("formatValue: null/empty → missing, 0 stays 0", () => {
    expect(formatValue(null)).toBe(MISSING);
    expect(formatValue("")).toBe(MISSING);
    expect(formatValue(0)).toBe("0");
  });
});
