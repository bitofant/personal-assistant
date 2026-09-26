import type { MeetingType, Person, TranscriptSummary, TranscriptUpload } from "../shared/api.js";
import { formatDuration, formatOffset } from "../shared/format.js";
import type { Db, Store } from "./db.js";
import type { JobHandler } from "./jobs.js";
import type { ChatMessage, ChatResult, Llm } from "./llm.js";

export const SUMMARIZE_JOB = "summarize";

// ---- pure ----

/** Rule only for now; LLM classify fallback is planned. */
export function classifyMeeting(t: TranscriptUpload): MeetingType {
  if (!t.meeting) return "adhoc";
  return t.meeting.attendees.length === 2 ? "1on1" : "meeting";
}

const COMMON = `Write in the language of the transcript. Use Markdown. Be concise and factual: only state what was said, never invent names, numbers or decisions. Omit a section when there is nothing for it. Transcripts are machine-made: speaker labels may be wrong or generic ("Speaker 2"), and words may be misheard.`;

export const BUILTIN_INSTRUCTIONS: Record<MeetingType, string> = {
  meeting: `Summarize this meeting.
Sections: "## Summary" (3-7 bullets), "## Decisions", "## Action items" (bullets "Owner: task", owner "?" if unclear), "## Open questions".`,
  "1on1": `Summarize this 1:1 meeting between two people.
Sections: "## Summary" (3-7 bullets), "## Feedback" (given or received), "## Action items" (bullets "Owner: task", owner "?" if unclear), "## Follow up next time".`,
  adhoc: `Summarize this unscheduled call (no calendar event, participants may be unknown).
Sections: "## Summary" (3-7 bullets), "## Action items" (bullets "Owner: task", owner "?" if unclear).`,
};

export interface ResolvedInstructions {
  /** Most specific wins: series > type > default. Only built-ins exist so far. */
  source: string;
  text: string;
}

export function resolveInstructions(type: MeetingType): ResolvedInstructions {
  return { source: `builtin:${type}`, text: BUILTIN_INSTRUCTIONS[type] };
}

function formatPerson(p: Person): string {
  return p.name && p.email ? `${p.name} <${p.email}>` : (p.name ?? p.email ?? "?");
}

/** "[m:ss] Speaker: text", consecutive same-speaker segments merged (fewer tokens, same content). */
export function formatTranscriptLines(t: TranscriptUpload): string {
  const lines: string[] = [];
  let prev: { speaker: string; start: number; text: string[] } | null = null;
  const flush = () => prev && lines.push(`[${formatOffset(prev.start)}] ${prev.speaker}: ${prev.text.join(" ")}`);
  for (const s of t.segments) {
    const speaker = s.speaker ?? "Unknown speaker";
    const text = s.text.trim();
    if (!text) continue;
    if (prev && prev.speaker === speaker) prev.text.push(text);
    else {
      flush();
      prev = { speaker, start: s.start, text: [text] };
    }
  }
  flush();
  return lines.join("\n");
}

export function buildSummaryPrompt(t: TranscriptUpload, instructions: ResolvedInstructions): ChatMessage[] {
  const m = t.meeting;
  const header = [
    `Title: ${m?.title ?? "(none: unscheduled call)"}`,
    `Recorded: ${t.startedAt} to ${t.endedAt} (${formatDuration(t.startedAt, t.endedAt)})`,
    m?.organizer ? `Organizer: ${formatPerson(m.organizer)}` : null,
    m ? `Attendees: ${m.attendees.length ? m.attendees.map(formatPerson).join(", ") : "(none listed)"}` : null,
  ].filter((l) => l !== null);
  return [
    { role: "system", content: `You write meeting summaries.\n${COMMON}\n\n${instructions.text}` },
    { role: "user", content: `${header.join("\n")}\n\nTranscript:\n${formatTranscriptLines(t) || "(empty)"}` },
  ];
}

/** Non-retryable errors: same prompt would fail the same way. */
export function parseSummaryReply(r: ChatResult): string {
  if (r.finishReason === "length") throw new Error(`summary cut off (finish_reason=length) by ${r.provider}/${r.model}`);
  // Some models wrap the whole answer in a ```markdown fence.
  const text = r.text.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/, "$1").trim();
  if (!text) throw new Error(`empty summary from ${r.provider}/${r.model}`);
  return text;
}

// ---- storage (per-user DB) ----

export interface SummaryRecord {
  transcriptId: string;
  text: string;
  meetingType: MeetingType;
  instructions: ResolvedInstructions;
  provider: string;
  model: string;
  usage: ChatResult["usage"];
  /** transcripts.updated_at of the version summarized (stale detection). */
  transcriptUpdatedAt: number;
}

export function saveSummary(db: Db, s: SummaryRecord, now: number): void {
  db.prepare(
    `INSERT INTO summaries (transcript_id, text, meeting_type, instructions_source, instructions, provider, model,
       prompt_tokens, completion_tokens, transcript_updated_at, created_at)
     VALUES (@transcriptId, @text, @meetingType, @source, @instructions, @provider, @model,
       @promptTokens, @completionTokens, @transcriptUpdatedAt, @now)
     ON CONFLICT (transcript_id) DO UPDATE SET text = excluded.text, meeting_type = excluded.meeting_type,
       instructions_source = excluded.instructions_source, instructions = excluded.instructions,
       provider = excluded.provider, model = excluded.model, prompt_tokens = excluded.prompt_tokens,
       completion_tokens = excluded.completion_tokens, transcript_updated_at = excluded.transcript_updated_at,
       created_at = excluded.created_at`,
  ).run({
    transcriptId: s.transcriptId,
    text: s.text,
    meetingType: s.meetingType,
    source: s.instructions.source,
    instructions: s.instructions.text,
    provider: s.provider,
    model: s.model,
    promptTokens: s.usage.promptTokens,
    completionTokens: s.usage.completionTokens,
    transcriptUpdatedAt: s.transcriptUpdatedAt,
    now,
  });
}

export function getSummary(db: Db, transcriptId: string): TranscriptSummary | null {
  const r = db
    .prepare(
      `SELECT s.*, t.updated_at AS current_updated_at FROM summaries s JOIN transcripts t ON t.id = s.transcript_id
       WHERE s.transcript_id = ?`,
    )
    .get(transcriptId.toLowerCase()) as
    | { text: string; meeting_type: MeetingType; instructions_source: string; provider: string; model: string; transcript_updated_at: number; current_updated_at: number; created_at: number }
    | undefined;
  if (!r) return null;
  return {
    text: r.text,
    meetingType: r.meeting_type,
    instructionsSource: r.instructions_source,
    provider: r.provider,
    model: r.model,
    createdAt: new Date(r.created_at).toISOString(),
    stale: r.current_updated_at > r.transcript_updated_at,
  };
}

function loadTranscript(db: Db, id: string): { upload: TranscriptUpload; updatedAt: number } | null {
  const r = db.prepare("SELECT data, updated_at FROM transcripts WHERE id = ?").get(id) as { data: string; updated_at: number } | undefined;
  return r ? { upload: JSON.parse(r.data) as TranscriptUpload, updatedAt: r.updated_at } : null;
}

// ---- job ----

/** Job key = transcript id. Missing transcript = nothing to do (done). LLM outage = retryable (queue waits). */
export function summarizeHandler(deps: { store: Store; llm: Llm; now: () => number }): JobHandler {
  return async (job, signal) => {
    const db = deps.store.user(job.userId);
    const t = loadTranscript(db, job.key);
    if (!t) return;
    const meetingType = classifyMeeting(t.upload);
    const instructions = resolveInstructions(meetingType);
    const r = await deps.llm.chat("summary", buildSummaryPrompt(t.upload, instructions), { temperature: 0.2, signal });
    saveSummary(
      db,
      {
        transcriptId: t.upload.id,
        text: parseSummaryReply(r),
        meetingType,
        instructions,
        provider: r.provider,
        model: r.model,
        usage: r.usage,
        transcriptUpdatedAt: t.updatedAt,
      },
      deps.now(),
    );
  };
}
