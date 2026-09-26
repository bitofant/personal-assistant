// Hash routes built/parsed in one place so links and the router can't drift.

/** Search page state as typed: `from`/`to` = local calendar days (YYYY-MM-DD, both inclusive); `with` = comma-separated people. */
export interface SearchParams {
  q: string;
  from: string;
  to: string;
  with: string;
}

export const emptySearch: SearchParams = { q: "", from: "", to: "", with: "" };

const SEARCH_KEYS = ["q", "from", "to", "with"] as const;

export function searchHash(p: Partial<SearchParams>): string {
  const u = new URLSearchParams();
  for (const k of SEARCH_KEYS) if (p[k]?.trim()) u.set(k, p[k].trim());
  return `#/search?${u.toString().replaceAll("+", "%20")}`;
}

/** `#/search?…` → params (missing = ""); null = not the search route. */
export function parseSearchHash(hash: string): SearchParams | null {
  const m = /^#\/search(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  const u = new URLSearchParams(m[1] ?? "");
  return { q: u.get("q") ?? "", from: u.get("from") ?? "", to: u.get("to") ?? "", with: u.get("with") ?? "" };
}

export const hasSearchInput = (p: SearchParams) => SEARCH_KEYS.some((k) => p[k].trim() !== "");

/** Local midnight starting `day` (+ `plus` days) as an instant; null if not YYYY-MM-DD. */
function localDayStart(day: string, plus = 0): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plus).toISOString() : null;
}

/** API path for `GET /api/search`: local days → [from midnight, day-after-to midnight) instants; one `with` per name. */
export function searchApiPath(p: SearchParams): string {
  const u = new URLSearchParams();
  if (p.q.trim()) u.set("q", p.q.trim());
  const from = localDayStart(p.from);
  const to = localDayStart(p.to, 1);
  if (from) u.set("from", from);
  if (to) u.set("to", to);
  for (const name of p.with.split(",")) if (name.trim()) u.append("with", name.trim());
  return `/search?${u}`;
}

/** `seg` = segment index to scroll to. */
export const transcriptHash = (id: string, seg?: number) => `#/t/${encodeURIComponent(id)}${seg === undefined ? "" : `/s/${seg}`}`;

export function parseTranscriptHash(hash: string): { id: string; seg: number | null } | null {
  const m = /^#\/t\/([^/]+)(?:\/s\/(\d+))?$/.exec(hash);
  if (!m) return null;
  try {
    return { id: decodeURIComponent(m[1]), seg: m[2] === undefined ? null : Number(m[2]) };
  } catch {
    return null; // malformed escape
  }
}
