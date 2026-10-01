import Foundation
import Testing
@testable import PACore

private let t0 = Date(timeIntervalSince1970: 1_790_589_600)
private func at(_ min: Double) -> Date { t0.addingTimeInterval(min * 60) }
private let alice = Person(name: "Alice", email: "alice@corp.com")

private func event(_ id: String, _ from: Double, _ to: Double) -> CalendarEvent {
    CalendarEvent(calendarName: "Work", externalId: id, title: "T \(id)", start: at(from), end: at(to), attendees: [alice])
}

private func tempStore() -> RecordingStore {
    RecordingStore(dir: FileManager.default.temporaryDirectory.appendingPathComponent("pa-rec-\(UUID().uuidString)", isDirectory: true))
}

/// Writes a byte to each file it "records", like a real capture would.
private final class FakeRecorder: AudioRecorder {
    var failStart = false
    var warnings: [String] = []
    private(set) var started: [URL] = []
    private(set) var stops = 0

    func start(mic: URL, system: URL) throws {
        if failStart { throw UsageError("no tap") }
        for u in [mic, system] { try Data([1]).write(to: u) }
        started = [mic, system]
    }

    func stop() -> [String] {
        stops += 1
        return warnings
    }
}

private final class Harness {
    let store = tempStore()
    var recorders: [FakeRecorder] = []
    var logs: [String] = []
    var finished = 0
    var failNextStart = false
    var ids = 0
    lazy var c: RecordingController = {
        let c = RecordingController(
            store: store,
            makeRecorder: { [unowned self] in
                let r = FakeRecorder()
                r.failStart = failNextStart
                failNextStart = false
                recorders.append(r)
                return r
            },
            log: { [unowned self] in logs.append($0) },
            newID: { [unowned self] in
                ids += 1
                return UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", ids))!
            })
        c.onFinished = { [unowned self] in finished += 1 }
        return c
    }()

    func step(_ min: Double, mic: Bool, app: Bool = false, events: [CalendarEvent] = []) {
        c.step(DetectorInput(now: at(min), events: events, micInUse: mic, meetingAppRunning: app))
    }

    func metas() throws -> [RecordingMeta] { try store.all().items }
}

private func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
private func noAudio(_ s: RecordingStore, _ n: Int) -> Bool { s.audio(id(n)).mic == nil && s.audio(id(n)).system == nil }

@Suite struct RecordingControllerTests {
    @Test func meetingRecordedWithSidecar() throws {
        let h = Harness()
        let e = event("e1", 0, 30)
        h.step(0, mic: true, events: [e])
        #expect(h.c.isRecording)
        // Sidecar exists from the start (crash-safe), no endedAt yet.
        var m = try #require(try h.metas().first)
        #expect(m.id == id(1))
        #expect(m.endedAt == nil)
        #expect(m.meeting?.eventId == "e1")
        #expect(h.recorders[0].started == [h.store.micURL(id(1)), h.store.systemURL(id(1))])

        // Event extended while recording → stop stores the latest snapshot.
        var longer = e
        longer.end = at(45)
        h.step(20, mic: true, events: [longer])
        h.step(21, mic: false, events: [longer])
        #expect(h.c.isRecording)
        h.step(22.5, mic: false, events: [longer])
        #expect(!h.c.isRecording)
        m = try #require(try h.metas().first)
        #expect(m.endedAt == at(22.5))
        #expect(m.meeting?.end == isoTimestamp(at(45)))
        #expect(h.recorders[0].stops == 1)
        #expect(h.finished == 1)
    }

    @Test func shortRecordingDiscarded() throws {
        let h = Harness()
        h.step(0, mic: true)
        h.step(0.5, mic: false)
        h.step(3, mic: false)
        #expect(!h.c.isRecording)
        #expect(try h.metas().isEmpty)
        #expect(noAudio(h.store, 1))
        #expect(h.finished == 0)
    }

    @Test func adHocAttachedToEvent() throws {
        let e = event("e1", 10, 40)
        let h = Harness()
        h.step(0, mic: true, events: [e])
        #expect(try h.metas().first?.meeting == nil)
        h.step(6, mic: true, events: [e])
        // Relabelled in place: same recording, no split.
        #expect(h.recorders.count == 1)
        #expect(try h.metas().map(\.meeting?.eventId) == ["e1"])
    }

    @Test func backToBackSplitsIntoTwoRecordings() throws {
        let h = Harness()
        let a = event("a", 0, 30)
        let b = event("b", 30, 60)
        h.step(0, mic: true, events: [a, b])
        h.step(30, mic: true, events: [a, b])
        #expect(h.recorders.count == 2)
        #expect(h.recorders[0].stops == 1)
        let ms = try h.metas()
        #expect(ms.map(\.meeting?.eventId) == ["a", "b"])
        #expect(ms[0].endedAt == at(30))
        #expect(ms[1].endedAt == nil)
    }

    @Test func captureFailureKeepsSessionWithoutAudio() throws {
        let h = Harness()
        h.failNextStart = true
        h.step(0, mic: true)
        #expect(h.logs.contains { $0.contains("capture failed to start") })
        h.step(5, mic: true)
        h.step(6, mic: false)
        h.step(8, mic: false)
        // Stopped normally; processor will drop it (no audio).
        #expect(try h.metas().first?.endedAt == at(8))
        #expect(noAudio(h.store, 1))
    }

    @Test func recorderWarningsLogged() {
        let h = Harness()
        h.step(0, mic: true)
        h.recorders[0].warnings = ["system: all zeros"]
        h.step(5, mic: true)
        h.step(6, mic: false)
        h.step(8, mic: false)
        #expect(h.logs.contains { $0.contains("⚠️ system: all zeros") })
    }

    @Test func shutdownKeepsOrDiscards() throws {
        let h = Harness()
        h.step(0, mic: true)
        h.step(5, mic: true)
        h.c.shutdown(now: at(5.5))
        #expect(!h.c.isRecording)
        #expect(try h.metas().first?.endedAt == at(5.5))
        #expect(h.finished == 1)

        let h2 = Harness()
        h2.step(0, mic: true)
        h2.c.shutdown(now: at(0.5))
        #expect(try h2.metas().isEmpty)
        // Idempotent.
        h2.c.shutdown(now: at(1))
    }
}

private actor Calls {
    var transcribed: [(URL?, URL?)] = []
    var enqueued: [TranscriptUpload] = []
    var logs: [String] = []
    var failTranscribe = false
    var segments = [TranscriptSegment(start: 0, end: 1, speaker: "Me", text: "hallo")]

    func setFail(_ f: Bool) { failTranscribe = f }
    func setSegments(_ s: [TranscriptSegment]) { segments = s }
    func log(_ s: String) { logs.append(s) }

    func transcribe(_ mic: URL?, _ system: URL?) throws -> Transcription {
        transcribed.append((mic, system))
        if failTranscribe { throw UsageError("model download failed") }
        return Transcription(segments: segments, asrModel: "asr", diarizationModel: nil, warnings: ["diarization failed"])
    }

    func enqueue(_ u: TranscriptUpload) { enqueued.append(u) }
}

private func processor(_ store: RecordingStore, _ calls: Calls, keep: Int? = nil) -> RecordingProcessor {
    RecordingProcessor(
        store: store, transcribe: { try await calls.transcribe($0, $1) }, enqueue: { await calls.enqueue($0) },
        keepAudioDays: { keep }, log: { s in Task { await calls.log(s) } }, now: { at(100) })
}

private func finishedRecording(_ store: RecordingStore, _ n: Int, meeting: MeetingMeta? = nil, mic: Bool = true, system: Bool = true) throws {
    try store.save(RecordingMeta(id: id(n), startedAt: at(Double(n)), endedAt: at(Double(n) + 30), meeting: meeting))
    if mic { try Data([1]).write(to: store.micURL(id(n))) }
    if system { try Data([1]).write(to: store.systemURL(id(n))) }
}

@Suite struct RecordingProcessorTests {
    @Test func transcribesQueuesAndDeletesAudio() async throws {
        let store = tempStore()
        let calls = Calls()
        let meeting = meetingMeta(event("e1", 0, 30))
        try finishedRecording(store, 1, meeting: meeting)
        try finishedRecording(store, 2, system: false)
        // Still recording → untouched.
        try store.save(RecordingMeta(id: id(3), startedAt: at(50)))

        await processor(store, calls).processPending()

        let up = await calls.enqueued
        #expect(up.map(\.id) == [id(1), id(2)])
        #expect(up[0].meeting == meeting)
        #expect(up[0].startedAt == isoTimestamp(at(1)))
        #expect(up[0].endedAt == isoTimestamp(at(31)))
        #expect(up[1].meeting == nil)
        let t = await calls.transcribed
        #expect(t[1].0 == store.micURL(id(2)) && t[1].1 == nil)
        #expect(noAudio(store, 1))
        #expect(try store.all().items.map(\.id) == [id(3)])
    }

    @Test func failureRetriedThenParked() async throws {
        let store = tempStore()
        let calls = Calls()
        await calls.setFail(true)
        try finishedRecording(store, 1)
        let p = processor(store, calls)
        for _ in 0..<5 { await p.processPending() }
        // maxAttempts transcriptions, then parked: audio + sidecar kept, error recorded.
        #expect(await calls.transcribed.count == RecordingLimits.maxAttempts)
        let m = try #require(try store.all().items.first)
        #expect(m.attempts == RecordingLimits.maxAttempts)
        #expect(m.lastError?.contains("model download failed") == true)
        #expect(store.audio(id(1)).mic != nil)
        #expect(try p.ready().isEmpty)
        #expect(formatRecordingLine(m).hasPrefix("recording \(id(1)) failed attempts=3"))
        #expect(await calls.enqueued.isEmpty)
    }

    @Test func attemptCountedBeforeTranscribing() async throws {
        // A crash inside transcribe must still count: check the sidecar while transcribe runs.
        let store = tempStore()
        try finishedRecording(store, 1)
        let seen = Calls()
        let p = RecordingProcessor(
            store: store,
            transcribe: { _, _ in
                await seen.log("attempts=\(try store.all().items.first?.attempts ?? -1)")
                return Transcription(segments: [], asrModel: "a", diarizationModel: nil, warnings: [])
            },
            enqueue: { _ in }, keepAudioDays: { nil }, log: { _ in })
        await p.processPending()
        #expect(await seen.logs == ["attempts=1"])
    }

    @Test func noSpeechNotUploaded() async throws {
        let store = tempStore()
        let calls = Calls()
        await calls.setSegments([])
        try finishedRecording(store, 1)
        await processor(store, calls).processPending()
        #expect(await calls.enqueued.isEmpty)
        #expect(try store.all().items.isEmpty)
    }

    @Test func noAudioDropped() async throws {
        let store = tempStore()
        let calls = Calls()
        try finishedRecording(store, 1, mic: false, system: false)
        await processor(store, calls).processPending()
        #expect(await calls.transcribed.isEmpty)
        #expect(try store.all().items.isEmpty)
    }

    @Test func keepAudioThenPrune() async throws {
        let store = tempStore()
        let calls = Calls()
        try finishedRecording(store, 1)
        await processor(store, calls, keep: 7).processPending()
        let kept = try FileManager.default.contentsOfDirectory(atPath: store.keptDir.path).sorted()
        #expect(kept == ["\(id(1))-mic.wav", "\(id(1))-system.wav"])
        #expect(try store.all().items.isEmpty)
        // Kept at at(100); 6 days later stays, 8 days later goes.
        #expect(try store.pruneKept(days: 7, now: at(100 + 6 * 1440)).isEmpty)
        #expect(try store.pruneKept(days: 7, now: at(100 + 8 * 1440)).count == 2)
        // Setting removed → kept audio deleted right away.
        try finishedRecording(store, 2)
        await processor(store, calls, keep: 7).processPending()
        #expect(try store.pruneKept(days: nil, now: at(101)).count == 2)
    }

    @Test func recoverInterruptedUsesLastWrite() throws {
        let store = tempStore()
        try store.save(RecordingMeta(id: id(1), startedAt: at(0)))
        try Data([1]).write(to: store.micURL(id(1)))
        try FileManager.default.setAttributes([.modificationDate: at(25)], ofItemAtPath: store.micURL(id(1)).path)
        try store.save(RecordingMeta(id: id(2), startedAt: at(40)))
        try store.save(RecordingMeta(id: id(3), startedAt: at(50), endedAt: at(60)))
        let fixed = try store.recoverInterrupted()
        #expect(fixed.map(\.id) == [id(1), id(2)])
        let ms = try store.all().items
        #expect(ms.map(\.endedAt) == [at(25), at(40), at(60)])
    }

    @Test func unreadableSidecarReportedNotTouched() throws {
        let store = tempStore()
        try finishedRecording(store, 1)
        let bad = store.dir.appendingPathComponent("junk.json")
        try Data("nope".utf8).write(to: bad)
        let (items, unreadable) = try store.all()
        #expect(items.map(\.id) == [id(1)])
        #expect(unreadable == ["junk.json"])
        #expect(FileManager.default.fileExists(atPath: bad.path))
    }
}
