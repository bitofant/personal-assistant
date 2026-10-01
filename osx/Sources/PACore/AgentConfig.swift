import Foundation

public let bundleID = "com.bitofant.pa"

/// Non-secret settings in ~/Library/Application Support/<bundle id>/config.json.
public struct AgentConfig: Codable, Equatable, Sendable {
    /// Core Audio device UID (stable across reboots/replugs, unlike object ids). nil = system default input.
    public var micDeviceUID: String?
    /// Set by `pa pair`; the bearer token itself lives in the Keychain, never here.
    public var serverURL: String?
    public var account: String?
    public var deviceId: String?
    /// Calendars whose events drive/label recordings: `Name` or `Source/Name`. nil = none → every recording is ad-hoc
    /// (personal event titles/attendees never reach the server by accident).
    public var workCalendars: [String]?
    /// Bundle ids whose mic use never means "in a call" (e.g. an always-listening service). nil = none.
    public var ignoreMicApps: [String]?
    /// Days to keep a recording's audio after its transcript is queued; nil = delete right away.
    public var keepAudioDays: Int?

    public init(
        micDeviceUID: String? = nil, serverURL: String? = nil, account: String? = nil, deviceId: String? = nil,
        workCalendars: [String]? = nil, ignoreMicApps: [String]? = nil, keepAudioDays: Int? = nil
    ) {
        self.micDeviceUID = micDeviceUID
        self.serverURL = serverURL
        self.account = account
        self.deviceId = deviceId
        self.workCalendars = workCalendars
        self.ignoreMicApps = ignoreMicApps
        self.keepAudioDays = keepAudioDays
    }
}

/// Normalizes at the boundary: blank UID → nil; lists trimmed, blanks dropped, empty → nil; keepAudioDays ≤ 0 → nil.
public func parseAgentConfig(_ data: Data) throws -> AgentConfig {
    var c = try JSONDecoder().decode(AgentConfig.self, from: data)
    if c.micDeviceUID?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true { c.micDeviceUID = nil }
    func list(_ l: [String]?) -> [String]? {
        let t = (l ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return t.isEmpty ? nil : t
    }
    c.workCalendars = list(c.workCalendars)
    c.ignoreMicApps = list(c.ignoreMicApps)
    if let d = c.keepAudioDays, d <= 0 { c.keepAudioDays = nil }
    return c
}

public func encodeAgentConfig(_ c: AgentConfig) throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys]
    return try e.encode(c)
}

/// An audio device with input streams.
public struct MicDevice: Equatable, Sendable {
    public let objectID: UInt32
    public let uid: String
    public let name: String

    public init(objectID: UInt32, uid: String, name: String) {
        self.objectID = objectID
        self.uid = uid
        self.name = name
    }
}

/// `pa mics` line, parsed by pick-mic.sh: `uid<TAB>name<TAB>flags` (flags: `default,selected`).
/// Tabs/newlines in fields → space so the format can't break.
public func formatMicLine(_ d: MicDevice, isDefault: Bool, isSelected: Bool) -> String {
    let clean = { (s: String) in String(s.map { $0 == "\t" || $0.isNewline ? " " : $0 }) }
    let flags = [isDefault ? "default" : nil, isSelected ? "selected" : nil].compactMap { $0 }.joined(separator: ",")
    return "\(clean(d.uid))\t\(clean(d.name))\t\(flags)"
}
