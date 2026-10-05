import { useEffect, useState, type FormEvent } from "react";
import type { SearchResponse, TextPart } from "../shared/api.js";
import { formatDateTime, formatDuration, formatOffset, formatValue, transcriptTitle } from "../shared/format.js";
import { api } from "./api.js";
import { hasSearchInput, searchApiPath, searchHash, transcriptHash, type SearchParams } from "./routes.js";
import { ErrorLine } from "./ui.js";

/** Nav search box: submitting navigates to the search page (query lives in the URL); keeps active filters. */
export function SearchBox({ params }: { params: SearchParams }) {
  const [q, setQ] = useState(params.q);
  useEffect(() => { setQ(params.q); }, [params.q]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = { ...params, q };
    if (hasSearchInput(next)) location.hash = searchHash(next);
  };
  return (
    <form onSubmit={submit} role="search">
      <input type="search" aria-label="Search transcripts" placeholder='Search (words, "phrases")' value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

/** Date range + people; applied via the URL like the query. */
function Filters({ params }: { params: SearchParams }) {
  const [f, setF] = useState(params);
  const set = (k: "from" | "to" | "with") => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const apply = (e: FormEvent) => {
    e.preventDefault();
    location.hash = searchHash({ ...f, q: params.q });
  };
  const active = params.from || params.to || params.with;
  return (
    <form onSubmit={apply} className="filters">
      <label>From <input type="date" value={f.from} onChange={set("from")} /></label>
      <label>To <input type="date" value={f.to} onChange={set("to")} /></label>
      <label>With <input type="text" placeholder="name or email, comma-separated" value={f.with} onChange={set("with")} size={28} /></label>
      <button className="primary" type="submit">Filter</button>
      {active && <a href={searchHash({ q: params.q })}>Clear filters</a>}
    </form>
  );
}

export function Search({ params }: { params: SearchParams }) {
  return (
    <>
      {/* key: remount = reset inputs when the URL's filters change (back/forward, Clear). */}
      <Filters key={[params.from, params.to, params.with].join("\n")} params={params} />
      <Results params={params} />
    </>
  );
}

function Results({ params }: { params: SearchParams }) {
  const path = searchApiPath(params);
  const [state, setState] = useState<{ path: string; r: SearchResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = hasSearchInput(params);
  useEffect(() => {
    setError(null);
    if (!ready) return;
    let live = true;
    api<SearchResponse>(path).then(
      (r) => live && setState({ path, r }),
      (e: Error) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [path, ready]);

  if (!ready) return <p className="empty-state">Type words or "quoted phrases" to search titles, attendees and what was said, or filter by date and people.</p>;
  if (error) return <ErrorLine error={error} />;
  if (!state || state.path !== path) return <p className="muted">Searching…</p>;
  const { results, truncated } = state.r;
  if (!results.length) return <p className="empty-state">No transcripts match{params.q.trim() ? ` “${params.q}”` : " these filters"}.</p>;
  return (
    <section>
      <p className="muted">
        {results.length}
        {truncated && "+"} {params.q.trim() ? "matching " : ""}transcript{results.length === 1 && !truncated ? "" : "s"}
        {truncated && (params.q.trim() ? " (showing the best matches)" : " (showing the newest)")}
      </p>
      {results.map(({ transcript: t, metaMatch, segmentMatchCount, segments }) => (
        <article key={t.id} className="result">
          <div>
            <a href={transcriptHash(t.id)}>
              <strong>{transcriptTitle(t.title, t.kind)}</strong>
            </a>{" "}
            <span className="muted">
              {formatDateTime(t.startedAt)} · {formatDuration(t.startedAt, t.endedAt)}
              {t.attendeeCount !== null && ` · ${t.attendeeCount} attendees`}
              {metaMatch && " · title/attendees match"}
              {segmentMatchCount > segments.length && ` · ${segmentMatchCount} matching lines`}
            </span>
          </div>
          {segments.map((s) => (
            <p key={s.index}>
              <a href={transcriptHash(t.id, s.index)} className="offset">
                {formatOffset(s.start)}
              </a>{" "}
              <span className="speaker">{formatValue(s.speaker)}:</span> <Highlighted parts={s.parts} />
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
