import type { JobState, SpeakerSuggestion, TranscriptDetail } from "../shared/api.js";
import { formatDateTime } from "../shared/format.js";
import { POLL_ACTIVE_MS, POLL_WAITING_MS, type SummaryTone } from "./summaryState.js";

// Pure helpers for the transcript page's speaker names (unit-tested).

/** Name for a segment label; hasOwn so a label like "constructor" can't hit Object.prototype. */
export function displaySpeaker(label: string | null, names: Record<string, string>): string | null {
  return label !== null && Object.hasOwn(names, label) ? names[label] : label;
}

/** Labels in first-appearance order. */
export function speakerLabels(t: Pick<TranscriptDetail, "segments">): string[] {
  return [...new Set(t.segments.map((s) => s.speaker).filter((s): s is string => s !== null))];
}

/** Calendar people as name suggestions (organizer first, deduped, names only). */
export function nameSuggestions(t: Pick<TranscriptDetail, "meeting">): string[] {
  const m = t.meeting;
  if (!m) return [];
  const people = [m.organizer, ...m.attendees].flatMap((p) => (p?.name ? [p.name] : []));
  return [...new Set(people)];
}

/** Drafts → PUT body: only labels whose trimmed draft differs from the saved name (blank = null = remove). */
export function speakerEdits(names: Record<string, string>, drafts: Record<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [label, draft] of Object.entries(drafts)) {
    const next = draft.trim() || null;
    const saved = Object.hasOwn(names, label) ? names[label] : null;
    if (next !== saved) out[label] = next;
  }
  return out;
}

/** Suggestion worth offering: label unnamed (server filters too) and not already typed into the input. */
export function suggestionFor(label: string, names: Record<string, string>, value: string, suggestions: Record<string, SpeakerSuggestion>): SpeakerSuggestion | null {
  if (Object.hasOwn(names, label) || !Object.hasOwn(suggestions, label)) return null;
  const s = suggestions[label];
  return s.name === value.trim() ? null : s;
}

export interface SuggestJobView {
  message: string | null;
  tone: SummaryTone;
  inProgress: boolean;
  pollMs: number | null;
}

/** Status line for the "Suggest names" job; same polling cadence as summaries. */
export function suggestJobView(job: JobState | null, suggestionCount: number, timeZone?: string): SuggestJobView {
  if (!job) return { message: null, tone: "info", inProgress: false, pollMs: null };
  switch (job.status) {
    case "running":
      return { message: "Looking for names in the transcript…", tone: "info", inProgress: true, pollMs: POLL_ACTIVE_MS };
    case "queued":
      if (!job.lastError) return { message: "Looking for names: queued…", tone: "info", inProgress: true, pollMs: POLL_ACTIVE_MS };
      return {
        message: `Looking for names: waiting to retry (${job.lastError}). Next attempt ${formatDateTime(job.nextAttemptAt, timeZone)}.`,
        tone: "warn",
        inProgress: true,
        pollMs: POLL_WAITING_MS,
      };
    case "failed":
      return { message: `Name suggestions failed: ${job.lastError ?? "unknown error"}`, tone: "error", inProgress: false, pollMs: null };
    case "done":
      return { message: suggestionCount ? null : "No names found for the unnamed speakers.", tone: "info", inProgress: false, pollMs: null };
  }
}
