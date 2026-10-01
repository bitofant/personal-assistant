import type { ExportedTranscript, UserExport } from "../shared/api.js";
import type { User } from "./auth.js";
import { purgeUserFromBackups } from "./backup.js";
import type { Store } from "./db.js";
import type { Devices } from "./devices.js";
import { listInstructions } from "./instructions.js";
import { getSummaryLlm } from "./settings.js";
import { getAutoSpeakers, getSpeakerNames } from "./speakers.js";
import { getSpeakerEmbeddings } from "./speakerMatch.js";
import { getSummary } from "./summaries.js";
import { deviceUploadStats, getTranscript, listTranscripts } from "./transcripts.js";

// Per-user export + delete. Per-user DB file = export/delete by construction; app.db holds only account, sessions,
// devices, jobs (FK-cascaded from users).

export function exportUser(store: Store, devices: Devices, user: User, now: number): UserExport {
  const db = store.user(user.id);
  const names = devices.names(user.id);
  const transcripts: ExportedTranscript[] = listTranscripts(db, names).flatMap((item) => {
    const t = getTranscript(db, item.id, names);
    if (!t) return [];
    const { deviceId: _deviceId, deviceName, receivedAt, updatedAt, ...transcript } = t;
    const emb = getSpeakerEmbeddings(db, t.id);
    const speakerEmbeddings = Object.fromEntries([...(emb?.vectors ?? [])].map(([l, v]) => [l, Array.from(v)]));
    return [
      {
        transcript,
        deviceName,
        receivedAt,
        updatedAt,
        speakerNames: getSpeakerNames(db, t.id),
        autoSpeakers: getAutoSpeakers(db, t.id),
        speakerEmbeddings,
        summary: getSummary(db, t.id),
      },
    ];
  });
  return {
    format: "personal-assistant-export/1",
    exportedAt: new Date(now).toISOString(),
    username: user.username,
    transcripts,
    instructions: listInstructions(db),
    settings: { summaryLlm: getSummaryLlm(db) },
    devices: devices.list(user, deviceUploadStats(db)),
  };
}

/** Download name; username is [a-z0-9._-] (USERNAME_RE) → safe in a Content-Disposition header as-is. */
export function exportFileName(username: string, now: number): string {
  return `personal-assistant-${username}-${new Date(now).toISOString().slice(0, 10)}.json`;
}

/**
 * Account row (→ sessions, devices, jobs by cascade), user DB file, and every backup copy. Order: row first so
 * nothing can authenticate as the user while files go. Returns backup snapshots purged.
 */
export function deleteAccount(store: Store, user: User, backupDir: string): string[] {
  store.app.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  store.deleteUserDb(user.id);
  return purgeUserFromBackups(backupDir, user.id);
}
