import Foundation
import Testing
@testable import PACore

private func w(_ text: String, _ start: Double, _ end: Double) -> TimedWord { TimedWord(text, start: start, end: end) }
private func seg(_ start: Double, _ end: Double, _ speaker: String?, _ text: String) -> TranscriptSegment {
    TranscriptSegment(start: start, end: end, speaker: speaker, text: text)
}

@Suite struct AssignSpeakersTests {
    @Test func mostOverlapWins() {
        let turns = [SpeakerTurn("S1", start: 0, end: 1.2), SpeakerTurn("S2", start: 1.2, end: 3)]
        // "b" straddles the change: 0.2s in S1, 0.3s in S2.
        #expect(assignSpeakers([w("a", 0.1, 0.5), w("b", 1.0, 1.5), w("c", 2, 2.5)], turns: turns) == ["S1", "S2", "S2"])
    }

    @Test func equalOverlapPicksEarlierTurn() {
        let turns = [SpeakerTurn("S1", start: 0, end: 1), SpeakerTurn("S2", start: 1, end: 2)]
        #expect(assignSpeakers([w("x", 0.5, 1.5)], turns: turns) == ["S1"])
    }

    @Test func snapsToNearbyTurnElseNil() {
        let turns = [SpeakerTurn("S1", start: 0, end: 1), SpeakerTurn("S2", start: 3, end: 4)]
        let got = assignSpeakers([w("near1", 1.3, 1.6), w("near2", 2.7, 2.9), w("far", 1.8, 2.2)], turns: turns)
        #expect(got == ["S1", "S2", nil])
        #expect(assignSpeakers([w("x", 1.3, 1.6)], turns: turns, snap: 0.1) == [nil])
    }

    @Test func zeroLengthWordInsideTurn() {
        #expect(assignSpeakers([w("x", 0.5, 0.5)], turns: [SpeakerTurn("S1", start: 0, end: 1)]) == ["S1"])
    }

    @Test func noTurns() {
        #expect(assignSpeakers([w("x", 0, 1)], turns: []) == [nil])
    }
}

@Suite struct RelabelTests {
    @Test func firstAppearanceOrder() {
        #expect(relabelSpeakers(["S3", nil, "S1", "S3", "S2"]) == ["Speaker 1", nil, "Speaker 2", "Speaker 1", "Speaker 3"])
    }
}

@Suite struct GroupSegmentsTests {
    @Test func splitsOnSpeakerChange() {
        let words = [w("Hi", 0, 0.3), w("there.", 0.4, 0.8), w("Hello!", 1.0, 1.4)]
        #expect(groupSegments(words, speakers: ["A", "A", "B"]) == [seg(0, 0.8, "A", "Hi there."), seg(1.0, 1.4, "B", "Hello!")])
    }

    @Test func nilSpeakerIsItsOwnSpeaker() {
        let got = groupSegments([w("a", 0, 1), w("b", 1, 2), w("c", 2, 3)], speakers: [nil, nil, "A"])
        #expect(got == [seg(0, 2, nil, "a b"), seg(2, 3, "A", "c")])
    }

    @Test func splitsOnPause() {
        let words = [w("one", 0, 0.5), w("two", 2.0, 2.5), w("three", 4.1, 4.5)]
        // gaps: 1.5 (not > maxGap) then 1.6.
        #expect(groupSegments(words, speakers: ["A", "A", "A"]) == [seg(0, 2.5, "A", "one two"), seg(4.1, 4.5, "A", "three")])
    }

    @Test func softSplitAtSentenceEnd() {
        var rules = SegmentRules()
        rules.softMax = 2
        let words = [w("a", 0, 1), w("b,", 1, 2), w("c.", 2, 3), w("d", 3, 4)]
        // at "c." length 2 but "b," isn't a sentence end → joined; at "d" "…c." ends a sentence → split.
        #expect(groupSegments(words, speakers: Array(repeating: "A", count: 4), rules: rules)
            == [seg(0, 3, "A", "a b, c."), seg(3, 4, "A", "d")])
    }

    @Test func hardSplitWithoutPunctuation() {
        var rules = SegmentRules()
        rules.softMax = 2
        rules.hardMax = 3
        let words = (0..<5).map { w("x\($0)", Double($0), Double($0) + 1) }
        #expect(groupSegments(words, speakers: Array(repeating: "A", count: 5), rules: rules)
            == [seg(0, 3, "A", "x0 x1 x2"), seg(3, 5, "A", "x3 x4")])
    }

    @Test func skipsBlankWordsAndTrims() {
        #expect(groupSegments([w(" ", 0, 1), w(" hi ", 1, 2)], speakers: ["A", "A"]) == [seg(1, 2, "A", "hi")])
        #expect(groupSegments([], speakers: []) == [])
    }
}

@Suite struct MergeStreamsTests {
    @Test func interleavesByStartTiesKeepStreamOrder() {
        let mic = [seg(0, 1, "Me", "m1"), seg(5, 6, "Me", "m2")]
        let sys = [seg(2, 3, "Speaker 1", "s1"), seg(5, 7, "Speaker 1", "s2")]
        #expect(mergeStreams(mic, sys).map(\.text) == ["m1", "s1", "m2", "s2"])
        #expect(mergeStreams(sys, mic).map(\.text) == ["m1", "s1", "s2", "m2"])
    }
}

struct FakeTranscriber: Transcriber {
    let model = "fake-asr"
    let byFile: [String: [TimedWord]]
    func words(in audio: URL) async throws -> [TimedWord] {
        guard let ws = byFile[audio.lastPathComponent] else { throw FakeError.missing }
        return ws
    }
}

struct FakeDiarizer: SpeakerDiarizer {
    let model = "fake-diar"
    let turns: [SpeakerTurn]?
    func turns(in audio: URL) async throws -> [SpeakerTurn] {
        guard let turns else { throw FakeError.boom }
        return turns
    }
}

enum FakeError: Error { case missing, boom }

@Suite struct TranscribeRecordingTests {
    let mic = URL(fileURLWithPath: "/r/mic.wav"), sys = URL(fileURLWithPath: "/r/system.wav")
    let asr = FakeTranscriber(byFile: [
        "mic.wav": [TimedWord("Morning!", start: 0, end: 0.8), TimedWord("Sure.", start: 5, end: 5.4)],
        "system.wav": [
            TimedWord("Hi", start: 1, end: 1.3), TimedWord("all.", start: 1.4, end: 1.8),
            TimedWord("Agenda?", start: 2.5, end: 3),
        ],
    ])

    @Test func micIsLocalUserSystemIsDiarized() async throws {
        let d = FakeDiarizer(turns: [SpeakerTurn("S2", start: 0.9, end: 2), SpeakerTurn("S1", start: 2.4, end: 3.2)])
        let t = try await transcribeRecording(mic: mic, system: sys, transcriber: asr, diarizer: d, micSpeaker: "Me")
        #expect(t.segments == [
            seg(0, 0.8, "Me", "Morning!"),
            seg(1, 1.8, "Speaker 1", "Hi all."),
            seg(2.5, 3, "Speaker 2", "Agenda?"),
            seg(5, 5.4, "Me", "Sure."),
        ])
        #expect(t.asrModel == "fake-asr" && t.diarizationModel == "fake-diar" && t.warnings.isEmpty)
    }

    @Test func diarizationFailureFailsSafe() async throws {
        let t = try await transcribeRecording(
            mic: nil, system: sys, transcriber: asr, diarizer: FakeDiarizer(turns: nil), micSpeaker: "Me")
        #expect(t.segments == [seg(1, 3, nil, "Hi all. Agenda?")])
        #expect(t.diarizationModel == nil && t.warnings.count == 1)
    }

    @Test func noDiarizer() async throws {
        let t = try await transcribeRecording(mic: nil, system: sys, transcriber: asr, diarizer: nil, micSpeaker: "Me")
        #expect(t.segments.allSatisfy { $0.speaker == nil } && t.diarizationModel == nil && t.warnings.isEmpty)
    }

    @Test func asrFailureThrows() async {
        await #expect(throws: FakeError.self) {
            try await transcribeRecording(
                mic: URL(fileURLWithPath: "/r/other.wav"), system: nil, transcriber: asr, diarizer: nil, micSpeaker: "Me")
        }
    }
}

@Suite struct CaptureFilesTests {
    @Test func groupsByStampOldestFirst() {
        let got = findCaptures([
            "pa-20260925-101500-system.wav", "pa-20260924-090003-mic.wav", "pa-20260925-101500-mic.wav",
            "pa-20260924-090003-system.wav", "pa-20260926-120000-mic.wav",
            "notes.txt", "pa-bogus-mic.wav", "pa-20260924-090003-other.wav", "pa-20261399-000000-mic.wav",
        ])
        #expect(got == [
            CaptureFiles(stamp: "20260924-090003", system: "pa-20260924-090003-system.wav", mic: "pa-20260924-090003-mic.wav"),
            CaptureFiles(stamp: "20260925-101500", system: "pa-20260925-101500-system.wav", mic: "pa-20260925-101500-mic.wav"),
            CaptureFiles(stamp: "20260926-120000", mic: "pa-20260926-120000-mic.wav"),
        ])
    }

    @Test func stampIsLocalTime() throws {
        let cest = TimeZone(identifier: "Europe/Brussels")!
        let d = try #require(parseCaptureStamp("20260924-090003", timeZone: cest))
        #expect(isoTimestamp(d) == "2026-09-24T07:00:03Z")
        #expect(parseCaptureStamp("20260924-0900", timeZone: cest) == nil)
        #expect(parseCaptureStamp("20260924-090003x", timeZone: cest) == nil)
    }

    @Test func buildsUpload() throws {
        let t = Transcription(segments: [seg(0, 1, "Me", "Hi")], asrModel: "parakeet-tdt-0.6b-v3", diarizationModel: nil, warnings: [])
        let id = UUID(uuidString: "6F1C2B7E-3D4A-4E5F-9A8B-1C2D3E4F5A6B")!
        let start = Date(timeIntervalSince1970: 1_790_233_203)  // 2026-09-24T07:00:03Z
        let u = makeTranscriptUpload(id: id, startedAt: start, duration: 1897.4, meeting: nil, transcription: t)
        #expect(u.id == "6f1c2b7e-3d4a-4e5f-9a8b-1c2d3e4f5a6b")
        #expect(u.startedAt == "2026-09-24T07:00:03Z" && u.endedAt == "2026-09-24T07:31:40Z")
        #expect(u.segments == t.segments && u.meeting == nil && u.diarizationModel == nil)
        // Same wire shape the server accepts (fixture keys).
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(u)) as! [String: Any]
        let fixtureKeys = try JSONSerialization.jsonObject(with: fixture("transcript-upload.json")) as! [String: Any]
        #expect(Set(json.keys).isSubset(of: Set(fixtureKeys.keys)))
    }
}

@Suite struct TranscribeCommandTests {
    @Test func defaultsAndFlags() throws {
        #expect(try parseCommand(["transcribe"]) == .transcribe(TranscribeOptions()))
        var want = TranscribeOptions()
        want.dir = "/tmp/cap"
        want.stamp = "20260924-090003"
        want.me = "Joran T"
        want.diarize = false
        want.upload = true
        let got = try parseCommand(["transcribe", "--me", " Joran T ", "/tmp/cap", "--stamp", "20260924-090003", "--no-diarize", "--upload"])
        #expect(got == .transcribe(want))
    }

    @Test func rejectsBadInput() {
        #expect(throws: UsageError.self) { try parseCommand(["transcribe", "--stamp", "2026-09-24"]) }
        #expect(throws: UsageError.self) { try parseCommand(["transcribe", "--stamp"]) }
        #expect(throws: UsageError.self) { try parseCommand(["transcribe", "--me", " "]) }
        #expect(throws: UsageError.self) { try parseCommand(["transcribe", "a", "b"]) }
        #expect(throws: UsageError.self) { try parseCommand(["transcribe", "--bogus"]) }
    }

    @Test func picksRequestedOrNewest() throws {
        let caps = findCaptures(["pa-20260924-090003-mic.wav", "pa-20260925-101500-system.wav"])
        #expect(try pickCapture(caps, stamp: nil, dir: "d").stamp == "20260925-101500")
        #expect(try pickCapture(caps, stamp: "20260924-090003", dir: "d").mic == "pa-20260924-090003-mic.wav")
        #expect(throws: UsageError.self) { try pickCapture(caps, stamp: "20260101-000000", dir: "d") }
        #expect(throws: UsageError.self) { try pickCapture([], stamp: nil, dir: "d") }
        #expect(findCaptures([transcriptFileName(stamp: "20260924-090003")]).isEmpty)
    }

    @Test func segmentLine() {
        #expect(formatSegmentLine(seg(65.9, 70, "Me", "Hi")) == "[1:05] Me: Hi")
        #expect(formatSegmentLine(seg(3725, 3730, nil, "x")) == "[1:02:05] —: x")
    }
}

/// Words spread evenly over [start, end] (first starts at `start`, last ends at `end`).
private func spread(_ text: String, _ start: Double, _ end: Double) -> [TimedWord] {
    let ws = text.split(separator: " ").map(String.init)
    let step = (end - start) / Double(ws.count)
    return ws.enumerated().map { i, w in
        TimedWord(w, start: i == 0 ? start : start + Double(i) * step, end: i == ws.count - 1 ? end : start + Double(i + 1) * step - 0.05)
    }
}

@Suite struct PaUploadFixtureTests {
    /// Engine output → transcribeRecording → makeTranscriptUpload → encode must equal the fixture the server tests use.
    @Test func pipelineProducesServerFixture() async throws {
        let asr = FakeTranscriber(byFile: [
            "mic.wav": spread("Morning! Can everyone hear me?", 0.4, 3.2) + spread("Sure.", 12.9, 14.0),
            "system.wav": spread("Yes, loud and clear.", 3.8, 5.9) + spread("Same here. Let's go through the migration plan.", 6.1, 12.6)
                + spread("Kan iemand de notulen bijhouden?", 14.2, 19.5),
        ])
        // S2 speaks first → "Speaker 1"; last line is >0.5s from any turn → unknown speaker (key omitted).
        let d = FakeDiarizer(turns: [SpeakerTurn("S2", start: 3.7, end: 6.0), SpeakerTurn("S1", start: 6.0, end: 12.7)])
        let t = try await transcribeRecording(
            mic: URL(fileURLWithPath: "/r/mic.wav"), system: URL(fileURLWithPath: "/r/system.wav"),
            transcriber: asr, diarizer: d, micSpeaker: "Alice Example")
        #expect(t.warnings.isEmpty)
        let t2 = Transcription(segments: t.segments, asrModel: "parakeet-tdt-0.6b-v3", diarizationModel: "fluidaudio-offline-vbx-0.17.4", warnings: [])
        let start = try #require(parseCaptureStamp("20260924-090003", timeZone: TimeZone(identifier: "Europe/Brussels")!))
        let u = makeTranscriptUpload(
            id: UUID(uuidString: "3F0E8A52-6C1D-4B8E-9D57-2A4C1E7B9F10")!, startedAt: start, duration: 120, meeting: nil, transcription: t2)
        let got = try JSONSerialization.jsonObject(with: encodeTranscriptUpload(u)) as! NSDictionary
        let want = try JSONSerialization.jsonObject(with: fixture("transcript-upload-pa.json")) as! NSDictionary
        #expect(got == want)
        #expect(got["meeting"] == nil)
    }
}
