import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { TranscriptSegment, TranscriptUpload } from "../shared/api.js";
import { migrate, USER_MIGRATIONS } from "./db.js";
import {
  autoNameSpeakers,
  combineMatches,
  eliminate,
  getSpeakerEmbeddings,
  ingestSpeakers,
  loadVoiceprints,
  matchVoices,
  normalize,
  personKey,
  speakerMatches,
  type KnownVoice,
  type VoiceLabel,
} from "./speakerMatch.js";
import { getAutoSpeakers, getSpeakerNames, setSpeakerNames } from "./speakers.js";
import { deleteTranscript, parseTranscriptUpload, upsertTranscript } from "./transcripts.js";

const MODEL = "fluidaudio-offline-vbx-0.17.4";
/** Unit-ish vector pointing mostly along axis `i` (dim 8), with a bit of `j` → controllable cosines. */
const vec = (i: number, j = i, w = 0): number[] => Array.from({ length: 8 }, (_, k) => (k === i ? 1 : 0) + (k === j ? w : 0));
const unit = (v: number[]) => normalize(v)!;
const seg = (start: number, end: number, speaker: string | null, text = "x"): TranscriptSegment => ({ start, end, speaker, text });
const voice = (label: string, v: number[], talkSeconds = 60): VoiceLabel => ({ label, vector: unit(v), talkSeconds });
const known = (name: string, ...vs: number[][]): KnownVoice => ({ key: personKey(name), name, vectors: vs.map(unit) });
const ctx = (invitees: string[] | null = null, excluded: string[] = []) => ({
  invitees: invitees && new Set(invitees.map(personKey)),
  excluded: new Set(excluded.map(personKey)),
});

describe("personKey", () => {
  it("ignores case, accents, punctuation, word order", () => {
    expect(personKey("Tesse, Joran")).toBe(personKey("joran  TESSE"));
    expect(personKey("Zoë O'Brien")).toBe(personKey("o brien zoe"));
    expect(personKey("Bob")).not.toBe(personKey("Bobby"));
    expect(personKey(" - ")).toBe("");
  });
});

describe("matchVoices", () => {
  const bob = known("Bob", vec(1));
  const carol = known("Carol", vec(2));

  it("auto-names a clear, long, invited match; score rounded", () => {
    const got = matchVoices([voice("Speaker 1", vec(1, 3, 0.2))], [bob, carol], ctx(["Bob", "Carol"]));
    expect(got.get("Speaker 1")).toEqual({ name: "Bob", reason: "voice", score: 0.981, auto: true });
  });

  it("medium similarity = suggestion only; below VOICE_SUGGEST = nothing", () => {
    // cos = 1/sqrt(1+w²): w=1 → 0.707 (auto range), w=1.5 → 0.555 (suggest), w=2 → 0.447 (none)
    expect(matchVoices([voice("S", vec(1, 3, 1.5))], [bob], ctx())).toEqual(new Map([["S", { name: "Bob", reason: "voice", score: 0.555, auto: false }]]));
    expect(matchVoices([voice("S", vec(1, 3, 2))], [bob], ctx()).size).toBe(0);
    expect(matchVoices([voice("S", vec(1, 3, 1))], [bob], ctx()).get("S")?.auto).toBe(true);
  });

  it("no auto when: too little speech, runner-up too close, non-invitee below VOICE_STRONG", () => {
    expect(matchVoices([voice("S", vec(1), 5)], [bob], ctx()).get("S")?.auto).toBe(false);
    // Bob 0.743, Dave 0.669 → margin < 0.1; without Dave → auto
    expect(matchVoices([voice("S", vec(1, 3, 0.9))], [bob, known("Dave", vec(3))], ctx()).get("S")).toMatchObject({ name: "Bob", auto: false });
    expect(matchVoices([voice("S", vec(1, 3, 0.9))], [bob], ctx()).get("S")?.auto).toBe(true);
    // cos 0.707 with someone not invited → suggestion; 0.98 → auto anyway
    expect(matchVoices([voice("S", vec(1, 3, 1))], [bob], ctx(["Carol"])).get("S")?.auto).toBe(false);
    expect(matchVoices([voice("S", vec(1, 3, 0.2))], [bob], ctx(["Carol"])).get("S")?.auto).toBe(true);
  });

  it("best sample counts; one auto name per person; excluded people skipped", () => {
    const multi = known("Bob", vec(5), vec(1));
    const got = matchVoices([voice("Speaker 1", vec(1, 3, 0.3)), voice("Speaker 2", vec(1, 3, 0.1))], [multi, carol], ctx());
    expect(got.get("Speaker 2")).toMatchObject({ name: "Bob", auto: true });
    expect(got.get("Speaker 1")).toMatchObject({ name: "Bob", auto: false }); // split cluster → suggestion
    expect(matchVoices([voice("S", vec(1))], [bob], ctx(null, ["bob"])).size).toBe(0);
  });

  it("different embedding length = no match", () => {
    expect(matchVoices([{ label: "S", vector: unit([1, 0]), talkSeconds: 60 }], [bob], ctx()).size).toBe(0);
  });
});

const meeting = (people: { name: string | null; email?: string | null; isSelf?: boolean }[], organizer: (typeof people)[number] | null = null) => ({
  calendarName: "Work",
  eventId: "e",
  seriesId: null,
  title: "Sync",
  start: "2026-09-24T07:00:00.000Z",
  end: "2026-09-24T07:30:00.000Z",
  organizer: organizer && { email: null, ...organizer },
  attendees: people.map((p) => ({ email: null, ...p })),
});

describe("eliminate", () => {
  const oneOnOne = {
    meeting: meeting([{ name: "Joran Tesse", email: "j@x.com" }, { name: "Bob Builder", email: "bob@x.com" }]),
    segments: [seg(0, 30, "Tesse, Joran"), seg(30, 60, "Speaker 1"), seg(60, 62, "Speaker 2")],
  };

  it("1on1: mic user + one remote cluster → the other invitee (short clusters ignored)", () => {
    expect(eliminate(oneOnOne, {})).toEqual({ label: "Speaker 1", name: "Bob Builder" });
  });

  it("isSelf identifies the user when the mic label doesn't match the calendar name", () => {
    const t = { ...oneOnOne, segments: [seg(0, 30, "Joran"), seg(30, 60, "Speaker 1")] };
    expect(eliminate(t, {})).toBeNull(); // self unknown → 2 candidates
    const flagged = { ...t, meeting: meeting([{ name: "Joran Tesse", email: "j@x.com", isSelf: true }, { name: "Bob Builder" }], { name: "Joran T.", email: "j@x.com" }) };
    expect(eliminate(flagged, {})).toEqual({ label: "Speaker 1", name: "Bob Builder" });
    const emailOnly = { ...t, meeting: meeting([{ name: null, email: "j@x.com", isSelf: true }, { name: "Bob Builder" }]) };
    expect(eliminate(emailOnly, {})).toEqual({ label: "Speaker 1", name: "Bob Builder" });
  });

  it("names already used (user/auto) are accounted for", () => {
    const t = {
      meeting: meeting([{ name: "Joran Tesse" }, { name: "Bob" }, { name: "Carol" }]),
      segments: [seg(0, 30, "Joran Tesse"), seg(30, 60, "Speaker 1"), seg(60, 90, "Speaker 2")],
    };
    expect(eliminate(t, {})).toBeNull(); // 2 open speakers
    expect(eliminate(t, { "Speaker 2": "carol" })).toEqual({ label: "Speaker 1", name: "Bob" });
  });

  it("doubt → null: no-show (2 left), nameless invitee, ad-hoc, no open speaker; organizer duplicate deduped", () => {
    const three = { ...oneOnOne, meeting: meeting([{ name: "Joran Tesse" }, { name: "Bob" }, { name: "Carol" }]) };
    expect(eliminate(three, {})).toBeNull();
    expect(eliminate({ ...oneOnOne, meeting: meeting([{ name: "Joran Tesse" }, { name: null, email: "bob@x.com" }]) }, {})).toBeNull();
    expect(eliminate({ ...oneOnOne, meeting: null }, {})).toBeNull();
    expect(eliminate(oneOnOne, { "Speaker 1": "Someone" })).toBeNull();
    const dup = { ...oneOnOne, meeting: meeting([{ name: "Joran Tesse" }, { name: "Bob Builder", email: "bob@x.com" }], { name: "Bob B.", email: "BOB@x.com".toLowerCase() }) };
    expect(eliminate(dup, {})).toEqual({ label: "Speaker 1", name: "Bob B." });
  });
});

describe("combineMatches", () => {
  const t = {
    meeting: meeting([{ name: "Me", isSelf: true }, { name: "Bob" }, { name: "Carol" }]),
    segments: [seg(0, 30, "Me"), seg(30, 60, "Speaker 1"), seg(60, 90, "Speaker 2")],
  };

  it("voice auto name counts for elimination of the rest", () => {
    const got = combineMatches(t, {}, [voice("Speaker 1", vec(1)), voice("Speaker 2", vec(6))], [known("Bob", vec(1))]);
    expect(got.get("Speaker 1")).toMatchObject({ name: "Bob", reason: "voice", auto: true });
    expect(got.get("Speaker 2")).toEqual({ name: "Carol", reason: "calendar", score: null, auto: true });
  });

  it("elimination skipped when voice points elsewhere; named labels never matched", () => {
    const got = combineMatches(t, { "Speaker 1": "Bob" }, [voice("Speaker 1", vec(1)), voice("Speaker 2", vec(2, 3, 1.5))], [known("Bob", vec(1)), known("Dave", vec(2))]);
    expect(got.has("Speaker 1")).toBe(false);
    expect(got.get("Speaker 2")).toMatchObject({ name: "Dave", reason: "voice", auto: false });
  });
});

// ---- storage ----

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
function upload(id: string, startedAt: string, embeddings: Record<string, number[]> | null, extra: Partial<TranscriptUpload> = {}): TranscriptUpload {
  return parseTranscriptUpload({
    id,
    startedAt,
    endedAt: startedAt.replace("T07", "T08"),
    meeting: null,
    segments: [seg(0, 30, "Me"), seg(30, 60, "Speaker 1"), seg(60, 90, "Speaker 2")],
    asrModel: "asr",
    diarizationModel: MODEL,
    speakerEmbeddings: embeddings,
    ...extra,
  });
}
function userDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, USER_MIGRATIONS);
  return db;
}
function ingest(db: Database.Database, t: TranscriptUpload, now: number) {
  const { changed } = upsertTranscript(db, "dev", t, "{}", now);
  ingestSpeakers(db, t, changed, now);
  return changed;
}

describe("ingest + auto names (per-user DB)", () => {
  it("learns from user names in other transcripts; never overrides user names; confirm = user, no stale bump", () => {
    const db = userDb();
    ingest(db, upload(ID1, "2026-09-20T07:00:00Z", { "Speaker 1": vec(1), "Speaker 2": vec(2) }), 1000);
    expect(getSpeakerNames(db, ID1)).toEqual({}); // nobody known yet
    setSpeakerNames(db, ID1, new Map([["Speaker 1", "Bob"]]), 2000);

    ingest(db, upload(ID2, "2026-09-24T07:00:00Z", { "Speaker 1": vec(2), "Speaker 2": vec(1, 3, 0.2) }), 3000);
    expect(getSpeakerNames(db, ID2)).toEqual({ "Speaker 2": "Bob" });
    expect(getAutoSpeakers(db, ID2)).toEqual({ "Speaker 2": { name: "Bob", reason: "voice", score: 0.981 } });
    const updatedAt = () => (db.prepare("SELECT updated_at FROM transcripts WHERE id = ?").get(ID2) as { updated_at: number }).updated_at;
    expect(updatedAt()).toBe(3000); // auto naming at upload doesn't bump

    // Auto names are not voiceprints: only Bob from ID1 (user) is known.
    expect(loadVoiceprints(db, MODEL, ID1).map((p) => p.name)).toEqual([]);
    setSpeakerNames(db, ID2, new Map([["Speaker 2", "Bob"]]), 4000); // confirm
    expect(getAutoSpeakers(db, ID2)).toEqual({});
    expect(updatedAt()).toBe(3000);
    expect(loadVoiceprints(db, MODEL, ID1).map((p) => [p.name, p.vectors.length])).toEqual([["Bob", 1]]);

    // Re-run never touches the user name; an auto name the user overwrote stays theirs.
    setSpeakerNames(db, ID1, new Map([["Speaker 2", "Carol"]]), 5000);
    autoNameSpeakers(db, ID2, 6000);
    expect(getSpeakerNames(db, ID2)).toEqual({ "Speaker 1": "Carol", "Speaker 2": "Bob" });
    expect(getAutoSpeakers(db, ID2)).toEqual({ "Speaker 1": { name: "Carol", reason: "voice", score: 1 } });
  });

  it("other diarization model = not comparable; unchanged retry keeps auto names, changed re-upload recomputes", () => {
    const db = userDb();
    ingest(db, upload(ID1, "2026-09-20T07:00:00Z", { "Speaker 1": vec(1) }), 1000);
    setSpeakerNames(db, ID1, new Map([["Speaker 1", "Bob"]]), 2000);
    ingest(db, upload(ID2, "2026-09-24T07:00:00Z", { "Speaker 2": vec(1) }, { diarizationModel: "other" }), 3000);
    expect(getSpeakerNames(db, ID2)).toEqual({});

    const t2 = upload(ID2, "2026-09-24T07:00:00Z", { "Speaker 2": vec(1) });
    expect(ingest(db, t2, 4000)).toBe(true);
    expect(getSpeakerNames(db, ID2)).toEqual({ "Speaker 2": "Bob" });
    db.prepare("UPDATE speaker_names SET name = 'Marker' WHERE transcript_id = ?").run(ID2);
    expect(ingest(db, t2, 5000)).toBe(false);
    expect(getSpeakerNames(db, ID2)).toEqual({ "Speaker 2": "Marker" }); // untouched
    // Renumbered labels: old auto name dropped, recomputed.
    const renumbered = { segments: [seg(0, 30, "Me"), seg(30, 60, "Speaker 1"), seg(60, 90, "Speaker 1")] };
    expect(ingest(db, upload(ID2, "2026-09-24T07:00:00Z", { "Speaker 1": vec(1) }, renumbered), 6000)).toBe(true);
    expect(getSpeakerNames(db, ID2)).toEqual({ "Speaker 1": "Bob" });
  });

  it("calendar elimination at upload; matches for unnamed labels on demand", () => {
    const db = userDb();
    const m = meeting([{ name: "Me", isSelf: true }, { name: "Bob" }]);
    ingest(db, upload(ID1, "2026-09-20T07:00:00Z", null, { meeting: m, segments: [seg(0, 30, "Me"), seg(30, 60, "Speaker 1")] }), 1000);
    expect(getAutoSpeakers(db, ID1)).toEqual({ "Speaker 1": { name: "Bob", reason: "calendar", score: null } });
    expect(speakerMatches(db, ID1)).toEqual({}); // named (auto) → no match offered
    setSpeakerNames(db, ID1, new Map([["Speaker 1", null]]), 2000); // user rejects: stays unnamed
    expect(getSpeakerNames(db, ID1)).toEqual({});
    expect(speakerMatches(db, ID1)).toEqual({ "Speaker 1": { name: "Bob", reason: "calendar", score: null } });
    expect(speakerMatches(db, ID2)).toEqual({});
  });

  it("embeddings: unchanged retry backfills, zero vectors dropped, cascade on delete", () => {
    const db = userDb();
    ingest(db, upload(ID1, "2026-09-20T07:00:00Z", null), 1000);
    expect(getSpeakerEmbeddings(db, ID1)).toBeNull();
    expect(ingest(db, upload(ID1, "2026-09-20T07:00:00Z", { "Speaker 1": vec(1), "Speaker 2": [0, 0, 0, 0, 0, 0, 0, 0] }), 2000)).toBe(false);
    const e = getSpeakerEmbeddings(db, ID1)!;
    expect(e.model).toBe(MODEL);
    expect([...e.vectors.keys()]).toEqual(["Speaker 1"]);
    expect(Array.from(e.vectors.get("Speaker 1")!)).toEqual(vec(1));
    deleteTranscript(db, ID1, 3000);
    expect(db.prepare("SELECT count(*) AS n FROM speaker_embeddings").get()).toEqual({ n: 0 });
  });
});
