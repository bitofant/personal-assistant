import type { Person, SpeakerMatch, TranscriptUpload } from "../shared/api.js";
import type { Db } from "./db.js";
import { getSpeakerNames, isGenericLabel } from "./speakers.js";

// Automatic speaker naming, no LLM: (1) voice = per-label embedding from the Mac's diarizer vs "voiceprints" = labels
// the user named in other transcripts (join of speaker_names source 'user' + speaker_embeddings; nothing to sync);
// (2) calendar = one unnamed speaker left and one invitee unaccounted for. Confident → auto name at upload; else
// offered as a suggestion. User names always win; auto names never become voiceprints (a wrong guess would teach itself).

// Uncalibrated guesses (no real recordings yet): tune once ~10–20 meetings have corrected names.
export const VOICE_AUTO = 0.7;
/** Auto-name someone who isn't on the invite list only above this. */
export const VOICE_STRONG = 0.8;
/** Best person must beat the runner-up by this much for an auto name. */
export const VOICE_MARGIN = 0.1;
export const VOICE_SUGGEST = 0.5;
/** Short clusters give noisy embeddings / may be noise: no auto voice name below this much speech. */
export const MIN_AUTO_TALK_S = 20;
/** Calendar elimination: clusters with less speech don't count as a speaker. */
export const MIN_ELIM_TALK_S = 10;
const MAX_SAMPLES_PER_PERSON = 20;

/** Name identity across spellings: case, accents, punctuation, word order ("Tesse, Joran" = "joran tesse"). */
export function personKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** label → seconds of speech (segment lengths). */
export function talkSeconds(segments: TranscriptUpload["segments"]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of segments) if (s.speaker !== null) out.set(s.speaker, (out.get(s.speaker) ?? 0) + (s.end - s.start));
  return out;
}

/** Unit length; null for a zero/degenerate vector (can't be compared). */
export function normalize(v: ArrayLike<number>): Float32Array | null {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (!(n > 1e-9) || !Number.isFinite(n)) return null;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Cosine of unit vectors; different lengths = not comparable (−1). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

export interface VoiceLabel {
  label: string;
  vector: Float32Array;
  talkSeconds: number;
}

/** One person's voiceprint samples (unit vectors), newest first. */
export interface KnownVoice {
  key: string;
  name: string;
  vectors: Float32Array[];
}

export interface MatchContext {
  /** personKeys of invitees; null = no calendar info (ad-hoc), then anyone may be auto-named. */
  invitees: Set<string> | null;
  /** personKeys that can't be another speaker here (already named, mic user, self). */
  excluded: Set<string>;
}

export type MatchResult = SpeakerMatch & { auto: boolean };

/**
 * Greedy one-to-one by best score: a person gets at most one auto name per transcript (a split cluster then only gets
 * a suggestion). Score = best sample. Auto needs: score ≥ VOICE_AUTO, margin over the runner-up, enough speech, and
 * an invitee (or ≥ VOICE_STRONG). Below that, ≥ VOICE_SUGGEST = suggestion.
 */
export function matchVoices(labels: readonly VoiceLabel[], known: readonly KnownVoice[], ctx: MatchContext): Map<string, MatchResult> {
  const people = known.filter((p) => !ctx.excluded.has(p.key) && p.vectors.length);
  const scores = labels.map((l) => people.map((p) => Math.max(...p.vectors.map((v) => cosine(l.vector, v)))));
  const pairs: { li: number; pi: number; s: number }[] = [];
  scores.forEach((row, li) => row.forEach((s, pi) => pairs.push({ li, pi, s })));
  // Ties → label/person order: deterministic.
  pairs.sort((a, b) => b.s - a.s || a.li - b.li || a.pi - b.pi);
  const out = new Map<string, MatchResult>();
  const taken = new Set<number>();
  const done = new Set<number>();
  for (const { li, pi, s } of pairs) {
    if (done.has(li) || s < VOICE_SUGGEST) continue;
    const l = labels[li];
    const p = people[pi];
    const runnerUp = Math.max(-1, ...scores[li].filter((_, j) => j !== pi));
    const invited = ctx.invitees === null || ctx.invitees.has(p.key);
    const auto = !taken.has(pi) && s >= VOICE_AUTO && s - runnerUp >= VOICE_MARGIN && l.talkSeconds >= MIN_AUTO_TALK_S && (invited || s >= VOICE_STRONG);
    out.set(l.label, { name: p.name, reason: "voice", score: Math.round(s * 1000) / 1000, auto });
    done.add(li);
    if (auto) taken.add(pi);
  }
  return out;
}

const people = (t: Pick<TranscriptUpload, "meeting">): Person[] =>
  t.meeting ? [t.meeting.organizer, ...t.meeting.attendees].filter((p): p is Person => p !== null) : [];

/** Keys that can't be a diarized speaker: names in use, non-generic labels (mic = local user), invitees marked isSelf. */
export function excludedKeys(t: Pick<TranscriptUpload, "meeting" | "segments">, names: Record<string, string>): Set<string> {
  const keys = [...Object.values(names), ...[...talkSeconds(t.segments).keys()].filter((l) => !isGenericLabel(l))];
  const selfEmails = new Set(people(t).flatMap((p) => (p.isSelf && p.email ? [p.email] : [])));
  for (const p of people(t)) if (p.name && (p.isSelf || (p.email && selfEmails.has(p.email)))) keys.push(p.name);
  return new Set(keys.map(personKey).filter(Boolean));
}

/** Invitees (organizer + attendees) with a name; null = no calendar people (ad-hoc). */
export function inviteeKeys(t: Pick<TranscriptUpload, "meeting">): Set<string> | null {
  const keys = people(t).flatMap((p) => (p.name ? [personKey(p.name)] : []));
  return keys.length ? new Set(keys) : null;
}

/**
 * Exactly one unnamed diarized speaker (≥ MIN_ELIM_TALK_S of speech) and exactly one invitee not accounted for (not
 * self, not the mic user, not already named) → that's them. Any doubt (nameless or unidentifiable self, no-shows,
 * split clusters) → null.
 */
export function eliminate(t: Pick<TranscriptUpload, "meeting" | "segments">, names: Record<string, string>): { label: string; name: string } | null {
  if (!t.meeting) return null;
  const talk = talkSeconds(t.segments);
  const open = [...talk].filter(([l, s]) => isGenericLabel(l) && !Object.hasOwn(names, l) && s >= MIN_ELIM_TALK_S).map(([l]) => l);
  if (open.length !== 1) return null;
  const excluded = excludedKeys(t, names); // incl. isSelf names
  // isSelf may be on only one of organizer/attendee copies of the same person.
  const selfEmails = new Set(people(t).flatMap((p) => (p.isSelf && p.email ? [p.email] : [])));
  const seenEmail = new Set<string>();
  const seenKey = new Set<string>();
  const left: Person[] = [];
  for (const p of people(t)) {
    const key = p.name ? personKey(p.name) : null;
    // Same person listed as organizer + attendee, possibly with/without email.
    const dup = (p.email && seenEmail.has(p.email)) || (key && seenKey.has(key));
    if (p.email) seenEmail.add(p.email);
    if (key) seenKey.add(key);
    if (dup || p.isSelf || (p.email && selfEmails.has(p.email)) || (key && excluded.has(key))) continue;
    left.push(p);
  }
  if (left.length !== 1 || !left[0].name) return null;
  return { label: open[0], name: left[0].name };
}

/**
 * Matches for unnamed generic labels given `names` (all current names). Voice first; auto voice names count as
 * accounted for in elimination. Elimination is skipped when voice suggests someone else for that label (conflict →
 * leave it to the user).
 */
export function combineMatches(
  t: Pick<TranscriptUpload, "meeting" | "segments">,
  names: Record<string, string>,
  voices: readonly VoiceLabel[],
  known: readonly KnownVoice[],
): Map<string, MatchResult> {
  const open = voices.filter((v) => isGenericLabel(v.label) && !Object.hasOwn(names, v.label));
  const out = matchVoices(open, known, { invitees: inviteeKeys(t), excluded: excludedKeys(t, names) });
  const withAuto = { ...names };
  for (const [label, m] of out) if (m.auto) withAuto[label] = m.name;
  const e = eliminate(t, withAuto);
  if (e) {
    const v = out.get(e.label);
    if (!v || personKey(v.name) === personKey(e.name)) out.set(e.label, { name: e.name, reason: "calendar", score: null, auto: true });
  }
  return out;
}

// ---- storage (per-user DB) ----

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** Replaces the transcript's embeddings (stored unit-length). No model = can't be compared with anything → none kept. */
export function saveSpeakerEmbeddings(db: Db, transcriptId: string, model: string | null, embeddings: Record<string, number[]> | null): void {
  const id = transcriptId.toLowerCase();
  db.transaction(() => {
    db.prepare("DELETE FROM speaker_embeddings WHERE transcript_id = ?").run(id);
    if (!model || !embeddings) return;
    const put = db.prepare("INSERT INTO speaker_embeddings (transcript_id, label, model, vector) VALUES (?, ?, ?, ?)");
    for (const [label, vec] of Object.entries(embeddings)) {
      const unit = normalize(vec);
      if (unit) put.run(id, label, model, toBlob(unit));
    }
  })();
}

export function getSpeakerEmbeddings(db: Db, transcriptId: string): { model: string; vectors: Map<string, Float32Array> } | null {
  const rows = db.prepare("SELECT label, model, vector FROM speaker_embeddings WHERE transcript_id = ? ORDER BY label").all(transcriptId.toLowerCase()) as {
    label: string;
    model: string;
    vector: Buffer;
  }[];
  if (!rows.length) return null;
  return { model: rows[0].model, vectors: new Map(rows.map((r) => [r.label, fromBlob(r.vector)])) };
}

/** User-named labels with an embedding of `model`, other transcripts, newest meetings first; grouped by personKey. */
export function loadVoiceprints(db: Db, model: string, excludeTranscriptId: string): KnownVoice[] {
  const rows = db
    .prepare(
      `SELECT n.name, e.vector FROM speaker_names n
       JOIN speaker_embeddings e ON e.transcript_id = n.transcript_id AND e.label = n.label
       JOIN transcripts t ON t.id = n.transcript_id
       WHERE n.source = 'user' AND e.model = ? AND n.transcript_id != ?
       ORDER BY t.started_at DESC, n.transcript_id, n.label`,
    )
    .all(model, excludeTranscriptId.toLowerCase()) as { name: string; vector: Buffer }[];
  const byKey = new Map<string, KnownVoice>();
  for (const r of rows) {
    const key = personKey(r.name);
    if (!key) continue;
    let p = byKey.get(key);
    if (!p) byKey.set(key, (p = { key, name: r.name, vectors: [] })); // newest spelling
    if (p.vectors.length < MAX_SAMPLES_PER_PERSON) p.vectors.push(fromBlob(r.vector));
  }
  return [...byKey.values()];
}

function loadTranscript(db: Db, id: string): TranscriptUpload | null {
  const r = db.prepare("SELECT data FROM transcripts WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? (JSON.parse(r.data) as TranscriptUpload) : null;
}

/** Current matches for the transcript's unnamed labels (`names` = all current names). */
function matchesFor(db: Db, id: string, t: TranscriptUpload, names: Record<string, string>): Map<string, MatchResult> {
  const emb = getSpeakerEmbeddings(db, id);
  const talk = talkSeconds(t.segments);
  const voices: VoiceLabel[] = emb ? [...emb.vectors].map(([label, vector]) => ({ label, vector, talkSeconds: talk.get(label) ?? 0 })) : [];
  const known = emb ? loadVoiceprints(db, emb.model, id) : [];
  return combineMatches(t, names, voices, known);
}

/** For the web/LLM: matches for labels that have no name now (auto or not). Missing transcript → {}. */
export function speakerMatches(db: Db, transcriptId: string): Record<string, SpeakerMatch> {
  const id = transcriptId.toLowerCase();
  const t = loadTranscript(db, id);
  if (!t) return {};
  const out: Record<string, SpeakerMatch> = {};
  for (const [label, { auto: _auto, ...m }] of matchesFor(db, id, t, getSpeakerNames(db, id))) out[label] = m;
  return out;
}

/**
 * Recomputes auto names from scratch (user names kept, never overridden). Doesn't bump updated_at: runs at upload,
 * before the summary job reads the names. Returns label → auto name.
 */
export function autoNameSpeakers(db: Db, transcriptId: string, now: number): Record<string, string> {
  const id = transcriptId.toLowerCase();
  return db.transaction(() => {
    db.prepare("DELETE FROM speaker_names WHERE transcript_id = ? AND source = 'auto'").run(id);
    const t = loadTranscript(db, id);
    if (!t) return {};
    const put = db.prepare(
      "INSERT INTO speaker_names (transcript_id, label, name, updated_at, source, reason, score) VALUES (?, ?, ?, ?, 'auto', ?, ?)",
    );
    const out: Record<string, string> = {};
    for (const [label, m] of matchesFor(db, id, t, getSpeakerNames(db, id))) {
      if (!m.auto) continue;
      put.run(id, label, m.name, now, m.reason, m.score);
      out[label] = m.name;
    }
    return out;
  })();
}

/**
 * After upsertTranscript. Changed/new content: store its embeddings, rename automatically (labels may be renumbered,
 * so old auto names go). Unchanged retry: keep everything; only backfill embeddings if none are stored yet.
 */
export function ingestSpeakers(db: Db, t: TranscriptUpload, changed: boolean, now: number): void {
  if (changed) {
    saveSpeakerEmbeddings(db, t.id, t.diarizationModel, t.speakerEmbeddings ?? null);
    autoNameSpeakers(db, t.id, now);
  } else if (t.speakerEmbeddings && !getSpeakerEmbeddings(db, t.id)) {
    saveSpeakerEmbeddings(db, t.id, t.diarizationModel, t.speakerEmbeddings);
  }
}
