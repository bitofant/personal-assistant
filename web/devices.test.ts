import { describe, expect, it } from "vitest";
import type { DeviceInfo } from "../shared/api.js";
import { deviceActivityLine, revokeConfirmText } from "./devices.js";

const dev = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id: "d1", name: "Work Mac", status: "active", createdAt: "2026-09-30T08:00:00.000Z", approvedAt: "2026-09-30T08:01:00.000Z",
  lastUsedAt: null, lastUploadAt: null, transcriptCount: 0, expiresAt: null, ...over,
});

describe("devices page text", () => {
  it("activity line: counts pluralized, missing times = —", () => {
    expect(deviceActivityLine(dev(), "UTC")).toBe("0 transcripts · last upload — · paired 2026-09-30 08:01 · last seen —");
    expect(deviceActivityLine(dev({ transcriptCount: 1, lastUploadAt: "2026-10-01T09:30:00.000Z" }), "UTC")).toMatch(/^1 transcript · last upload 2026-10-01 09:30 ·/);
  });

  it("revoke confirm: names the device, says uploaded transcripts stay and queued ones wait for re-pair", () => {
    const t = revokeConfirmText(dev({ transcriptCount: 12 }));
    expect(t).toContain('Revoke "Work Mac"?');
    expect(t).toContain("The 12 transcripts it uploaded stay here");
    expect(t).toMatch(/upload queue.*pa pair/s);
    expect(revokeConfirmText(dev({ transcriptCount: 1 }))).toContain("The 1 transcript it uploaded stays");
  });
});
