import type { CustomInstruction, MeetingType } from "./api.js";

// Single source for meeting types, built-in instructions and the resolution order (server prompt + web settings UI).

export interface MeetingTypeInfo {
  type: MeetingType;
  label: string;
  /** Also the LLM classifier's definition of the type. */
  description: string;
}

export const MEETING_TYPES = [
  { type: "1on1", label: "1:1", description: "two people, e.g. manager and report, or peers catching up" },
  { type: "standup", label: "Stand-up", description: "short recurring status round: done, next, blockers" },
  { type: "interview", label: "Interview", description: "hiring interview of a candidate" },
  { type: "external", label: "External", description: "with customers, partners or vendors from outside the organization" },
  { type: "meeting", label: "Meeting", description: "any other scheduled meeting (team, planning, review, …)" },
  { type: "adhoc", label: "Ad-hoc call", description: "unscheduled call without a calendar event" },
] as const satisfies readonly MeetingTypeInfo[];

export const MEETING_TYPE_IDS: readonly MeetingType[] = MEETING_TYPES.map((t) => t.type);

export function isMeetingType(v: unknown): v is MeetingType {
  return typeof v === "string" && (MEETING_TYPE_IDS as readonly string[]).includes(v);
}

const ACTIONS = `"## Action items" (bullets "Owner: task", owner "?" if unclear)`;

export const BUILTIN_INSTRUCTIONS: Record<MeetingType, string> = {
  meeting: `Summarize this meeting.
Sections: "## Summary" (3-7 bullets), "## Decisions", ${ACTIONS}, "## Open questions".`,
  "1on1": `Summarize this 1:1 meeting between two people.
Sections: "## Summary" (3-7 bullets), "## Feedback" (given or received), ${ACTIONS}, "## Follow up next time".`,
  standup: `Summarize this stand-up.
Sections: "## Updates" (one bullet per person: done / next), "## Blockers", ${ACTIONS}.`,
  interview: `Summarize this hiring interview.
Sections: "## Candidate background", "## Topics and answers" (bullets), "## Candidate questions", "## Next steps". Report what was said; do not rate or judge the candidate.`,
  external: `Summarize this meeting with external parties (customers, partners, vendors).
Sections: "## Summary" (3-7 bullets), "## Their needs and concerns", "## Commitments made" (who promised what), ${ACTIONS}, "## Next steps".`,
  adhoc: `Summarize this unscheduled call (no calendar event, participants may be unknown).
Sections: "## Summary" (3-7 bullets), ${ACTIONS}.`,
};

export interface ResolvedInstructions {
  /** "series:<id>" | "type:<type>" | "default" | "builtin:<type>" */
  source: string;
  text: string;
}

/** Custom texts that apply to one transcript; null = not set. */
export interface ApplicableInstructions {
  series: string | null;
  type: string | null;
  default: string | null;
}

/** Most specific wins: series > type > custom default > built-in for the type. */
export function resolveInstructions(type: MeetingType, seriesId: string | null, custom: ApplicableInstructions): ResolvedInstructions {
  if (seriesId && custom.series) return { source: `series:${seriesId}`, text: custom.series };
  if (custom.type) return { source: `type:${type}`, text: custom.type };
  if (custom.default) return { source: "default", text: custom.default };
  return { source: `builtin:${type}`, text: BUILTIN_INSTRUCTIONS[type] };
}

/** Pick the entries that apply to (type, series) out of a user's full list. */
export function applicableInstructions(all: readonly CustomInstruction[], type: MeetingType, seriesId: string | null): ApplicableInstructions {
  const find = (scope: CustomInstruction["scope"], key: string) => all.find((c) => c.scope === scope && c.key === key)?.text ?? null;
  return { series: seriesId ? find("series", seriesId) : null, type: find("type", type), default: find("default", "") };
}

export function meetingTypeLabel(type: MeetingType): string {
  return MEETING_TYPES.find((m) => m.type === type)?.label ?? type;
}

/** Human label for a ResolvedInstructions.source; unknown shapes shown verbatim. */
export function describeInstructionsSource(source: string): string {
  const [kind, rest] = [source.slice(0, source.indexOf(":")), source.slice(source.indexOf(":") + 1)];
  if (source === "default") return "your default instructions";
  if (kind === "series") return "this series' instructions";
  if (kind === "type" && isMeetingType(rest)) return `your ${meetingTypeLabel(rest)} instructions`;
  if (kind === "builtin" && isMeetingType(rest)) return `built-in ${meetingTypeLabel(rest)} instructions`;
  return source;
}
