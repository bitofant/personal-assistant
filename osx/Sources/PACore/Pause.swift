import Foundation

// Pause automatic meeting recording: `pa pause` / menu write `pause.json`, `pa run` polls it (like note requests).
// Spoken notes still work while paused (explicit request).

public struct PauseRequest: Codable, Equatable, Sendable {
    public var pausedAt: Date

    public init(pausedAt: Date) { self.pausedAt = pausedAt }
}

public struct PauseStore: Sendable {
    public let url: URL

    public init(url: URL) { self.url = url }

    /// nil = not paused. Unreadable = not paused: a broken file must never silently stop meeting recording.
    public func load() -> PauseRequest? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try? d.decode(PauseRequest.self, from: data)
    }

    /// Already paused → keeps the original time.
    @discardableResult
    public func pause(now: Date) throws -> PauseRequest {
        if let p = load() { return p }
        let p = PauseRequest(pausedAt: now)
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try e.encode(p).write(to: url, options: .atomic)
        return p
    }

    /// Returns the pause that was lifted (nil = wasn't paused).
    @discardableResult
    public func resume() throws -> PauseRequest? {
        let p = load()
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        return p
    }
}
