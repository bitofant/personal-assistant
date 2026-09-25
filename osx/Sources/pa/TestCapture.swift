import AVFoundation
import Foundation
import PACore

/// Spike: N seconds of system audio (process tap) + mic → two WAVs, then a level
/// summary. Proves TCC prompts/grants attach to PA.app before building on it.
func testCapture(_ o: TestCaptureOptions) async throws {
    let dir = o.outDir.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath, isDirectory: true) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: "pa-test-capture", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let fmt = DateFormatter()
    fmt.locale = Locale(identifier: "en_US_POSIX")
    fmt.dateFormat = "yyyyMMdd-HHmmss"
    let stamp = fmt.string(from: Date())
    let systemURL = dir.appending(path: "pa-\(stamp)-system.wav")
    let micURL = dir.appending(path: "pa-\(stamp)-mic.wav")

    // TCC attributes to the responsible process: run via `open PA.app`, not the bare binary.
    print("bundle: \(Bundle.main.bundleIdentifier ?? "none — not running from PA.app; TCC will attribute to the parent (e.g. Terminal)")")

    guard await AVAudioApplication.requestRecordPermission() else {
        throw SpikeError(description: "microphone permission denied (System Settings → Privacy & Security → Microphone)")
    }

    let processes = try listAudioProcesses()
    let own = processes.filter { $0.pid == getpid() }.map(\.objectID)
    let targets = o.global ? [] : selectTapTargets(processes, prefixes: o.apps, excludingPID: getpid())
    if !o.global && targets.isEmpty {
        let known = processes.compactMap(\.bundleID).sorted().joined(separator: "\n  ")
        throw SpikeError(description: "no audio process matches \(o.apps). Audio processes now:\n  \(known)")
    }
    print(o.global
        ? "system: global tap (excluding self)"
        : "system: tapping \(targets.map { "\($0.bundleID ?? "?") [pid \($0.pid)]" }.joined(separator: ", "))")

    let system = SystemAudioTap()
    let mic = MicCapture()
    defer {
        mic.stop()
        system.stop()
    }
    try system.start(processes: targets.map(\.objectID), global: o.global, excluding: own, writingTo: systemURL)
    try mic.start(writingTo: micURL)

    print("recording \(o.seconds)s … (talk, and have the other side talk)")
    try await Task.sleep(for: .seconds(o.seconds))
    mic.stop()
    system.stop()

    for (label, url, writer) in [("system", systemURL, system.writer), ("mic   ", micURL, mic.writer)] {
        guard let writer else { continue }
        print(formatLevel(label: label, meter: writer.meter, seconds: writer.seconds))
        if let err = writer.error { print("  write error: \(err)") }
        print("  \(url.path)")
    }
}
