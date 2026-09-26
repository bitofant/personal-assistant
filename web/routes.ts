// Hash routes built/parsed in one place so links and the router can't drift.

export const searchHash = (q: string) => `#/search?q=${encodeURIComponent(q)}`;

/** `#/search?q=…` → query ("" for bare `#/search`); null = not the search route. */
export function parseSearchHash(hash: string): string | null {
  const m = /^#\/search(?:\?(.*))?$/.exec(hash);
  return m ? (new URLSearchParams(m[1] ?? "").get("q") ?? "") : null;
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
