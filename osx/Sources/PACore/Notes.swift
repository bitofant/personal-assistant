import Foundation

// Spoken notes: `pa note start|stop|toggle` (any process, no TCC) writes/deletes a request file; `pa run` polls it and
// records the mic only (see `detectStep`). A file, not a socket: survives either side restarting, trivially testable.

public struct NoteRequest: Codable, Equatable, Sendable {
    /// Lowercase UUID; a new one per start → a stop+start in one poll still splits into two notes.
    public var id: String
    public var requestedAt: Date

    public init(id: String, requestedAt: Date) {
        self.id = id
        self.requestedAt = requestedAt
    }
}

public struct NoteRequestStore: Sendable {
    public let url: URL

    public init(url: URL) { self.url = url }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    /// nil = no request (or unreadable: treated as none, never blocks recording meetings).
    public func load() -> NoteRequest? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try? d.decode(NoteRequest.self, from: data)
    }

    /// Existing request kept (start twice = one note); else a new one.
    @discardableResult
    public func start(now: Date, newID: () -> UUID = { UUID() }) throws -> NoteRequest {
        if let r = load() { return r }
        let r = NoteRequest(id: newID().uuidString.lowercased(), requestedAt: now)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Self.encoder.encode(r).write(to: url, options: .atomic)
        return r
    }

    /// Returns the request that was removed (nil = none).
    @discardableResult
    public func stop() throws -> NoteRequest? {
        let r = load()
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        return r
    }

    /// Daemon side: only this id → a newer `pa note start` racing with it survives.
    public func clear(id: String) {
        guard load()?.id == id else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

/// `pa note` CLI action.
public enum NoteAction: String, Equatable, Sendable {
    case start, stop, toggle, status
}

public enum NoteStartResult: Equatable, Sendable {
    /// Daemon started recording (its sidecar).
    case recording(RecordingMeta)
    /// Daemon cleared the request: a meeting is being recorded / a call holds the mic.
    case refused
    /// Daemon never reacted (not running, stuck): caller withdraws the request.
    case timedOut
}

/// After writing the request: poll until `pa run` writes a note sidecar for it or clears it.
public func waitForNoteStart(
    id: String, store: NoteRequestStore, recordings: RecordingStore, timeout: Int = 15,
    sleep: @Sendable () async throws -> Void = { try await Task.sleep(nanoseconds: 1_000_000_000) }
) async throws -> NoteStartResult {
    for _ in 0..<timeout {
        if let m = try recordings.all().items.first(where: { $0.noteId == id }) { return .recording(m) }
        if store.load()?.id != id { return .refused }
        try await sleep()
    }
    return .timedOut
}

/// After deleting the request: poll until the note's sidecar is closed (or already transcribed + gone). nil = timeout.
public func waitForNoteStop(
    id: String, recordings: RecordingStore, timeout: Int = 15,
    sleep: @Sendable () async throws -> Void = { try await Task.sleep(nanoseconds: 1_000_000_000) }
) async throws -> RecordingMeta?? {
    for _ in 0..<timeout {
        guard let m = try recordings.all().items.first(where: { $0.noteId == id }) else { return .some(nil) }
        if m.endedAt != nil { return .some(m) }
        try await sleep()
    }
    return nil
}
