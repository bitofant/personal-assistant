import Foundation

// `pa run` recordings: detector actions → audio files + sidecar → transcript → upload queue. Audio I/O and ASR are
// injected (`AudioRecorder`, transcribe/enqueue closures) → the whole flow is Linux-tested with fakes.

/// Sidecar `<id>.json` next to `<id>-{mic,system}.wav`. Written at start → a crash mid-recording loses nothing.
public struct RecordingMeta: Codable, Equatable, Sendable {
    /// Lowercase UUID = upload id = file name base (unique even for two starts in one second).
    public var id: String
    public var startedAt: Date
    /// nil = still recording, or interrupted (`recoverInterrupted` fills it in at the next start).
    public var endedAt: Date?
    /// nil = ad-hoc.
    public var meeting: MeetingMeta?
    /// Spoken note (`pa note`): its request id; nil = meeting/call. Uploaded as `kind: note`.
    public var noteId: String?
    /// Counted *before* each transcription → a recording that crashes pa can't crash-loop it forever.
    public var attempts: Int
    public var lastError: String?

    public init(
        id: String, startedAt: Date, endedAt: Date? = nil, meeting: MeetingMeta? = nil, noteId: String? = nil,
        attempts: Int = 0, lastError: String? = nil
    ) {
        self.id = id
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.meeting = meeting
        self.noteId = noteId
        self.attempts = attempts
        self.lastError = lastError
    }
}

public enum RecordingLimits {
    /// Transcription attempts before a recording is parked (audio + sidecar kept, see `pa queue`).
    public static let maxAttempts = 3
}

public struct RecordingStore: Sendable {
    public let dir: URL
    /// Audio kept after transcription (`keepAudioDays`), pruned by age.
    public var keptDir: URL { dir.appendingPathComponent("kept", isDirectory: true) }

    public init(dir: URL) { self.dir = dir }

    public func metaURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).json") }
    public func micURL(_ id: String) -> URL { dir.appendingPathComponent("\(id)-mic.wav") }
    public func systemURL(_ id: String) -> URL { dir.appendingPathComponent("\(id)-system.wav") }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    public func save(_ m: RecordingMeta) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Self.encoder.encode(m).write(to: metaURL(m.id), options: .atomic)
    }

    /// All sidecars, oldest first; unreadable ones reported by file name (left alone: may hold the only meeting info).
    public func all() throws -> (items: [RecordingMeta], unreadable: [String]) {
        guard FileManager.default.fileExists(atPath: dir.path) else { return ([], []) }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        var items: [RecordingMeta] = []
        var bad: [String] = []
        for name in try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted() where name.hasSuffix(".json") {
            if let m = try? d.decode(RecordingMeta.self, from: Data(contentsOf: dir.appendingPathComponent(name))) {
                items.append(m)
            } else {
                bad.append(name)
            }
        }
        return (items.sorted { ($0.startedAt, $0.id) < ($1.startedAt, $1.id) }, bad)
    }

    /// Existing audio files (either stream may be missing: mic/tap failed to start).
    public func audio(_ id: String) -> (mic: URL?, system: URL?) {
        let exists = { (u: URL) in FileManager.default.fileExists(atPath: u.path) ? u : nil }
        return (exists(micURL(id)), exists(systemURL(id)))
    }

    public func delete(_ id: String) throws {
        for u in [micURL(id), systemURL(id), metaURL(id)] where FileManager.default.fileExists(atPath: u.path) {
            try FileManager.default.removeItem(at: u)
        }
    }

    /// Audio → kept/ (mtime = now, for pruning), sidecar removed.
    public func keep(_ id: String, now: Date) throws {
        try FileManager.default.createDirectory(at: keptDir, withIntermediateDirectories: true)
        let (mic, system) = audio(id)
        for u in [mic, system].compactMap({ $0 }) {
            let dst = keptDir.appendingPathComponent(u.lastPathComponent)
            if FileManager.default.fileExists(atPath: dst.path) { try FileManager.default.removeItem(at: dst) }
            try FileManager.default.moveItem(at: u, to: dst)
            try FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: dst.path)
        }
        try delete(id)
    }

    /// Deletes kept audio older than `days`. Returns deleted file names.
    @discardableResult
    public func pruneKept(days: Int?, now: Date) throws -> [String] {
        guard FileManager.default.fileExists(atPath: keptDir.path) else { return [] }
        let cutoff = now.addingTimeInterval(-Double(days ?? 0) * 86400)
        var gone: [String] = []
        for name in try FileManager.default.contentsOfDirectory(atPath: keptDir.path).sorted() where name.hasSuffix(".wav") {
            let u = keptDir.appendingPathComponent(name)
            let mtime = (try? FileManager.default.attributesOfItem(atPath: u.path)[.modificationDate] as? Date) ?? .distantPast
            if mtime < cutoff {
                try FileManager.default.removeItem(at: u)
                gone.append(name)
            }
        }
        return gone
    }

    /// Recordings a previous pa process never stopped (crash, kill -9, reboot): end = last audio write (else start).
    /// Call once at start, before recording anything.
    @discardableResult
    public func recoverInterrupted() throws -> [RecordingMeta] {
        var fixed: [RecordingMeta] = []
        for var m in try all().items where m.endedAt == nil {
            let (mic, system) = audio(m.id)
            let mtimes = [mic, system].compactMap { $0 }.compactMap {
                try? FileManager.default.attributesOfItem(atPath: $0.path)[.modificationDate] as? Date
            }
            m.endedAt = max(mtimes.max() ?? m.startedAt, m.startedAt)
            try save(m)
            fixed.append(m)
        }
        return fixed
    }
}

/// Mic + system audio capture into two files (`pa`: AVAudioEngine + Core Audio tap).
public protocol AudioRecorder: AnyObject {
    /// May start only one stream (the other failing is logged by the implementation); throws if neither starts.
    /// system nil = mic only (spoken note: no tap, so nothing playing on the Mac ends up in the note).
    func start(mic: URL, system: URL?) throws
    /// Idempotent. Returns problems worth logging (all-zero stream = permission missing, write errors).
    func stop() -> [String]
    /// Live preview hooks (default no-op). `prepare`: right before `start`, with the sidecar.
    func prepare(_ meta: RecordingMeta)
    /// Ad-hoc call relabelled / event snapshot refreshed.
    func meetingChanged(_ meeting: MeetingMeta?)
    /// Right before `stop()` when the recording is thrown away (too short): drop its preview too.
    func willDiscard()
}

public extension AudioRecorder {
    func prepare(_ meta: RecordingMeta) {}
    func meetingChanged(_ meeting: MeetingMeta?) {}
    func willDiscard() {}
}

/// Executes `detectStep` actions. Not thread-safe: `pa` drives it from the main actor only.
public final class RecordingController {
    public let store: RecordingStore
    public let timing: DetectionTiming
    public private(set) var state = DetectorState()
    private let makeRecorder: () -> any AudioRecorder
    private let log: (String) -> Void
    private let newID: () -> UUID
    /// Recording in progress (sidecar id + capture; capture nil = failed to start).
    private var current: (meta: RecordingMeta, recorder: (any AudioRecorder)?)?
    /// Called after a recording is kept (stopped, sidecar has endedAt): wake the transcription loop.
    public var onFinished: () -> Void = {}
    /// Note request handled (`clearNoteRequest`): delete the request file if it still holds this id.
    public var onClearNoteRequest: (String) -> Void = { _ in }

    public init(
        store: RecordingStore, timing: DetectionTiming = DetectionTiming(), makeRecorder: @escaping () -> any AudioRecorder,
        log: @escaping (String) -> Void, newID: @escaping () -> UUID = { UUID() }
    ) {
        self.store = store
        self.timing = timing
        self.makeRecorder = makeRecorder
        self.log = log
        self.newID = newID
    }

    public var isRecording: Bool { current != nil }

    public func step(_ input: DetectorInput) {
        let (next, actions) = detectStep(state, input, timing: timing)
        state = next
        for a in actions { execute(a, now: input.now) }
    }

    /// SIGTERM / shutdown: keep what was recorded (≥ minActive) instead of leaving it for crash recovery.
    public func shutdown(now: Date) {
        guard let s = state.session else { return }
        state.session = nil
        // Note request file stays: the restarted daemon resumes the note (until noteMaxDuration).
        if s.note == nil && s.lastActiveAt.timeIntervalSince(s.startedAt) < timing.minActive {
            execute(.discard(s), now: now)
        } else {
            execute(.stop(s, .inactive), now: now)
        }
    }

    private func execute(_ a: RecorderAction, now: Date) {
        switch a {
        case .start(let event):
            begin(RecordingMeta(id: newID().uuidString.lowercased(), startedAt: now, meeting: event.map(meetingMeta)))
        case .startNote(let noteId):
            begin(RecordingMeta(id: newID().uuidString.lowercased(), startedAt: now, noteId: noteId))
        case .clearNoteRequest(let noteId):
            onClearNoteRequest(noteId)
        case .attach(let event):
            guard var c = current else { return }
            c.meta.meeting = meetingMeta(event)
            current = c
            c.recorder?.meetingChanged(c.meta.meeting)
            try? store.save(c.meta)
            log("recording \(c.meta.id) belongs to \(describeMeeting(c.meta.meeting))")
        case .stop(let session, let reason):
            // Before stop: the preview's end marker carries the final event snapshot.
            current?.recorder?.meetingChanged(session.event.map(meetingMeta))
            guard var c = finishCapture() else { return }
            // Latest snapshot: moved/extended events were refreshed by the detector.
            c.meta.meeting = session.event.map(meetingMeta)
            c.meta.endedAt = now
            do {
                try store.save(c.meta)
                log("recording \(c.meta.id) stopped (\(reason.rawValue)), \(Int(now.timeIntervalSince(c.meta.startedAt)))s")
                onFinished()
            } catch {
                // Sidecar without endedAt → picked up by recoverInterrupted at the next start.
                log("recording \(c.meta.id) stopped, ⚠️ can't update sidecar: \(error)")
            }
        case .discard:
            current?.recorder?.willDiscard()
            guard let c = finishCapture() else { return }
            do { try store.delete(c.meta.id) } catch { log("recording \(c.meta.id): ⚠️ delete failed: \(error)") }
            log("recording \(c.meta.id) discarded (too short)")
        }
    }

    private func begin(_ meta: RecordingMeta) {
        let id = meta.id
        do { try store.save(meta) } catch {
            // Not recording without a sidecar: audio we can't attribute/recover would just pile up.
            log("recording: can't write \(store.metaURL(id).path): \(error) → not recording")
            current = (meta, nil)
            return
        }
        let r = makeRecorder()
        r.prepare(meta)
        do {
            try r.start(mic: store.micURL(id), system: meta.noteId == nil ? store.systemURL(id) : nil)
            current = (meta, r)
            log("recording \(id) started: \(meta.noteId == nil ? describeMeeting(meta.meeting) : "spoken note (mic only)")")
        } catch {
            _ = r.stop()
            current = (meta, nil)
            log("recording \(id): ⚠️ capture failed to start: \(error)")
        }
    }

    private func finishCapture() -> (meta: RecordingMeta, recorder: (any AudioRecorder)?)? {
        guard let c = current else { return nil }
        current = nil
        for w in c.recorder?.stop() ?? [] { log("recording \(c.meta.id): ⚠️ \(w)") }
        return c
    }
}

public func describeMeeting(_ m: MeetingMeta?) -> String {
    guard let m else { return "ad-hoc" }
    return "\"\(m.title ?? "(untitled)")\" (\(m.calendarName ?? "—"), \(m.attendees.count) attendees)"
}

/// Finished recording → transcript → upload queue → audio deleted/kept.
public struct RecordingProcessor: Sendable {
    public typealias Transcribe = @Sendable (_ mic: URL?, _ system: URL?) async throws -> Transcription
    public typealias Enqueue = @Sendable (TranscriptUpload) async throws -> Void

    public let store: RecordingStore
    private let transcribe: Transcribe
    private let enqueue: Enqueue
    private let keepAudioDays: @Sendable () -> Int?
    private let log: @Sendable (String) -> Void
    private let now: @Sendable () -> Date

    public init(
        store: RecordingStore, transcribe: @escaping Transcribe, enqueue: @escaping Enqueue,
        keepAudioDays: @escaping @Sendable () -> Int?, log: @escaping @Sendable (String) -> Void,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.store = store
        self.transcribe = transcribe
        self.enqueue = enqueue
        self.keepAudioDays = keepAudioDays
        self.log = log
        self.now = now
    }

    /// Finished recordings below `maxAttempts`, oldest first. The one still recording (no endedAt) is skipped.
    public func ready() throws -> [RecordingMeta] {
        try store.all().items.filter { $0.endedAt != nil && $0.attempts < RecordingLimits.maxAttempts }
    }

    /// Processes everything ready, one at a time; then prunes kept audio. Never throws: errors are logged + retried.
    public func processPending() async {
        do {
            for m in try ready() {
                if Task.isCancelled { return }
                await process(m)
            }
            for name in try store.pruneKept(days: keepAudioDays(), now: now()) { log("deleted kept audio \(name)") }
        } catch {
            log("recordings: \(error)")
        }
    }

    public func process(_ meta: RecordingMeta) async {
        var m = meta
        let (mic, system) = store.audio(m.id)
        guard mic != nil || system != nil else {
            log("recording \(m.id): no audio (capture never started) → dropped")
            try? store.delete(m.id)
            return
        }
        m.attempts += 1
        do { try store.save(m) } catch {
            log("recording \(m.id): can't update sidecar: \(error)")
            return
        }
        do {
            let t = try await transcribe(mic, system)
            for w in t.warnings { log("recording \(m.id): ⚠️ \(w)") }
            if t.segments.isEmpty {
                // Window with the meeting app open but nobody talking (meeting skipped): nothing worth a transcript.
                log("recording \(m.id): no speech → not uploaded")
            } else {
                let end = m.endedAt ?? m.startedAt
                let upload = makeTranscriptUpload(
                    id: UUID(uuidString: m.id) ?? UUID(), startedAt: m.startedAt,
                    duration: max(0, end.timeIntervalSince(m.startedAt)), meeting: m.meeting,
                    kind: m.noteId == nil ? nil : .note, transcription: t)
                // Queue persists before returning → safe to drop the audio after.
                try await enqueue(upload)
                log("recording \(m.id): \(upload.segments.count) segments queued for upload")
            }
        } catch {
            m.lastError = "\(error)"
            try? store.save(m)
            let parked = m.attempts >= RecordingLimits.maxAttempts
            log("recording \(m.id): transcription failed (attempt \(m.attempts)): \(error)"
                + (parked ? " → giving up; audio kept in \(store.dir.path)" : ""))
            return
        }
        do {
            if let days = keepAudioDays(), days > 0 { try store.keep(m.id, now: now()) } else { try store.delete(m.id) }
        } catch {
            log("recording \(m.id): ⚠️ cleanup failed: \(error)")
        }
    }
}

/// `pa queue` line for a recording not yet transcribed: `recording <id> <state> attempts=N <lastError|—>`.
public func formatRecordingLine(_ m: RecordingMeta) -> String {
    let state = m.endedAt == nil ? "recording" : m.attempts >= RecordingLimits.maxAttempts ? "failed" : "to-transcribe"
    return "recording \(m.id)\(m.noteId == nil ? "" : " note") \(state) attempts=\(m.attempts) \(m.lastError ?? "—")"
}
