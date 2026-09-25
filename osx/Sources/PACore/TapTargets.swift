/// A Core Audio process object (kAudioHardwarePropertyProcessObjectList entry).
public struct AudioProcess: Equatable, Sendable {
    public let objectID: UInt32
    public let pid: Int32
    /// nil for processes without a bundle (CLI tools, some daemons).
    public let bundleID: String?

    public init(objectID: UInt32, pid: Int32, bundleID: String?) {
        self.objectID = objectID
        self.pid = pid
        self.bundleID = bundleID
    }
}

/// Processes to tap: bundle id equals a prefix or starts with `prefix + "."`.
/// Prefix match (not exact) because audio often comes from helpers
/// (e.g. `com.google.Chrome.helper`, Zoom's `us.zoom.*` subprocesses).
public func selectTapTargets(_ processes: [AudioProcess], prefixes: [String], excludingPID: Int32? = nil) -> [AudioProcess] {
    processes.filter { p in
        guard let b = p.bundleID?.lowercased(), p.pid != excludingPID else { return false }
        return prefixes.contains { raw in
            let prefix = raw.lowercased()
            return b == prefix || b.hasPrefix(prefix + ".")
        }
    }
}
