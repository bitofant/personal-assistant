import { useEffect, useState, type FormEvent } from "react";
import type { SearchResponse, TextPart } from "../shared/api.js";
import { formatDateTime, formatDuration, formatOffset, formatValue } from "../shared/format.js";
import { api } from "./api.js";
import { searchHash, transcriptHash } from "./routes.js";
import { ErrorLine, muted } from "./ui.js";

/** Nav search box: submitting navigates to the search page (query lives in the URL). */
export function SearchBox({ initial }: { initial: string }) {
  const [q, setQ] = useState(initial);
  useEffect(() => setQ(initial), [initial]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) location.hash = searchHash(q.trim());
  };
  return (
    <form onSubmit={submit} role="search">
      <input type="search" aria-label="Search transcripts" placeholder='Search (words, "phrases")' value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

export function Search({ q }: { q: string }) {
  const [state, setState] = useState<{ q: string; r: SearchResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (!q.trim()) return;
    let live = true;
    api<SearchResponse>(`/search?q=${encodeURIComponent(q)}`).then(
      (r) => live && setState({ q, r }),
      (e: Error) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [q]);

  if (!q.trim()) return <p>Type words or "quoted phrases" to search titles, attendees and what was said.</p>;
  if (error) return <ErrorLine error={error} />;
  if (!state || state.q !== q) return <p>Searching…</p>;
  const { results, truncated } = state.r;
  if (!results.length) return <p>No transcripts match “{q}”.</p>;
  return (
    <section>
      <p style={muted}>
        {results.length}
        {truncated && "+"} matching transcript{results.length === 1 && !truncated ? "" : "s"}
        {truncated && " (showing the best matches)"}
      </p>
      {results.map(({ transcript: t, metaMatch, segmentMatchCount, segments }) => (
        <article key={t.id} style={{ borderBottom: "1px solid #eee", padding: "0.5rem 0" }}>
          <div>
            <a href={transcriptHash(t.id)}>
              <strong>{t.title ?? "(ad-hoc call)"}</strong>
            </a>{" "}
            <span style={muted}>
              {formatDateTime(t.startedAt)} · {formatDuration(t.startedAt, t.endedAt)}
              {t.attendeeCount !== null && ` · ${t.attendeeCount} attendees`}
              {metaMatch && " · title/attendees match"}
              {segmentMatchCount > segments.length && ` · ${segmentMatchCount} matching lines`}
            </span>
          </div>
          {segments.map((s) => (
            <p key={s.index} style={{ margin: "0.25rem 0 0 1rem" }}>
              <a href={transcriptHash(t.id, s.index)} style={{ color: "#888", fontVariantNumeric: "tabular-nums" }}>
                {formatOffset(s.start)}
              </a>{" "}
              <strong>{formatValue(s.speaker)}:</strong> <Highlighted parts={s.parts} />
            </p>
          ))}
        </article>
      ))}
    </section>
  );
}

/** Text nodes only (never HTML): segment text is untrusted speech. */
export function Highlighted({ parts }: { parts: TextPart[] }) {
  return <>{parts.map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}
