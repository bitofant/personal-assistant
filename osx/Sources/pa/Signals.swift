import CoreAudio
import Darwin
import PACore

// OS snapshots for the meeting detector; matching/filtering lives in PACore (Signals.swift, tested).

/// Core Audio client processes (process objects, macOS 14.2+). Read failure → [] (= mic idle), never a crash.
func audioClients() -> [AudioClient] {
    guard let objs = try? readArray(systemObject, kAudioHardwarePropertyProcessObjectList, zero: AudioObjectID(0)) else {
        return []
    }
    return objs.compactMap { obj in
        guard let pid = try? readScalar(obj, kAudioProcessPropertyPID, initial: pid_t(0)) else { return nil }
        // Per process, not kAudioDevicePropertyDeviceIsRunningSomewhere: that would count our own capture.
        let input = (try? readScalar(obj, kAudioProcessPropertyIsRunningInput, initial: UInt32(0))) ?? 0
        let bundle: String? = try? readString(obj, kAudioProcessPropertyBundleID)
        return AudioClient(pid: pid, bundleID: bundle, runningInput: input != 0)
    }
}

/// Running meeting apps (by executable path via libproc: no AppKit/run loop needed, unlike NSWorkspace).
func runningMeetingApps(_ apps: [String] = defaultMeetingApps) -> Set<String> {
    let count = proc_listallpids(nil, 0)
    guard count > 0 else { return [] }
    // Headroom: processes start between the two calls.
    var pids = [pid_t](repeating: 0, count: Int(count) + 64)
    let got = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
    var found = Set<String>()
    var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    for pid in pids.prefix(Int(max(got, 0))) where pid > 0 {
        let n = buf.withUnsafeMutableBufferPointer { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
        guard n > 0 else { continue }
        let path = buf.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
        if let app = meetingAppName(executablePath: path, apps: apps) { found.insert(app) }
    }
    return found
}

/// Log form: `zoom.us (pid 812)`; unknown bundle → `pid 812`.
func describeClients(_ cs: [AudioClient]) -> String {
    cs.isEmpty ? "nobody" : cs.map { c in c.bundleID.map { "\($0) (pid \(c.pid))" } ?? "pid \(c.pid)" }.joined(separator: ", ")
}
