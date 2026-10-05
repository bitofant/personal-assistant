import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Files shared by `pa` and `pa-menu` (one place → both executables agree on paths).
public struct AgentPaths: Sendable {
    public let base: URL

    public init(base: URL) { self.base = base }

    /// `~/Library/Application Support/<bundle id>` (keyed on `bundleID`, not the menu's own bundle id).
    public static var `default`: AgentPaths {
        AgentPaths(base: FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/\(bundleID)", isDirectory: true))
    }

    public var config: URL { base.appendingPathComponent("config.json") }
    public var recordings: URL { base.appendingPathComponent("recordings", isDirectory: true) }
    public var uploadQueue: URL { base.appendingPathComponent("upload-queue", isDirectory: true) }
    public var noteRequest: URL { base.appendingPathComponent("note-request.json") }
    public var pause: URL { base.appendingPathComponent("pause.json") }
    public var runLock: URL { base.appendingPathComponent("run.lock") }
}

/// `pa run` holds `lock` (flock) while recording: taking it here means nobody is. Can't tell → true (callers then
/// fall back to their own timeouts).
public func daemonIsRunning(lock: URL) -> Bool {
    try? FileManager.default.createDirectory(at: lock.deletingLastPathComponent(), withIntermediateDirectories: true)
    let fd = open(lock.path, O_RDWR | O_CREAT, 0o644)
    guard fd >= 0 else { return true }
    defer { close(fd) }
    if flock(fd, LOCK_EX | LOCK_NB) == 0 {
        flock(fd, LOCK_UN)
        return false
    }
    return true
}
