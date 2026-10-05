import Foundation
import Testing
@testable import PACore
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

private let t0 = Date(timeIntervalSince1970: 1_790_589_600)
private func at(_ min: Double) -> Date { t0.addingTimeInterval(min * 60) }
private let alice = Person(name: "Alice", email: "alice@corp.com")
private func event(_ id: String, _ from: Double, _ to: Double) -> CalendarEvent {
    CalendarEvent(calendarName: "Calendar", externalId: id, title: id, start: at(from), end: at(to), attendees: [alice])
}
private let n1 = NoteRequest(id: "n1", requestedAt: at(0))

private struct Sim {
    var state = DetectorState()
    var events: [CalendarEvent] = []

    mutating func step(_ min: Double, mic: Bool = false, app: Bool = false, note: NoteRequest? = nil, paused: Bool = false) -> [String] {
        let (s, a) = detectStep(state, DetectorInput(now: at(min), events: events, micInUse: mic, meetingAppRunning: app, note: note, paused: paused))
        state = s
        return a.map {
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
}

@Suite struct PauseDetectorTests {
    @Test func pauseStopsAndKeepsMeeting() {
        var sim = Sim(events: [event("e", 0, 30)])
        #expect(sim.step(0, mic: true) == ["start e"])
        #expect(sim.step(5, mic: true) == [])
        #expect(sim.step(5.5, mic: true, paused: true) == ["stop e paused"])
        #expect(sim.state.session == nil)
        // Call still going: nothing restarts while paused.
        #expect(sim.step(6, mic: true, app: true, paused: true) == [])
        // Resume mid-call: mic restarts it, linked to the event again.
        #expect(sim.step(7, mic: true) == ["start e"])
    }

    @Test func pauseRightAfterStartDiscards() {
        var sim = Sim(events: [event("e", 0, 30)])
        #expect(sim.step(0, mic: true) == ["start e"])
        #expect(sim.step(0.5, mic: true, paused: true) == ["discard e"])
    }

    @Test func noStartWhilePaused() {
        var sim = Sim(events: [event("e", 0, 30)])
        #expect(sim.step(0, mic: true, app: true, paused: true) == [])
        #expect(sim.step(1, mic: true, paused: true) == [])
    }

    @Test func appAloneDoesNotRestartAfterResume() {
        var sim = Sim(events: [event("e", 0, 30)])
        #expect(sim.step(0, app: true) == ["start e"])
        #expect(sim.step(2, app: true) == [])
        #expect(sim.step(2.5, app: true, paused: true) == ["stop e paused"])
        #expect(sim.step(3, app: true) == [])
    }

    @Test func notesWorkWhilePaused() {
        var sim = Sim()
        #expect(sim.step(0, note: n1, paused: true) == ["note n1"])
        #expect(sim.step(1, note: n1, paused: true) == [])
        #expect(sim.step(2, paused: true) == ["stop n1 noteStopped"])
    }

    @Test func noteInSamePollAsPauseReplacesMeeting() {
        var sim = Sim(events: [event("e", 0, 30)])
        #expect(sim.step(0, app: true) == ["start e"])
        #expect(sim.step(1.5, app: true) == [])
        #expect(sim.step(2, app: true, note: n1, paused: true) == ["stop e paused", "note n1"])
    }

    @Test func callEndingNoteIsNotRecordedWhilePaused() {
        var sim = Sim(events: [event("e", 0, 30)])
        #expect(sim.step(0, note: n1, paused: true) == ["note n1"])
        #expect(sim.step(1, mic: true, note: n1, paused: true) == ["stop n1 meetingStarted", "clear n1"])
        #expect(sim.state.session == nil)
    }
}

private func tempDir() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("pa-pause-\(UUID().uuidString)", isDirectory: true)
}

@Suite struct PauseStoreTests {
    @Test func pauseResume() throws {
        let s = PauseStore(url: tempDir().appendingPathComponent("pause.json"))
        #expect(s.load() == nil)
        #expect(try s.pause(now: at(0)) == PauseRequest(pausedAt: at(0)))
        // Second pause keeps the original time.
        #expect(try s.pause(now: at(5)) == PauseRequest(pausedAt: at(0)))
        #expect(s.load() == PauseRequest(pausedAt: at(0)))
        #expect(try s.resume() == PauseRequest(pausedAt: at(0)))
        #expect(s.load() == nil)
        #expect(try s.resume() == nil)
    }

    @Test func garbageMeansNotPaused() throws {
        let dir = tempDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("pause.json")
        try Data("nope".utf8).write(to: url)
        #expect(PauseStore(url: url).load() == nil)
    }
}

@Suite struct AgentPathsTests {
    @Test func layout() {
        let p = AgentPaths(base: URL(fileURLWithPath: "/x"))
        #expect(p.config.path == "/x/config.json")
        #expect(p.recordings.path == "/x/recordings")
        #expect(p.uploadQueue.path == "/x/upload-queue")
        #expect(p.noteRequest.path == "/x/note-request.json")
        #expect(p.pause.path == "/x/pause.json")
        #expect(p.runLock.path == "/x/run.lock")
        #expect(AgentPaths.default.base.path.hasSuffix("Library/Application Support/com.bitofant.pa"))
    }

    @Test func lockProbe() {
        let lock = tempDir().appendingPathComponent("run.lock")
        #expect(!daemonIsRunning(lock: lock))
        let fd = open(lock.path, O_RDWR | O_CREAT, 0o644)
        #expect(fd >= 0)
        #expect(flock(fd, LOCK_EX | LOCK_NB) == 0)
        #expect(daemonIsRunning(lock: lock))
        close(fd)
        #expect(!daemonIsRunning(lock: lock))
    }
}

@Suite struct MenuStatusTests {
    private func status(running: Bool = true, _ recs: [RecordingMeta] = [], note: NoteRequest? = nil, pause: PauseRequest? = nil, now: Double = 12.5) -> MenuStatus {
        menuStatus(daemonRunning: running, recordings: recs, note: note, pause: pause, pendingUploads: 2, failedUploads: 0, now: at(now))
    }

    private let meeting = RecordingMeta(id: "m", startedAt: at(0), meeting: meetingMeta(event("Standup", 0, 30)))
    private let adhoc = RecordingMeta(id: "a", startedAt: at(0))
    private let noteRec = RecordingMeta(id: "n", startedAt: at(10), noteId: "n1")

    @Test func states() {
        #expect(status().state == .idle)
        #expect(status().headline == "Watching for meetings")
        #expect(status().pendingUploads == 2)
        let m = status([meeting])
        #expect(m.headline == "Recording: Standup · 12 min" && m.symbolName == "record.circle.fill")
        #expect(status([adhoc]).headline == "Recording: ad-hoc call · 12 min")
        #expect(status([noteRec], note: n1).headline == "Recording note · 2 min")
        #expect(status([noteRec], note: n1).noteRequested)
        let p = status(pause: PauseRequest(pausedAt: at(0)))
        #expect(p.state == .paused && p.paused && p.symbolName == "pause.circle")
    }

    @Test func recordingBeatsPaused() {
        let s = status([noteRec], note: n1, pause: PauseRequest(pausedAt: at(0)))
        #expect(s.state == .note(since: at(10)))
        #expect(s.paused && s.headline == "Recording note · 2 min (meetings paused)")
        #expect(status(running: false, pause: PauseRequest(pausedAt: at(0))).headline == "pa run isn't running (meetings paused)")
    }

    @Test func endedAndStaleSidecarsIgnored() {
        var ended = meeting
        ended.endedAt = at(5)
        #expect(status([ended]).state == .idle)
        // Open sidecar without a daemon = crash leftover, not a live recording.
        #expect(status(running: false, [meeting]).state == .notRunning)
        #expect(status(running: false).headline == "pa run isn't running")
    }

    @Test func readsFilesWithoutTouchingThem() throws {
        let paths = AgentPaths(base: tempDir())
        let fm = FileManager.default
        try fm.createDirectory(at: paths.uploadQueue.appendingPathComponent("failed"), withIntermediateDirectories: true)
        // Corrupt queue file: `UploadQueueStore.load` would move it to failed/; a status read must not.
        try Data("x".utf8).write(to: paths.uploadQueue.appendingPathComponent("a.json"))
        try Data("x".utf8).write(to: paths.uploadQueue.appendingPathComponent(".tmp.json"))
        try Data("x".utf8).write(to: paths.uploadQueue.appendingPathComponent("failed/b.json"))
        try RecordingStore(dir: paths.recordings).save(meeting)
        try PauseStore(url: paths.pause).pause(now: at(0))
        let s = readMenuStatus(paths, now: at(1))
        #expect(s.pendingUploads == 1 && s.failedUploads == 1)
        #expect(fm.fileExists(atPath: paths.uploadQueue.appendingPathComponent("a.json").path))
        // No daemon holds run.lock → open sidecar ignored.
        #expect(s.state == .notRunning && s.paused)
    }

    @Test func refusedNote() {
        #expect(!noteWasRefused(id: "n1", note: n1, recordings: []))
        #expect(!noteWasRefused(id: "n1", note: nil, recordings: [noteRec]))
        #expect(noteWasRefused(id: "n1", note: nil, recordings: []))
        #expect(noteWasRefused(id: "n1", note: NoteRequest(id: "n2", requestedAt: at(1)), recordings: []))
    }
}
