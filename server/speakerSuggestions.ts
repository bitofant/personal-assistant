import type { Person, SpeakerSuggestion, TranscriptUpload } from "../shared/api.js";
import { MIN_CONTEXT_TOKENS } from "./config.js";
import type { Db, Store } from "./db.js";
import type { JobHandler } from "./jobs.js";
import { LlmError, type ChatMessage, type Llm } from "./llm.js";
import { getSummaryLlm } from "./settings.js";
import { applySpeakerNames, getSpeakerNames, MAX_SPEAKER_NAME, speakerLabels } from "./speakers.js";
import { chunkSegments, FALLBACK_CONTEXT_TOKENS, formatSegments, inputBudgetChars } from "./summaries.js";

// LLM proposals for diarization labels ("Speaker 2" → "Bob"). Suggestions only: stored apart from speaker_names and
// never applied by the server; the user accepts one in the web UI. Don't let this write speaker_names.

export const SUGGEST_SPEAKERS_JOB = "suggest-speakers";
export const MAX_EVIDENCE = 300;

/** Diarization-style labels (pa: "Speaker N"; others: "S1", "SPEAKER_00"). Others (mic = local user's name) are already names. */
export function isGenericLabel(label: string): boolean {
  return /^(speaker|spk|s)[\s_-]?\d+$/i.test(label.trim());
}

/** Labels worth asking about: generic and not named by the user. */
export function labelsToSuggest(t: Pick<TranscriptUpload, "segments">, names: Record<string, string>): string[] {
  return speakerLabels(t).filter((l) => isGenericLabel(l) && !Object.hasOwn(names, l));
}

const person = (p: Person) => (p.name && p.email ? `${p.name} <${p.email}>` : (p.name ?? p.email ?? "?"));

/**
 * `t` with user names already applied (context for the model). Transcript cut to `maxChars` from the start:
 * introductions + greetings happen early.
 */
export function buildSuggestPrompt(t: TranscriptUpload, labels: readonly string[], maxChars: number): ChatMessage[] {
  const m = t.meeting;
  const chunks = chunkSegments(t.segments, maxChars);
  const cut = chunks.length > 1 ? "\n[… transcript continues; only the start is shown]" : "";
  const people = m ? [m.organizer, ...m.attendees].filter((p): p is Person => p !== null).map(person) : [];
  return [
    {
      role: "system",
      content: [
        "You identify speakers in a machine-made meeting transcript. Generic labels like \"Speaker 2\" come from voice clustering and may be imperfect.",
        "For each label asked about, give the person's name only if the transcript clearly shows it: they introduce themselves, someone addresses them by name and they answer, or they're called on and respond.",
        "If a name matches an invitee, spell it as in the invitee list. Never guess from the invitee list alone. Skip labels you can't identify.",
        'Reply with only a JSON object, no prose: {"<label>": {"name": "<name>", "evidence": "<short quote from the transcript>"}}. Reply {} if none.',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Title: ${m?.title ?? "(none: unscheduled call)"}`,
        m ? `Invitees: ${people.length ? people.join(", ") : "(none listed)"}` : null,
        `Labels to identify: ${labels.map((l) => JSON.stringify(l)).join(", ")}`,
        "",
        `Transcript:\n${(chunks[0] && formatSegments(chunks[0])) || "(empty)"}${cut}`,
      ]
        .filter((l) => l !== null)
        .join("\n"),
    },
  ];
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f]/g;

/**
 * Model reply → label → suggestion. Untrusted (speech can prompt-inject): only asked labels, names held to the same
 * rules as user names (no control chars, ≤100), evidence flattened + capped. Unparseable → null.
 */
export function parseSuggestReply(text: string, labels: readonly string[]): Record<string, SpeakerSuggestion> | null {
  const s = text.trim().replace(/^```\w*\s*|\s*```$/g, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const asked = new Set(labels);
  const out: Record<string, SpeakerSuggestion> = {};
  for (const [label, v] of Object.entries(raw)) {
    if (!asked.has(label)) continue;
    const obj = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
    const rawName = typeof v === "string" ? v : obj?.name;
    if (typeof rawName !== "string") continue;
    const name = rawName.trim();
    if (!name || name.length > MAX_SPEAKER_NAME || CONTROL.test(name) || isGenericLabel(name) || name === label) continue;
    const ev = typeof obj?.evidence === "string" ? obj.evidence.replace(CONTROLS, " ").replace(/\s+/g, " ").trim() : "";
    out[label] = { name, evidence: ev ? (ev.length > MAX_EVIDENCE ? `${ev.slice(0, MAX_EVIDENCE - 1)}…` : ev) : null };
  }
  return out;
}

// ---- storage (per-user DB) ----

export function saveSpeakerSuggestions(db: Db, transcriptId: string, suggestions: Record<string, SpeakerSuggestion>, now: number): void {
  const id = transcriptId.toLowerCase();
  db.transaction(() => {
    db.prepare("DELETE FROM speaker_suggestions WHERE transcript_id = ?").run(id);
    // WHERE EXISTS: transcript deleted while the LLM ran → nothing saved, no FK error.
    const put = db.prepare(
      `INSERT INTO speaker_suggestions (transcript_id, label, name, evidence, created_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM transcripts WHERE id = ?)`,
    );
    for (const [label, s] of Object.entries(suggestions)) put.run(id, label, s.name, s.evidence, now, id);
  })();
}

export function clearSpeakerSuggestions(db: Db, transcriptId: string): void {
  db.prepare("DELETE FROM speaker_suggestions WHERE transcript_id = ?").run(transcriptId.toLowerCase());
}

/** Labels the user has named since are left out: a suggestion never competes with a user label. */
export function getSpeakerSuggestions(db: Db, transcriptId: string): Record<string, SpeakerSuggestion> {
  const id = transcriptId.toLowerCase();
  const rows = db
    .prepare(
      `SELECT label, name, evidence FROM speaker_suggestions s WHERE transcript_id = ?
       AND NOT EXISTS (SELECT 1 FROM speaker_names n WHERE n.transcript_id = s.transcript_id AND n.label = s.label)
       ORDER BY label`,
    )
    .all(id) as { label: string; name: string; evidence: string | null }[];
  return Object.fromEntries(rows.map((r) => [r.label, { name: r.name, evidence: r.evidence }]));
}

// ---- job ----

const overflowed = (err: unknown) => err instanceof LlmError && err.contextOverflow;

/**
 * Job key = transcript id. Same model as summaries (user setting). Missing transcript / nothing to ask = done, no call.
 * Outage = retryable (queue waits). Overflow → halve the excerpt down to the minimum window.
 */
export function suggestSpeakersHandler(deps: { store: Store; llm: Llm; now: () => number }): JobHandler {
  return async (job, signal) => {
    const db = deps.store.user(job.userId);
    const id = job.key.toLowerCase();
    const r = db.prepare("SELECT data FROM transcripts WHERE id = ?").get(id) as { data: string } | undefined;
    if (!r) return;
    const names = getSpeakerNames(db, id);
    const raw = JSON.parse(r.data) as TranscriptUpload;
    const labels = labelsToSuggest(raw, names);
    if (!labels.length) return saveSpeakerSuggestions(db, id, {}, deps.now());
    const t = applySpeakerNames(raw, names);
    const route = getSummaryLlm(db);
    let ctx = deps.llm.contextTokens("summary", route) ?? FALLBACK_CONTEXT_TOKENS;
    for (;;) {
      const prompt = buildSuggestPrompt(t, labels, inputBudgetChars(ctx, buildSuggestPrompt({ ...t, segments: [] }, labels, 1000)));
      try {
        const reply = await deps.llm.chat("summary", prompt, { temperature: 0, route, signal });
        const parsed = parseSuggestReply(reply.text, labels);
        if (!parsed) console.warn(`suggest-speakers ${id}: unparseable reply from ${reply.provider}/${reply.model}; saved none`);
        return saveSpeakerSuggestions(db, id, parsed ?? {}, deps.now());
      } catch (err) {
        if (!overflowed(err) || ctx <= MIN_CONTEXT_TOKENS) throw err;
        ctx = Math.max(MIN_CONTEXT_TOKENS, Math.floor(ctx / 2));
      }
    }
  };
}
