import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LiveSegment, LiveTranscriptResponse } from "../shared/api.js";
import { formatDateTime, formatOffset, formatValue, transcriptTitle } from "../shared/format.js";
import { api, ApiError } from "./api.js";
import { isFollowing, liveLines, liveStatusView, mergeLive } from "./liveState.js";
import { ErrorLine } from "./ui.js";

/**
 * Live preview of a meeting still being recorded (no final transcript yet). Polls new segments by cursor; when the
 * final transcript arrives, `onFinal` swaps in the normal detail page. `onMissing` = neither exists (404).
 */
export function LiveTranscript({ id, onFinal, onMissing }: { id: string; onFinal: () => void; onMissing: () => void }) {
  const [head, setHead] = useState<LiveTranscriptResponse | null>(null);
  const [segments, setSegments] = useState<LiveSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const cursor = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  // Decided before new lines render: was the reader at the bottom?
  const follow = useRef(true);
  const view = head && liveStatusView(head, now);
  const path = `/transcripts/${encodeURIComponent(id)}/live`;

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await api<LiveTranscriptResponse>(`${path}?after=${cursor.current}`);
        if (stop) return;
        if (r.status === "final") return onFinal();
        const scroller = end.current?.closest(".content");
        follow.current = !scroller || isFollowing(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight);
        cursor.current = r.cursor;
        setSegments((s) => mergeLive(s, r.segments));
        setHead(r);
        setNow(Date.now());
        setError(null);
        timer = setTimeout(() => void tick(), liveStatusView(r, Date.now()).pollMs ?? 2000);
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiError && e.status === 404) return onMissing();
        // Keep polling through a blip (server restart, Wi-Fi).
        setError((e as Error).message);
        timer = setTimeout(() => void tick(), 5000);
      }
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [path, onFinal, onMissing]);

  // Braces: scrollIntoView may return a Promise in newer Chromium (see AGENTS.md).
  useLayoutEffect(() => {
    if (follow.current) end.current?.scrollIntoView({ block: "end" });
  }, [segments]);

  const lines = useMemo(() => liveLines(segments), [segments]);
  if (!head) return error ? <ErrorLine error={error} /> : <p className="muted">Loading…</p>;
  const m = head.meeting;
  return (
    <article>
      <h2>
        {transcriptTitle(m?.title)} <span className={head.status === "live" ? "badge live-badge" : "badge"}>{head.status === "live" ? "● live" : "processing"}</span>
      </h2>
      <p className="meta">
        {formatDateTime(head.startedAt)} · calendar {formatValue(m?.calendarName)} · device {formatValue(head.deviceName)}
      </p>
      {m && m.attendees.length > 0 && <p className="meta">With {m.attendees.map((a) => a.name ?? a.email).join(", ")}</p>}
      {view && (
        <p role="status" className={view.tone === "warn" ? "warn" : "muted"}>
          {view.message}
        </p>
      )}
      <ErrorLine error={error} />
      <div className="segments live-segments">
        {lines.length === 0 && <p className="muted">Waiting for speech…</p>}
        {lines.map((l) => (
          <p key={`${l.stream}:${l.start}`} className={l.stream === "mic" ? "live-mic" : undefined}>
            <span className="offset">{formatOffset(l.start)}</span> <span className="speaker">{formatValue(l.speaker)}:</span> {l.text}
          </p>
        ))}
        <div ref={end} />
      </div>
    </article>
  );
}
