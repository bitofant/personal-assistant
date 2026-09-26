import Foundation

// Recording (mic WAV + system WAV) → [TranscriptSegment]. Engines sit behind Transcriber/SpeakerDiarizer; everything
// here is pure (or async over fakes) so it's unit-tested on Linux.

/// Times = seconds from recording start.
public struct TimedWord: Equatable, Sendable {
    public var text: String
    public var start: Double
    public var end: Double

    public init(_ text: String, start: Double, end: Double) {
        self.text = text
        self.start = start
        self.end = end
    }
}

/// One diarizer cluster talking over [start, end). `speaker` = engine id (e.g. FluidAudio "S2").
public struct SpeakerTurn: Equatable, Sendable {
    public var speaker: String
    public var start: Double
    public var end: Double

    public init(_ speaker: String, start: Double, end: Double) {
        self.speaker = speaker
        self.start = start
        self.end = end
    }
}

public protocol Transcriber: Sendable {
    /// → `TranscriptUpload.asrModel`.
    var model: String { get }
    func words(in audio: URL) async throws -> [TimedWord]
}

public protocol SpeakerDiarizer: Sendable {
    /// → `TranscriptUpload.diarizationModel`.
    var model: String { get }
    func turns(in audio: URL) async throws -> [SpeakerTurn]
}

/// Speaker per word: turn with most overlap; else nearest turn within `snap`s (ASR and diarizer edges drift a
/// few frames); else nil. Equal overlap → earlier turn (deterministic).
public func assignSpeakers(_ words: [TimedWord], turns: [SpeakerTurn], snap: Double = 0.5) -> [String?] {
    words.map { w in
        var best: (speaker: String, overlap: Double)?
        var near: (speaker: String, gap: Double)?
        for t in turns {
            let overlap = min(w.end, t.end) - max(w.start, t.start)
            if overlap > 0 {
                if overlap > best?.overlap ?? 0 { best = (t.speaker, overlap) }
            } else {
                // ≤ 0 inside a turn (zero-length word), else distance to the turn edge.
                let gap = max(t.start - w.end, w.start - t.end)
                if gap <= snap, gap < near?.gap ?? .infinity { near = (t.speaker, gap) }
            }
        }
        return best?.speaker ?? near?.speaker
    }
}

/// Engine ids → "Speaker 1", "Speaker 2", … by first appearance: stable per transcript, never mistaken for a
/// real name (naming happens later, server/web side).
public func relabelSpeakers(_ speakers: [String?]) -> [String?] {
    var names: [String: String] = [:]
    return speakers.map { s in
        guard let s else { return nil }
        if let n = names[s] { return n }
        let n = "Speaker \(names.count + 1)"
        names[s] = n
        return n
    }
}

public struct SegmentRules: Equatable, Sendable {
    /// Silence longer than this starts a new segment.
    public var maxGap = 1.5
    /// Past this length, split at the next sentence end (keeps segments readable/searchable).
    public var softMax = 20.0
    /// Past this length, split regardless (unpunctuated monologue).
    public var hardMax = 45.0

    public init() {}
}

/// Consecutive words → segments; split on speaker change, pause, or length (see `SegmentRules`).
public func groupSegments(_ words: [TimedWord], speakers: [String?], rules: SegmentRules = SegmentRules()) -> [TranscriptSegment] {
    precondition(words.count == speakers.count, "one speaker slot per word")
    var out: [TranscriptSegment] = []
    var cur: TranscriptSegment?
    for (w, speaker) in zip(words, speakers) {
        let text = w.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { continue }
        if var c = cur {
            let len = c.end - c.start
            let split = speaker != c.speaker
                || w.start - c.end > rules.maxGap
                || (len >= rules.softMax && endsSentence(c.text))
                || w.end - c.start > rules.hardMax
            if !split {
                c.text += " " + text
                c.end = max(c.end, w.end)
                cur = c
                continue
            }
            out.append(c)
        }
        cur = TranscriptSegment(start: w.start, end: w.end, speaker: speaker, text: text)
    }
    if let cur { out.append(cur) }
    return out
}

private func endsSentence(_ s: String) -> Bool {
    guard let last = s.last else { return false }
    return ".?!…。？！".contains(last)
}

/// Interleave per-stream segments by start time. Ties keep argument order (earlier stream first).
public func mergeStreams(_ streams: [TranscriptSegment]...) -> [TranscriptSegment] {
    streams.enumerated()
        .flatMap { i, segs in segs.enumerated().map { (seg: $1, key: (i, $0)) } }
        .sorted { a, b in
            if a.seg.start != b.seg.start { return a.seg.start < b.seg.start }
            return a.key < b.key
        }
        .map(\.seg)
}

public struct Transcription: Equatable, Sendable {
    public var segments: [TranscriptSegment]
    public var asrModel: String
    /// nil = diarization not run or failed (then system speakers are nil).
    public var diarizationModel: String?
    /// Non-fatal problems (e.g. diarization failed); shown to the user, transcript still produced.
    public var warnings: [String]
}

/// Mic = the local user (headphones assumed → no bleed), labelled `micSpeaker`; system = everyone else,
/// diarized. Diarization is optional and fails safe (speakers nil); ASR failure throws.
public func transcribeRecording(
    mic: URL?, system: URL?, transcriber: any Transcriber, diarizer: (any SpeakerDiarizer)?,
    micSpeaker: String, rules: SegmentRules = SegmentRules()
) async throws -> Transcription {
    var warnings: [String] = []
    var micSegs: [TranscriptSegment] = []
    if let mic {
        let words = try await transcriber.words(in: mic)
        micSegs = groupSegments(words, speakers: Array(repeating: micSpeaker, count: words.count), rules: rules)
    }
    var sysSegs: [TranscriptSegment] = []
    var diarizationModel: String?
    if let system {
        let words = try await transcriber.words(in: system)
        var speakers = [String?](repeating: nil, count: words.count)
        if let diarizer, !words.isEmpty {
            do {
                let turns = try await diarizer.turns(in: system)
                speakers = relabelSpeakers(assignSpeakers(words, turns: turns))
                diarizationModel = diarizer.model
            } catch {
                warnings.append("diarization failed, speakers left unknown: \(error)")
            }
        }
        sysSegs = groupSegments(words, speakers: speakers, rules: rules)
    }
    return Transcription(
        segments: mergeStreams(micSegs, sysSegs), asrModel: transcriber.model,
        diarizationModel: diarizationModel, warnings: warnings)
}

/// One `pa test-capture` recording: `pa-<stamp>-{system,mic}.wav` (either may be missing).
public struct CaptureFiles: Equatable, Sendable {
    public var stamp: String
    public var system: String?
    public var mic: String?

    public init(stamp: String, system: String? = nil, mic: String? = nil) {
        self.stamp = stamp
        self.system = system
        self.mic = mic
    }
}

/// Groups capture WAV file names by stamp, oldest first; unrelated names ignored.
public func findCaptures(_ fileNames: [String]) -> [CaptureFiles] {
    var byStamp: [String: CaptureFiles] = [:]
    for name in fileNames {
        guard name.hasPrefix("pa-"), name.hasSuffix(".wav") else { continue }
        let body = name.dropFirst(3).dropLast(4)
        for kind in ["system", "mic"] where body.hasSuffix("-" + kind) {
            let stamp = String(body.dropLast(kind.count + 1))
            guard parseCaptureStamp(stamp, timeZone: TimeZone(identifier: "UTC")!) != nil else { continue }
            var c = byStamp[stamp] ?? CaptureFiles(stamp: stamp)
            if kind == "system" { c.system = name } else { c.mic = name }
            byStamp[stamp] = c
        }
    }
    return byStamp.values.sorted { $0.stamp < $1.stamp }
}

/// Requested stamp, else newest recording.
public func pickCapture(_ captures: [CaptureFiles], stamp: String?, dir: String) throws(UsageError) -> CaptureFiles {
    if let stamp {
        guard let c = captures.first(where: { $0.stamp == stamp }) else { throw UsageError("no recording \(stamp) in \(dir)") }
        return c
    }
    guard let newest = captures.last else { throw UsageError("no pa-<stamp>-{system,mic}.wav in \(dir)") }
    return newest
}

/// Next to the WAVs; `findCaptures` ignores it (no -system/-mic suffix).
public func transcriptFileName(stamp: String) -> String { "pa-\(stamp)-transcript.json" }

/// `[m:ss] Speaker: text`, same offset format as shared/format.ts `formatOffset`; unknown speaker → `—`.
public func formatSegmentLine(_ s: TranscriptSegment) -> String {
    let t = max(0, Int(s.start.rounded(.down)))
    let (h, m, sec) = (t / 3600, t % 3600 / 60, t % 60)
    let offset = h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    return "[\(offset)] \(s.speaker ?? "—"): \(s.text)"
}

/// `yyyyMMdd-HHmmss` in the capturing Mac's zone (TestCapture.swift writes local time, no offset).
public func parseCaptureStamp(_ stamp: String, timeZone: TimeZone) -> Date? {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = timeZone
    f.dateFormat = "yyyyMMdd-HHmmss"
    f.isLenient = false
    // DateFormatter accepts trailing junk / short fields; round-trip rejects them.
    guard let d = f.date(from: stamp), f.string(from: d) == stamp else { return nil }
    return d
}

/// UTC ISO-8601, whole seconds (server requires a zone; normalizes anyway).
public func isoTimestamp(_ d: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: d)
}

/// What `pa transcribe` writes/uploads. nil keys omitted (server: missing = null). Contract: shared/fixtures/transcript-upload-pa.json.
public func encodeTranscriptUpload(_ u: TranscriptUpload) throws -> Data {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return try enc.encode(u)
}

/// `duration` = longest stream (seconds); `id` lowercased to match server normalization.
public func makeTranscriptUpload(
    id: UUID, startedAt: Date, duration: Double, meeting: MeetingMeta?, transcription t: Transcription
) -> TranscriptUpload {
    TranscriptUpload(
        id: id.uuidString.lowercased(), startedAt: isoTimestamp(startedAt),
        endedAt: isoTimestamp(startedAt.addingTimeInterval(duration)), meeting: meeting,
        segments: t.segments, asrModel: t.asrModel, diarizationModel: t.diarizationModel)
}
