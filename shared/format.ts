// Single formatting source for UI + logs. Missing values render as "—", never 0.

export const MISSING = "—";

/** Seconds → "m:ss" or "h:mm:ss". */
export function formatOffset(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return MISSING;
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Duration between two ISO timestamps, e.g. "1h 05m", "31m". */
export function formatDuration(startIso: string | null | undefined, endIso: string | null | undefined): string {
  if (!startIso || !endIso) return MISSING;
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return MISSING;
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : `${min}m`;
}

/** Local date+time, e.g. "2026-09-24 09:00". `timeZone` for deterministic tests. */
export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return MISSING;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function formatValue(v: string | number | null | undefined): string {
  return v == null || v === "" ? MISSING : String(v);
}
