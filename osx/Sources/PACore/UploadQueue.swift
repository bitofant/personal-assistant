import Foundation

// Offline-safe transcript upload queue for `pa run`: one JSON file per upload, retried with backoff.
// The sender is injected (`pa` passes URLSession + current Keychain token) → fully testable on Linux.

/// What a failed upload means for that item / the queue.
public enum UploadFailureAction: Equatable, Sendable {
    /// Transient (network, 5xx, 408/429, 403 = pairing not approved yet): back off, try again.
    case retry
    /// 410: deleted on the server; it will never be accepted again (tombstone) → forget it.
    case drop
    /// 401: token unknown/revoked/account disabled → every upload would fail; stop until re-paired.
    case halt
    /// Other 4xx (400/413/415): same body fails forever → move aside, keep the data, don't retry.
    case park
}

public func classifyUploadFailure(_ e: ApiError) -> UploadFailureAction {
    switch e.status {
    case nil: .retry
    case 401: .halt
    case 410: .drop
    case 403, 408, 409, 425, 429: .retry
    case let s? where (400..<500).contains(s): .park
    default: .retry
    }
}

/// 30s, 60s, … capped at 1h (same curve as the server's job queue). `failures` ≥ 1.
public func uploadBackoff(failures: Int) -> TimeInterval {
    min(30 * pow(2, Double(max(failures, 1) - 1)), 3600)
}

public struct QueuedUpload: Codable, Equatable, Sendable {
    public var upload: TranscriptUpload
    /// New per enqueue; settle only if unchanged (re-enqueue during a send must not be lost).
    public var revision: String
    public var enqueuedAt: Date
    public var attempts: Int
    public var nextAttemptAt: Date
    public var lastError: String?
}

/// `<dir>/<id>.json` = pending; `<dir>/failed/<name>` = parked or unreadable (kept for `pa upload` / inspection).
public struct UploadQueueStore: Sendable {
    public let dir: URL
    public var failedDir: URL { dir.appendingPathComponent("failed", isDirectory: true) }

    public init(dir: URL) { self.dir = dir }

    private static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }

    private static func decode(_ data: Data) throws -> QueuedUpload {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try d.decode(QueuedUpload.self, from: data)
    }

    private static func removeIfPresent(_ url: URL) throws {
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }

    private func file(_ id: String) -> URL { dir.appendingPathComponent("\(id).json") }

    /// Pending items + files that failed to decode (moved to `failed/`, never deleted).
    public func load() throws -> (items: [QueuedUpload], corrupt: [String]) {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var items: [QueuedUpload] = [], corrupt: [String] = []
        // Only `*.json`: skips atomic-write temp files and `failed/`.
        for name in try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted()
        where name.hasSuffix(".json") && !name.hasPrefix(".") {
            let url = dir.appendingPathComponent(name)
            if let data = try? Data(contentsOf: url), let q = try? Self.decode(data),
               "\(q.upload.id).json" == name {
                items.append(q)
            } else {
                try moveToFailed(url, name: name)
                corrupt.append(name)
            }
        }
        return (items, corrupt)
    }

    /// `failed/` contents for `pa queue`; unreadable = files moved there by `load` (or foreign).
    public func parked() throws -> (items: [QueuedUpload], unreadable: [String]) {
        guard FileManager.default.fileExists(atPath: failedDir.path) else { return ([], []) }
        var items: [QueuedUpload] = [], unreadable: [String] = []
        for name in try FileManager.default.contentsOfDirectory(atPath: failedDir.path).sorted() where !name.hasPrefix(".") {
            if let q = (try? Data(contentsOf: failedDir.appendingPathComponent(name))).flatMap({ try? Self.decode($0) }) {
                items.append(q)
            } else {
                unreadable.append(name)
            }
        }
        return (items, unreadable)
    }

    public func read(_ id: String) -> QueuedUpload? {
        (try? Data(contentsOf: file(id))).flatMap { try? Self.decode($0) }
    }

    /// Atomic: a crash mid-write never leaves a half file.
    public func save(_ q: QueuedUpload) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Self.encoder().encode(q).write(to: file(q.upload.id), options: .atomic)
    }

    public func remove(_ id: String) throws {
        try Self.removeIfPresent(file(id))
    }

    public func park(_ q: QueuedUpload) throws {
        try FileManager.default.createDirectory(at: failedDir, withIntermediateDirectories: true)
        try Self.encoder().encode(q).write(to: failedDir.appendingPathComponent("\(q.upload.id).json"), options: .atomic)
        try remove(q.upload.id)
    }

    /// New content may fix what got it parked.
    public func unpark(_ id: String) throws {
        try Self.removeIfPresent(failedDir.appendingPathComponent("\(id).json"))
    }

    private func moveToFailed(_ url: URL, name: String) throws {
        try FileManager.default.createDirectory(at: failedDir, withIntermediateDirectories: true)
        let dest = failedDir.appendingPathComponent(name)
        try Self.removeIfPresent(dest)
        try FileManager.default.moveItem(at: url, to: dest)
    }
}

public enum UploadEvent: Equatable, Sendable, CustomStringConvertible {
    case uploaded(id: String, created: Bool)
    case dropped(id: String, reason: String)
    case parked(id: String, reason: String)
    case retrying(id: String, attempt: Int, at: Date, reason: String)
    case halted(reason: String)
    case corrupt(file: String)

    public var description: String {
        switch self {
        case let .uploaded(id, created): "\(created ? "uploaded" : "replaced") \(id)"
        case let .dropped(id, reason): "dropped \(id) (deleted on server): \(reason)"
        case let .parked(id, reason): "parked \(id) in failed/ (won't retry): \(reason)"
        case let .retrying(id, attempt, at, reason):
            "upload \(id) failed (attempt \(attempt)), retry after \(ISO8601DateFormatter().string(from: at)): \(reason)"
        case let .halted(reason): "upload queue stopped until re-paired (`pa pair`): \(reason)"
        case let .corrupt(file): "unreadable queue file \(file) moved to failed/"
        }
    }
}

public actor UploadQueue {
    public typealias Send = @Sendable (TranscriptUpload) async throws -> TranscriptUploadResponse

    public let store: UploadQueueStore
    private let send: Send
    private let now: @Sendable () -> Date
    /// Set by a 401; in memory only → a restarted daemon probes once and re-halts if still unpaired.
    public private(set) var halted: String?
    /// Queue-wide backoff: outages are server-wide, so one probe per wait, not one per item.
    private var failures = 0
    private var retryAt: Date?
    private var draining = false

    public init(store: UploadQueueStore, now: @escaping @Sendable () -> Date = { Date() }, send: @escaping Send) {
        self.store = store
        self.now = now
        self.send = send
    }

    /// Persisted before returning → caller may delete the audio afterwards. Same id = replace (server upserts too).
    public func enqueue(_ upload: TranscriptUpload) throws {
        // Id becomes a file name: only canonical UUIDs (the server requires one anyway).
        guard let uuid = UUID(uuidString: upload.id) else { throw UsageError("upload id is not a UUID: \(upload.id)") }
        var u = upload
        u.id = uuid.uuidString.lowercased()
        let t = now()
        try store.save(QueuedUpload(upload: u, revision: UUID().uuidString, enqueuedAt: t, attempts: 0, nextAttemptAt: t, lastError: nil))
        try store.unpark(u.id)
        // New work shouldn't wait out a backoff earned by other items.
        retryAt = nil
    }

    /// After re-pairing (daemon sees `/api/device/me` active again).
    public func resume() {
        halted = nil
        retryAt = nil
        failures = 0
    }

    public func pending() throws -> [QueuedUpload] { try store.load().items }

    /// When `drain` next has work; nil = empty or halted.
    public func nextWake() throws -> Date? {
        guard halted == nil, let due = try store.load().items.map(\.nextAttemptAt).min() else { return nil }
        return max(due, retryAt ?? due)
    }

    /// Uploads due items, least recently tried first (a failing item can't block fresh ones). Stops the pass at the first transient failure (server likely down) or 401.
    public func drain() async throws -> [UploadEvent] {
        // Actor is reentrant across `await send`: one pass at a time.
        guard !draining, halted == nil else { return [] }
        if let r = retryAt, r > now() { return [] }
        draining = true
        defer { draining = false }

        let (items, corrupt) = try store.load()
        var events = corrupt.map { UploadEvent.corrupt(file: $0) }
        let t0 = now()
        for item in items.filter({ $0.nextAttemptAt <= t0 }).sorted(by: { ($0.nextAttemptAt, $0.enqueuedAt) < ($1.nextAttemptAt, $1.enqueuedAt) }) {
            if Task.isCancelled { break }
            do {
                let r = try await send(item.upload)
                failures = 0
                retryAt = nil
                if isCurrent(item) { try store.remove(item.upload.id) }
                events.append(.uploaded(id: r.id, created: r.created))
            } catch {
                // Shutdown mid-send: not the item's fault, don't count it.
                if Task.isCancelled { break }
                let e = error as? ApiError ?? ApiError(status: nil, "\(error)")
                switch classifyUploadFailure(e) {
                case .halt:
                    halted = e.message
                    events.append(.halted(reason: e.description))
                    return events
                case .drop:
                    if isCurrent(item) { try store.remove(item.upload.id) }
                    events.append(.dropped(id: item.upload.id, reason: e.description))
                case .park:
                    var q = item
                    q.attempts += 1
                    q.lastError = e.description
                    if isCurrent(item) { try store.park(q) }
                    events.append(.parked(id: item.upload.id, reason: e.description))
                case .retry:
                    failures += 1
                    let t = now()
                    retryAt = t.addingTimeInterval(uploadBackoff(failures: failures))
                    var q = item
                    q.attempts += 1
                    q.lastError = e.description
                    q.nextAttemptAt = t.addingTimeInterval(uploadBackoff(failures: q.attempts))
                    if isCurrent(item) { try store.save(q) }
                    events.append(.retrying(id: q.upload.id, attempt: q.attempts, at: max(q.nextAttemptAt, retryAt!), reason: e.description))
                    return events
                }
            }
        }
        return events
    }

    /// Re-enqueued during the send → the newer version stays pending (it's due now). Don't drop this guard.
    private func isCurrent(_ item: QueuedUpload) -> Bool {
        store.read(item.upload.id)?.revision == item.revision
    }
}
