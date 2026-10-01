import type { DeviceInfo } from "../shared/api.js";
import { formatDateTime } from "../shared/format.js";

// Pure text for the Devices page (unit-tested). Revoke wording must match the Mac's upload queue: a 401 halts it,
// queued files stay on disk, it resumes by itself once re-paired + approved.

/** Split around the command so the page can render it as code. */
export const REVOKE_HELP = {
  before:
    "Revoking signs a Mac out at once. Transcripts it already uploaded stay in your account. The Mac keeps recording, and transcripts it hasn't sent yet wait in its upload queue: nothing is lost, but nothing reaches this account until you run ",
  command: "pa pair",
  after: " on that Mac again and approve it here. Then the queue uploads by itself.",
};

export function revokeConfirmText(d: Pick<DeviceInfo, "name" | "transcriptCount">): string {
  const uploaded = d.transcriptCount === 1 ? "The 1 transcript it uploaded stays" : `The ${d.transcriptCount} transcripts it uploaded stay`;
  return [
    `Revoke "${d.name}"?`,
    `It is signed out immediately. ${uploaded} here, shown without a device name.`,
    `Recordings and transcripts still waiting on that Mac stay in its upload queue. They upload once you run "pa pair" on it and approve it here again.`,
  ].join("\n\n");
}

export function deviceActivityLine(d: DeviceInfo, timeZone?: string): string {
  const n = d.transcriptCount === 1 ? "1 transcript" : `${d.transcriptCount} transcripts`;
  return `${n} · last upload ${formatDateTime(d.lastUploadAt, timeZone)} · paired ${formatDateTime(d.approvedAt, timeZone)} · last seen ${formatDateTime(d.lastUsedAt, timeZone)}`;
}
