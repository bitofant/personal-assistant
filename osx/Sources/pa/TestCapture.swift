import AVFoundation
import CoreAudio
import Foundation
import PACore

/// Spike: N seconds of system audio (global tap) + mic → two WAVs, then a level
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

    if o.mic {
        guard await AVAudioApplication.requestRecordPermission() else {
            throw SpikeError(description: "microphone permission denied (System Settings → Privacy & Security → Microphone)")
        }
    }

    let system = SystemAudioTap()
    let mic = MicCapture()
    defer {
        mic.stop()
        system.stop()
    }
    if o.mic {
        try mic.start(deviceUID: try loadAgentConfig().micDeviceUID, writingTo: micURL)
    }
    if o.system {
        print("system: global tap")
        try system.start(writingTo: systemURL)
    }

    let all: [(String, URL, WavWriter?)] = [("system", systemURL, system.writer), ("mic   ", micURL, mic.writer)]
    let streams: [(String, URL, WavWriter)] = all.compactMap { label, url, w in w.map { (label, url, $0) } }
    print("recording \(o.seconds)s … (talk, and have the other side talk)")
    // Per-second progress: shows *when* a stream stops advancing, not just that it did.
    for t in 1...o.seconds {
        try await Task.sleep(for: .seconds(1))
        let parts = streams.map { label, _, w in formatLevel(label: label, meter: w.meter, seconds: w.seconds) }
        print("[\(t)s] " + parts.joined(separator: " | "))
    }
    mic.stop()
    system.stop()

    print("---")
    for (label, url, writer) in streams {
        print(formatLevel(label: label, meter: writer.meter, seconds: writer.seconds))
        print("  \(writer.stats)")
        if let err = writer.error { print("  write error: \(err)") }
        print("  \(url.path)")
    }
}
