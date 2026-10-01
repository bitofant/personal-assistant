import type { TranscriptDetail } from "../shared/api.js";

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
