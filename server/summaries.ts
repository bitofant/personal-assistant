import type { LlmRouteRef, MeetingType, MeetingTypeSource, Person, TranscriptSummary, TranscriptUpload } from "../shared/api.js";
import { formatDuration, formatOffset } from "../shared/format.js";
import { applicableInstructions, MEETING_TYPES, resolveInstructions, type ResolvedInstructions } from "../shared/instructions.js";
import type { Db, Store } from "./db.js";
import { listInstructions } from "./instructions.js";
import { isRetryable, type JobHandler } from "./jobs.js";
import type { ChatMessage, ChatResult, Llm } from "./llm.js";
import { getSummaryLlm, toRouteRef } from "./settings.js";

export const SUMMARIZE_JOB = "summarize";

// ---- pure ----

const TITLE_RULES: [RegExp, MeetingType][] = [
  [/\b1\s*(?::|-|on)\s*1\b|\bone[\s-]on[\s-]one\b/i, "1on1"],
  [/\b(stand[\s-]?up|scrum|daily)\b/i, "standup"],
  // "Interview debrief/prep" = hiring team talking, not an interview.
  [/^(?!.*\b(debrief|prep|calibration)\b).*\binterview/i, "interview"],
];

/** Confident rule, else null (→ LLM classify). Title beats attendee count: a 2-person interview is an interview. */
export function classifyByRule(t: TranscriptUpload): MeetingType | null {
  if (!t.meeting) return "adhoc";
  const title = t.meeting.title ?? "";
  for (const [re, type] of TITLE_RULES) if (re.test(title)) return type;
  return t.meeting.attendees.length === 2 ? "1on1" : null;
}

/** Types the LLM may pick: adhoc is decided by rule (no calendar event). */
export const LLM_MEETING_TYPES = MEETING_TYPES.filter((m) => m.type !== "adhoc");
const CLASSIFY_EXCERPT_CHARS = 4000;

export function buildClassifyPrompt(t: TranscriptUpload): ChatMessage[] {
  const types = LLM_MEETING_TYPES.map((m) => `- ${m.type}: ${m.description}`).join("\n");
  let excerpt = formatTranscriptLines(t);
  if (excerpt.length > CLASSIFY_EXCERPT_CHARS) excerpt = `${excerpt.slice(0, CLASSIFY_EXCERPT_CHARS)}\n[…]`;
  return [
    {
      role: "system",
      content: `You classify meetings. Types:\n${types}\nReply with only the type id, nothing else.`,
    },
    { role: "user", content: `${metadataLines(t).join("\n")}\n\nTranscript start:\n${excerpt || "(empty)"}` },
  ];
}

/** Type id from a bare word, a JSON `{"type":…}`, or a label ("Stand-up"); null = unusable. */
export function parseClassifyReply(text: string): MeetingType | null {
  const s = text.trim().replace(/^```\w*\s*|\s*```$/g, "");
  let v: unknown = s;
  try {
    const j = JSON.parse(s) as unknown;
    if (typeof j === "object" && j !== null && "type" in j) v = (j as { type: unknown }).type;
  } catch {
    // not JSON
  }
  if (typeof v !== "string") return null;
  const word = v.trim().toLowerCase().replace(/^["'`*\s]+|["'`*.\s]+$/g, "");
  const hit = LLM_MEETING_TYPES.find((m) => m.type === word || m.label.toLowerCase() === word);
  return hit?.type ?? null;
}

export interface Classification {
  type: MeetingType;
  source: MeetingTypeSource;
}

/** Rule first; else LLM. Outage (retryable) propagates so the job waits; bad/unusable reply → "meeting". */
export async function classifyMeeting(t: TranscriptUpload, llm: Llm, opts: { route?: LlmRouteRef | null; signal?: AbortSignal } = {}): Promise<Classification> {
  const rule = classifyByRule(t);
  if (rule) return { type: rule, source: "rule" };
  try {
    const r = await llm.chat("summary", buildClassifyPrompt(t), { temperature: 0, route: opts.route, signal: opts.signal });
    const type = parseClassifyReply(r.text);
    return type ? { type, source: "llm" } : { type: "meeting", source: "fallback" };
  } catch (err) {
    if (isRetryable(err)) throw err;
    return { type: "meeting", source: "fallback" };
  }
}

const COMMON = `Write in the language of the transcript. Use Markdown. Be concise and factual: only state what was said, never invent names, numbers or decisions. Omit a section when there is nothing for it. Transcripts are machine-made: speaker labels may be wrong or generic ("Speaker 2"), and words may be misheard.`;

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

function metadataLines(t: TranscriptUpload): string[] {
  const m = t.meeting;
  return [
    `Title: ${m?.title ?? "(none: unscheduled call)"}`,
    `Recorded: ${t.startedAt} to ${t.endedAt} (${formatDuration(t.startedAt, t.endedAt)})`,
    m?.organizer ? `Organizer: ${formatPerson(m.organizer)}` : null,
    m ? `Attendees: ${m.attendees.length ? m.attendees.map(formatPerson).join(", ") : "(none listed)"}` : null,
  ].filter((l) => l !== null);
}

export function buildSummaryPrompt(t: TranscriptUpload, instructions: ResolvedInstructions): ChatMessage[] {
  return [
    { role: "system", content: `You write meeting summaries.\n${COMMON}\n\n${instructions.text}` },
    { role: "user", content: `${metadataLines(t).join("\n")}\n\nTranscript:\n${formatTranscriptLines(t) || "(empty)"}` },
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
  meetingTypeSource: MeetingTypeSource;
  instructions: ResolvedInstructions;
  provider: string;
  model: string;
  usage: ChatResult["usage"];
  /** transcripts.updated_at of the version summarized (stale detection). */
  transcriptUpdatedAt: number;
}

export function saveSummary(db: Db, s: SummaryRecord, now: number): void {
  db.prepare(
    `INSERT INTO summaries (transcript_id, text, meeting_type, meeting_type_source, instructions_source, instructions, provider, model,
       prompt_tokens, completion_tokens, transcript_updated_at, created_at)
     VALUES (@transcriptId, @text, @meetingType, @meetingTypeSource, @source, @instructions, @provider, @model,
       @promptTokens, @completionTokens, @transcriptUpdatedAt, @now)
     ON CONFLICT (transcript_id) DO UPDATE SET text = excluded.text, meeting_type = excluded.meeting_type,
       meeting_type_source = excluded.meeting_type_source,
       instructions_source = excluded.instructions_source, instructions = excluded.instructions,
       provider = excluded.provider, model = excluded.model, prompt_tokens = excluded.prompt_tokens,
       completion_tokens = excluded.completion_tokens, transcript_updated_at = excluded.transcript_updated_at,
       created_at = excluded.created_at`,
  ).run({
    transcriptId: s.transcriptId,
    text: s.text,
    meetingType: s.meetingType,
    meetingTypeSource: s.meetingTypeSource,
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
    | { text: string; meeting_type: MeetingType; meeting_type_source: MeetingTypeSource | null; instructions_source: string; provider: string; model: string; transcript_updated_at: number; current_updated_at: number; created_at: number }
    | undefined;
  if (!r) return null;
  return {
    text: r.text,
    meetingType: r.meeting_type,
    meetingTypeSource: r.meeting_type_source,
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

/** Payload `{llm}` = one-off model pick from the web; else the user's setting. Validated against config in resolveRoute. */
export interface SummarizePayload {
  llm: LlmRouteRef | null;
}

/** Job key = transcript id. Missing transcript = nothing to do (done). LLM outage = retryable (queue waits). */
export function summarizeHandler(deps: { store: Store; llm: Llm; now: () => number }): JobHandler {
  return async (job, signal) => {
    const db = deps.store.user(job.userId);
    const t = loadTranscript(db, job.key);
    if (!t) return;
    const route = toRouteRef((job.payload as Partial<SummarizePayload> | null)?.llm) ?? getSummaryLlm(db);
    const { type: meetingType, source: meetingTypeSource } = await classifyMeeting(t.upload, deps.llm, { route, signal });
    const seriesId = t.upload.meeting?.seriesId ?? null;
    const instructions = resolveInstructions(meetingType, seriesId, applicableInstructions(listInstructions(db), meetingType, seriesId));
    const r = await deps.llm.chat("summary", buildSummaryPrompt(t.upload, instructions), { temperature: 0.2, signal, route });
    saveSummary(
      db,
      {
        transcriptId: t.upload.id,
        text: parseSummaryReply(r),
        meetingType,
        meetingTypeSource,
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
