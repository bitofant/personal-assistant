import Foundation

// Detector inputs from OS snapshots: `pa` reads Core Audio process objects + the process list, matching here is pure.

/// One Core Audio client process (kAudioHardwarePropertyProcessObjectList).
public struct AudioClient: Equatable, Sendable {
    public var pid: Int32
    public var bundleID: String?
    public var runningInput: Bool

    public init(pid: Int32, bundleID: String?, runningInput: Bool) {
        self.pid = pid
        self.bundleID = bundleID
        self.runningInput = runningInput
    }
}

/// Processes holding the mic, minus pa itself (⚠️ our capture would keep every recording alive) and `ignore`
/// (bundle ids, case-insensitive; for always-listening system services).
public func micUsers(_ clients: [AudioClient], ownPID: Int32, ignore: [String]) -> [AudioClient] {
    let ignored = Set(ignore.map { $0.lowercased() })
    return clients.filter { c in
        c.runningInput && c.pid != ownPID && !(c.bundleID.map { ignored.contains($0.lowercased()) } ?? false)
    }
}

/// App bundle folder names whose running process counts as "meeting app open". Browsers too (Meet/Teams web):
/// harmless because app-only starts need a work event with attendees in its window.
public let defaultMeetingApps = [
    "zoom.us.app", "Microsoft Teams.app", "Microsoft Teams (work or school).app", "Microsoft Teams classic.app",
    "Webex.app", "Cisco Webex Meetings.app", "FaceTime.app", "Slack.app",
    "Google Chrome.app", "Safari.app", "Firefox.app", "Microsoft Edge.app", "Arc.app", "Brave Browser.app",
]

/// Executable path → meeting app it belongs to (outermost `.app` folder, case-insensitive), else nil.
/// Outermost: helpers live inside the main bundle (`Google Chrome.app/…/Helper.app`).
public func meetingAppName(executablePath: String, apps: [String] = defaultMeetingApps) -> String? {
    guard let bundle = executablePath.split(separator: "/").first(where: { $0.lowercased().hasSuffix(".app") }) else {
        return nil
    }
    return apps.first { $0.lowercased() == bundle.lowercased() }
}
