import Foundation
import Testing
@testable import PACore

private let t0 = Date(timeIntervalSince1970: 1_790_589_600)
private func at(_ min: Double) -> Date { t0.addingTimeInterval(min * 60) }
private let alice = Person(name: "Alice", email: "alice@corp.com")
private func event(_ id: String, _ from: Double, _ to: Double) -> CalendarEvent {
    CalendarEvent(calendarName: "Calendar", externalId: id, title: id, start: at(from), end: at(to), attendees: [alice])
}
private let n1 = NoteRequest(id: "n1", requestedAt: at(0))
private let n2 = NoteRequest(id: "n2", requestedAt: at(1))

private struct Sim {
    var state = DetectorState()
    var events: [CalendarEvent] = []

    mutating func step(_ min: Double, mic: Bool = false, app: Bool = false, note: NoteRequest? = nil) -> [RecorderAction] {
        let (s, a) = detectStep(state, DetectorInput(now: at(min), events: events, micInUse: mic, meetingAppRunning: app, note: note))
        state = s
        return a
    }
}

private func describe(_ a: [RecorderAction]) -> [String] {
    a.map {
        switch $0 {
        case let .start(e): "start \(e?.externalId ?? "adhoc")"
        case let .attach(e): "attach \(e.externalId)"
        case let .stop(s, r): "stop \(s.note ?? s.event?.externalId ?? "adhoc") \(r.rawValue)"
        case let .discard(s): "discard \(s.event?.externalId ?? "adhoc")"
        case let .startNote(id): "note \(id)"
        case let .clearNoteRequest(id): "clear \(id)"
        }
    }
}

@Suite struct NoteDetectorTests {
    @Test func runsUntilRequestGoes() {
        var sim = Sim()
        #expect(describe(sim.step(0, note: n1)) == ["note n1"])
        // Silence doesn't end a note (no dropout rule): only the request does.
        #expect(describe(sim.step(30, note: n1)) == [])
        #expect(describe(sim.step(31)) == ["stop n1 noteStopped"])
        #expect(sim.state.session == nil)
    }

    @Test func meetingAppWithEventDoesntInterrupt() {
        // Zoom open + meeting in window, but no call (mic free): the user is dictating.
        var sim = Sim(events: [event("A", 0, 30)])
        #expect(describe(sim.step(0, app: true, note: n1)) == ["note n1"])
        #expect(describe(sim.step(5, app: true, note: n1)) == [])
    }

    @Test func callTakesOverAndRequestIsNotResumed() {
        var sim = Sim(events: [event("A", 10, 40)])
        _ = sim.step(0, note: n1)
        #expect(describe(sim.step(9, mic: true, note: n1)) == ["stop n1 meetingStarted", "clear n1", "start A"])
        // Request file still there (daemon hasn't deleted it yet) → not restarted after the call.
        _ = sim.step(30, note: n1)
        _ = sim.step(45, note: n1)
        #expect(describe(sim.step(46, note: n1)).allSatisfy { !$0.hasPrefix("note") })
        #expect(sim.state.session?.note == nil)
    }

    @Test func refusedDuringMeeting() {
        var sim = Sim(events: [event("A", 0, 30)])
        _ = sim.step(0, mic: true)
        #expect(describe(sim.step(5, mic: true, note: n1)) == ["clear n1"])
        #expect(sim.state.session?.event?.externalId == "A")
    }

    @Test func refusedWhenCallStartsSameStep() {
        var sim = Sim()
        #expect(describe(sim.step(0, mic: true, note: n1)) == ["clear n1", "start adhoc"])
    }

    @Test func stopThenStartInOnePollSplits() {
        var sim = Sim()
        _ = sim.step(0, note: n1)
        #expect(describe(sim.step(1, note: n2)) == ["stop n1 noteStopped", "note n2"])
    }

    @Test func expiresAfterMaxDuration() {
        var sim = Sim()
        _ = sim.step(0, note: n1)
        #expect(describe(sim.step(119, note: n1)) == [])
        #expect(describe(sim.step(120, note: n1)) == ["clear n1", "stop n1 noteExpired"])
        #expect(describe(sim.step(121, note: n1)) == [])
    }

    @Test func staleRequestNeverStarts() {
        // File left from yesterday (reboot): cleared, not recorded.
        var sim = Sim()
        #expect(describe(sim.step(600, note: n1)) == ["clear n1"])
    }
}

private func tempDir() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("pa-note-\(UUID().uuidString)", isDirectory: true)
}

@Suite struct NoteRequestStoreTests {
    @Test func startStopClear() throws {
        let s = NoteRequestStore(url: tempDir().appendingPathComponent("note-request.json"))
        #expect(s.load() == nil)
        let r = try s.start(now: at(0))
        #expect(s.load() == r)
        // Start twice = same note.
        #expect(try s.start(now: at(1)) == r)
        // Daemon clearing an older id leaves a newer request alone.
        s.clear(id: "other")
        #expect(s.load() == r)
        s.clear(id: r.id)
        #expect(s.load() == nil)
        let r2 = try s.start(now: at(2))
        #expect(r2.id != r.id)
        #expect(try s.stop() == r2)
        #expect(try s.stop() == nil)
    }

    @Test func garbageFileIsNoRequest() throws {
        let dir = tempDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("note-request.json")
        try Data("{".utf8).write(to: url)
        #expect(NoteRequestStore(url: url).load() == nil)
    }
}

private actor Ticks {
    var n = 0
    func tick() { n += 1 }
}

@Suite struct NoteWaitTests {
    @Test func startSeesSidecarRefusalOrTimeout() async throws {
        let dir = tempDir()
        let notes = NoteRequestStore(url: dir.appendingPathComponent("note-request.json"))
        let recs = RecordingStore(dir: dir.appendingPathComponent("recordings"))
        let r = try notes.start(now: at(0))
        let ticks = Ticks()
        #expect(try await waitForNoteStart(id: r.id, store: notes, recordings: recs, timeout: 3, sleep: { await ticks.tick() }) == .timedOut)
        #expect(await ticks.n == 3)

        let m = RecordingMeta(id: "00000000-0000-4000-8000-000000000001", startedAt: at(0), noteId: r.id)
        try recs.save(m)
        #expect(try await waitForNoteStart(id: r.id, store: notes, recordings: recs, sleep: {}) == .recording(m))

        notes.clear(id: r.id)
        #expect(try await waitForNoteStart(id: "n-other", store: notes, recordings: recs, sleep: {}) == .refused)
    }

    @Test func stopWaitsForEndedAt() async throws {
        let recs = RecordingStore(dir: tempDir())
        var m = RecordingMeta(id: "00000000-0000-4000-8000-000000000001", startedAt: at(0), noteId: "n1")
        try recs.save(m)
        #expect(try await waitForNoteStop(id: "n1", recordings: recs, timeout: 2, sleep: {}) == nil)
        m.endedAt = at(1)
        try recs.save(m)
        #expect(try await waitForNoteStop(id: "n1", recordings: recs, sleep: {}) == .some(m))
        try recs.delete(m.id)
        #expect(try await waitForNoteStop(id: "n1", recordings: recs, sleep: {}) == .some(nil))
    }
}

@Suite struct NoteWireTests {
    @Test func parseNoteCommand() throws {
        #expect(try parseCommand(["note", "toggle"]) == .note(.toggle))
        #expect(throws: UsageError.self) { try parseCommand(["note"]) }
        #expect(throws: UsageError.self) { try parseCommand(["note", "pause"]) }
    }

    @Test func kindOmittedForMeetingsNoteForNotes() throws {
        let t = Transcription(segments: [TranscriptSegment(start: 0, end: 1, speaker: "Me", text: "hi")], asrModel: "m", diarizationModel: nil, warnings: [])
        let enc = JSONEncoder()
        let meeting = try #require(String(data: try enc.encode(makeTranscriptUpload(
            id: UUID(), startedAt: at(0), duration: 1, meeting: nil, transcription: t)), encoding: .utf8))
        #expect(!meeting.contains("kind"))
        let note = try #require(String(data: try enc.encode(makeTranscriptUpload(
            id: UUID(), startedAt: at(0), duration: 1, meeting: nil, kind: .note, transcription: t)), encoding: .utf8))
        #expect(note.contains(#""kind":"note""#))
    }

    @Test func oldSidecarWithoutNoteIdDecodes() throws {
        let json = #"{"id":"x","startedAt":"2026-09-28T10:00:00Z","attempts":0}"#
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        #expect(try d.decode(RecordingMeta.self, from: Data(json.utf8)).noteId == nil)
    }
}
