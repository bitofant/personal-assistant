import type { LiveSegment, LiveStatus, LiveStream, LiveTranscriptResponse } from "../shared/api.js";

/** Mic chunks can arrive after system chunks covering later audio → always re-sort by start (stable). */
export function mergeLive(prev: LiveSegment[], incoming: LiveSegment[]): LiveSegment[] {
  if (!incoming.length) return prev;
  return [...prev, ...incoming].map((s, i) => ({ s, i })).sort((a, b) => a.s.start - b.s.start || a.i - b.i).map((x) => x.s);
}

/** One rendered line: consecutive same-stream segments ≤ `maxGap` s apart (a chunk boundary isn't a speaker turn). */
export interface LiveLine {
  start: number;
  end: number;
  stream: LiveStream;
  speaker: string | null;
  text: string;
}

export function liveLines(segments: LiveSegment[], maxGap = 1.5): LiveLine[] {
  const out: LiveLine[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.stream === s.stream && last.speaker === s.speaker && s.start - last.end <= maxGap) {
      last.text += ` ${s.text}`;
      last.end = Math.max(last.end, s.end);
    } else out.push({ start: s.start, end: s.end, stream: s.stream, speaker: s.speaker, text: s.text });
  }
  return out;
}

export const LIVE_POLL_MS = 2000;
/** No chunk for this long while "live" → probably paused/offline (chunks come every few s while anyone talks). */
export const LIVE_QUIET_MS = 60_000;

/** 404 this soon after opening = recording just started, first chunk not in yet (menu bar link) → keep waiting. */
export const LIVE_START_GRACE_MS = 30_000;
export const waitForFirstChunk = (openedAt: number, now: number) => now - openedAt < LIVE_START_GRACE_MS;

export interface LiveView {
  message: string;
  tone: "info" | "warn";
  /** null = stop polling (final → caller loads the real transcript). */
  pollMs: number | null;
}

export function liveStatusView(r: Pick<LiveTranscriptResponse, "status" | "lastChunkAt">, now: number): LiveView {
  if (r.status === "final") return { message: "Final transcript ready.", tone: "info", pollMs: null };
  const status: LiveStatus = r.status;
  if (status === "ended")
    return { message: "Recording stopped. The final transcript (with speakers) is being made on the Mac; this page switches to it when it arrives.", tone: "info", pollMs: LIVE_POLL_MS * 2 };
  const quiet = r.lastChunkAt !== null && now - Date.parse(r.lastChunkAt) > LIVE_QUIET_MS;
  return quiet
    ? { message: "Recording, but nothing new for a while (silence, or the Mac is offline).", tone: "warn", pollMs: LIVE_POLL_MS }
    : { message: "Recording — live preview, a few seconds behind. Others aren't told apart until the final transcript.", tone: "info", pollMs: LIVE_POLL_MS };
}

/** Follow the bottom unless the user scrolled up to read (within `slack` px of the end = following). */
export const isFollowing = (scrollTop: number, clientHeight: number, scrollHeight: number, slack = 80) => scrollHeight - (scrollTop + clientHeight) <= slack;
