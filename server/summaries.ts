import type { LlmRouteRef, MeetingType, MeetingTypeSource, Person, TranscriptSegment, TranscriptSummary, TranscriptUpload } from "../shared/api.js";
import { formatDuration, formatOffset } from "../shared/format.js";
import { applicableInstructions, MEETING_TYPES, resolveInstructions, type ResolvedInstructions } from "../shared/instructions.js";
import type { Db, Store } from "./db.js";
import { listInstructions } from "./instructions.js";
import { isRetryable, type JobHandler } from "./jobs.js";
import { MIN_CONTEXT_TOKENS } from "./config.js";
import { LlmError, type ChatMessage, type ChatResult, type Llm } from "./llm.js";
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

/**
 * Rule > series type (earlier occurrence, see seriesMeetingType) > LLM. Outage (retryable) propagates so the job waits;
 * bad/unusable reply → "meeting".
 */
export async function classifyMeeting(
  t: TranscriptUpload,
  llm: Llm,
  opts: { route?: LlmRouteRef | null; signal?: AbortSignal; seriesType?: MeetingType | null } = {},
): Promise<Classification> {
  const rule = classifyByRule(t);
  if (rule) return { type: rule, source: "rule" };
  if (opts.seriesType) return { type: opts.seriesType, source: "series" };
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
  return formatSegments(t.segments);
}

export function formatSegments(segments: readonly TranscriptSegment[]): string {
  const lines: string[] = [];
  let prev: { speaker: string; start: number; text: string[] } | null = null;
  const flush = () => prev && lines.push(`[${formatOffset(prev.start)}] ${prev.speaker}: ${prev.text.join(" ")}`);
  for (const s of segments) {
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

// ---- long transcripts: parts → notes → (merge rounds) → one summary ----

/** Conservative chars/token: gemma tokenizer measured ~3.8 on Dutch prose, ~2.1 on JSON (verified live). */
export const CHARS_PER_TOKEN = 3;
export const estimateTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN);
/** Window assumed after an overflow on a route without `contextTokens`: fits any current chat model. */
export const FALLBACK_CONTEXT_TOKENS = 16384;
/** Merge rounds before giving up (each round roughly halves the notes; 4 = ~16× the parts that fit one call). */
export const MAX_MERGE_ROUNDS = 4;
/** "[1:02:05] Speaker name: " + newline, per segment (merging same-speaker runs only makes it smaller). */
const LINE_OVERHEAD = 40;

/** Room for the reply (no max_tokens sent): summaries/notes rarely pass 2k tokens. */
export function replyReserve(contextTokens: number): number {
  return Math.min(8192, Math.floor(contextTokens / 4));
}

export function fitsInOneCall(messages: ChatMessage[], contextTokens: number): boolean {
  return estimateTokens(messages.map((m) => m.content).join("\n")) + replyReserve(contextTokens) <= contextTokens;
}

/** Transcript/notes chars per call so prompt (`overhead` + input) + reply fit. Floor keeps chunking finite if instructions are huge. */
export function inputBudgetChars(contextTokens: number, overhead: ChatMessage[]): number {
  const free = contextTokens - replyReserve(contextTokens) - estimateTokens(overhead.map((m) => m.content).join("\n"));
  return Math.max(1000, free * CHARS_PER_TOKEN);
}

/** Consecutive segments, each chunk ≤ maxChars formatted; an oversize segment is split at word boundaries. */
export function chunkSegments(segments: readonly TranscriptSegment[], maxChars: number): TranscriptSegment[][] {
  const chunks: TranscriptSegment[][] = [];
  let cur: TranscriptSegment[] = [];
  let size = 0;
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    for (const piece of splitWords(text, Math.max(100, maxChars - LINE_OVERHEAD))) {
      const cost = piece.length + LINE_OVERHEAD;
      if (cur.length && size + cost > maxChars) {
        chunks.push(cur);
        cur = [];
        size = 0;
      }
      cur.push({ ...s, text: piece });
      size += cost;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Pieces ≤ max chars at spaces; a word longer than max is cut. */
function splitWords(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    for (let i = 0; i < word.length; i += max) {
      const w = word.slice(i, i + max);
      if (cur && cur.length + 1 + w.length > max) {
        out.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Notes on parts `from..to` (0-based, inclusive) of `total`, covering [start, end] seconds. */
export interface PartNotes {
  from: number;
  to: number;
  total: number;
  start: number;
  end: number;
  text: string;
}

export function partLabel(n: Omit<PartNotes, "text">): string {
  const which = n.from === n.to ? `Part ${n.from + 1}` : `Parts ${n.from + 1}–${n.to + 1}`;
  return `${which} of ${n.total} (${formatOffset(n.start)}–${formatOffset(n.end)})`;
}

const NOTES_RULES = `Write in the language of the transcript. Only state what was said; never invent names, numbers or decisions. Transcripts are machine-made: speaker labels may be wrong or generic ("Speaker 2"), and words may be misheard. Output Markdown bullet points with [m:ss] timestamps covering: topics discussed, decisions, action items (owner and due date if said), open questions, and notable facts, numbers and names. No introduction or conclusion.`;

const forFinal = (i: ResolvedInstructions) => `The final summary follows these instructions, so capture everything it will need:\n${i.text}`;
const formatNotes = (notes: readonly PartNotes[]) => notes.map((n) => `### ${partLabel(n)}\n${n.text}`).join("\n\n");

/** Map step: notes on one part of the transcript. */
export function buildPartPrompt(t: TranscriptUpload, instructions: ResolvedInstructions, part: readonly TranscriptSegment[], index: number, total: number): ChatMessage[] {
  const range = part.length ? ` (${formatOffset(part[0].start)}–${formatOffset(part[part.length - 1].end)})` : "";
  return [
    { role: "system", content: `You take notes on one part of a long meeting; a later step combines the notes of all parts into the final summary.\n${NOTES_RULES}\n\n${forFinal(instructions)}` },
    { role: "user", content: `${metadataLines(t).join("\n")}\n\nTranscript part ${index + 1} of ${total}${range}:\n${formatSegments(part)}` },
  ];
}

/** Intermediate reduce: consecutive notes → one set of notes (only when all notes don't fit the final call). */
export function buildMergeNotesPrompt(t: TranscriptUpload, instructions: ResolvedInstructions, notes: readonly PartNotes[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You merge notes taken on consecutive parts of one meeting into one set of notes in the same format; a later step turns them into the final summary.\n${NOTES_RULES} Keep every decision, action item and open question; drop repetition.\n\n${forFinal(instructions)}`,
    },
    { role: "user", content: `${metadataLines(t).join("\n")}\n\n${formatNotes(notes)}` },
  ];
}

/** Final reduce: same system prompt as a one-call summary, but fed part notes instead of the transcript. */
export function buildCombinePrompt(t: TranscriptUpload, instructions: ResolvedInstructions, notes: readonly PartNotes[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You write meeting summaries.\n${COMMON}\n\n${instructions.text}\n\nThe meeting was too long to read at once: instead of the transcript you get notes taken on its consecutive parts, in order. Write one summary of the whole meeting from them.`,
    },
    { role: "user", content: `${metadataLines(t).join("\n")}\n\nNotes per part:\n\n${formatNotes(notes)}` },
  ];
}

/** Consecutive groups ≤ maxChars; always shrinks (pairs up if no two neighbours fit together). */
export function groupNotes(notes: readonly PartNotes[], maxChars: number): PartNotes[][] {
  const cost = (n: PartNotes) => partLabel(n).length + n.text.length + 6;
  const groups: PartNotes[][] = [];
  let cur: PartNotes[] = [];
  let size = 0;
  for (const n of notes) {
    if (cur.length && size + cost(n) > maxChars) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(n);
    size += cost(n);
  }
  if (cur.length) groups.push(cur);
  if (groups.length < notes.length || notes.length < 2) return groups;
  const pairs: PartNotes[][] = [];
  for (let i = 0; i < notes.length; i += 2) pairs.push(notes.slice(i, i + 2));
  return pairs;
}

type Usage = ChatResult["usage"];
/** Missing ≠ zero: unknown on any call → unknown total. */
export function addUsage(a: Usage, b: Usage): Usage {
  const add = (x: number | null, y: number | null) => (x === null || y === null ? null : x + y);
  return { promptTokens: add(a.promptTokens, b.promptTokens), completionTokens: add(a.completionTokens, b.completionTokens) };
}

export interface SummaryResult {
  text: string;
  provider: string;
  model: string;
  usage: Usage;
  parts: number;
}

const overflowed = (err: unknown) => err instanceof LlmError && err.contextOverflow;

/**
 * One call if it fits (or the window is unknown); else, or on a context-overflow reply, summarize in parts:
 * notes per part → merge neighbours until they fit → one combined summary. Outages propagate (job waits, restarts from scratch).
 */
export async function summarizeTranscript(
  t: TranscriptUpload,
  instructions: ResolvedInstructions,
  llm: Llm,
  opts: { route?: LlmRouteRef | null; signal?: AbortSignal; contextTokens: number | null },
): Promise<SummaryResult> {
  let usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let last: ChatResult | undefined;
  const chat = async (messages: ChatMessage[]) => {
    last = await llm.chat("summary", messages, { temperature: 0.2, signal: opts.signal, route: opts.route });
    usage = addUsage(usage, last.usage);
    return parseSummaryReply(last);
  };
  const result = (text: string, parts: number): SummaryResult => ({ text, provider: last!.provider, model: last!.model, usage, parts });

  let ctx = opts.contextTokens;
  const single = buildSummaryPrompt(t, instructions);
  if (ctx === null || fitsInOneCall(single, ctx)) {
    try {
      return result(await chat(single), 1);
    } catch (err) {
      if (!overflowed(err)) throw err;
      // Window unknown, or configured/estimated too high: assume a smaller one.
      ctx = ctx === null ? FALLBACK_CONTEXT_TOKENS : smallerWindow(ctx);
    }
  }
  // Overflow in parts = window still overestimated → halve and redo (overflow replies are instant 400s, verified live).
  for (;;) {
    try {
      return await summarizeInParts(ctx);
    } catch (err) {
      if (!overflowed(err)) throw err;
      if (ctx <= MIN_CONTEXT_TOKENS) throw new Error(`summary: too long for ${last?.provider ?? "the model"} even in ${MIN_CONTEXT_TOKENS}-token parts; check llm.tasks.summary contextTokens in config.json`);
      ctx = smallerWindow(ctx);
    }
  }

  async function summarizeInParts(ctx: number): Promise<SummaryResult> {
    const chunks = chunkSegments(t.segments, inputBudgetChars(ctx, buildPartPrompt(t, instructions, [], 0, 1)));
    let notes: PartNotes[] = [];
    for (const [i, part] of chunks.entries()) {
      const text = await chat(buildPartPrompt(t, instructions, part, i, chunks.length));
      notes.push({ from: i, to: i, total: chunks.length, start: part[0].start, end: part[part.length - 1].end, text });
    }
    for (let round = 0; ; round++) {
      const combine = buildCombinePrompt(t, instructions, notes);
      if (notes.length === 1 || fitsInOneCall(combine, ctx)) return result(await chat(combine), chunks.length);
      if (round === MAX_MERGE_ROUNDS) throw new Error(`summary: notes of ${chunks.length} parts still too long after ${round} merge rounds`);
      const merged: PartNotes[] = [];
      for (const g of groupNotes(notes, inputBudgetChars(ctx, buildMergeNotesPrompt(t, instructions, [])))) {
        if (g.length === 1) merged.push(g[0]);
        else merged.push({ from: g[0].from, to: g[g.length - 1].to, total: chunks.length, start: g[0].start, end: g[g.length - 1].end, text: await chat(buildMergeNotesPrompt(t, instructions, g)) });
      }
      notes = merged;
    }
  }
}

const smallerWindow = (ctx: number) => Math.max(MIN_CONTEXT_TOKENS, Math.floor(ctx / 2));

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
  /** 1 = one call; >1 = summarized in parts. */
  parts: number;
  /** transcripts.updated_at of the version summarized (stale detection). */
  transcriptUpdatedAt: number;
}

export function saveSummary(db: Db, s: SummaryRecord, now: number): void {
  db.prepare(
    `INSERT INTO summaries (transcript_id, text, meeting_type, meeting_type_source, instructions_source, instructions, provider, model,
       prompt_tokens, completion_tokens, parts, transcript_updated_at, created_at)
     SELECT @transcriptId, @text, @meetingType, @meetingTypeSource, @source, @instructions, @provider, @model,
       @promptTokens, @completionTokens, @parts, @transcriptUpdatedAt, @now
     -- Transcript deleted while the LLM ran → save nothing (not an FK error that fails the job).
     WHERE EXISTS (SELECT 1 FROM transcripts WHERE id = @transcriptId)
     ON CONFLICT (transcript_id) DO UPDATE SET text = excluded.text, meeting_type = excluded.meeting_type,
       meeting_type_source = excluded.meeting_type_source,
       instructions_source = excluded.instructions_source, instructions = excluded.instructions,
       provider = excluded.provider, model = excluded.model, prompt_tokens = excluded.prompt_tokens,
       completion_tokens = excluded.completion_tokens, parts = excluded.parts, transcript_updated_at = excluded.transcript_updated_at,
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
    parts: s.parts,
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
    | { text: string; meeting_type: MeetingType; meeting_type_source: MeetingTypeSource | null; instructions_source: string; provider: string; model: string; parts: number | null; transcript_updated_at: number; current_updated_at: number; created_at: number }
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
    parts: r.parts,
  };
}

/**
 * Type of the latest other summarized occurrence of a recurring series → consistent type (+ instructions) across the
 * series, no classify call. Skips fallback/unknown-source rows so one bad guess isn't copied forward.
 */
export function seriesMeetingType(db: Db, seriesId: string | null, excludeTranscriptId: string): MeetingType | null {
  if (!seriesId) return null;
  const r = db
    .prepare(
      `SELECT s.meeting_type FROM summaries s JOIN transcripts t ON t.id = s.transcript_id
       WHERE t.series_id = ? AND t.id != ? AND s.meeting_type_source IN ('rule', 'series', 'llm')
       ORDER BY t.started_at DESC LIMIT 1`,
    )
    .get(seriesId, excludeTranscriptId.toLowerCase()) as { meeting_type: MeetingType } | undefined;
  return r?.meeting_type ?? null;
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
    const seriesId = t.upload.meeting?.seriesId ?? null;
    const seriesType = seriesMeetingType(db, seriesId, t.upload.id);
    const { type: meetingType, source: meetingTypeSource } = await classifyMeeting(t.upload, deps.llm, { route, signal, seriesType });
    const instructions = resolveInstructions(meetingType, seriesId, applicableInstructions(listInstructions(db), meetingType, seriesId));
    const r = await summarizeTranscript(t.upload, instructions, deps.llm, { route, signal, contextTokens: deps.llm.contextTokens("summary", route) });
    saveSummary(
      db,
      {
        transcriptId: t.upload.id,
        text: r.text,
        meetingType,
        meetingTypeSource,
        instructions,
        provider: r.provider,
        model: r.model,
        usage: r.usage,
        parts: r.parts,
        transcriptUpdatedAt: t.updatedAt,
      },
      deps.now(),
    );
  };
}
