import Foundation

/// Parsed CLI invocation. Hand-rolled: too few flags to justify swift-argument-parser.
public enum Command: Equatable, Sendable {
    case help
    case testCapture(TestCaptureOptions)
    case mics
    /// nil = back to system default input.
    case setMic(String?)
    /// deviceName nil = this Mac's name.
    case pair(server: URL, account: String, deviceName: String?)
    case status
    /// Path to a `TranscriptUpload` JSON file.
    case upload(String)
    case transcribe(TranscribeOptions)
}

public struct TranscribeOptions: Equatable, Sendable {
    /// nil = ~/pa-test-capture.
    public var dir: String? = nil
    /// `yyyyMMdd-HHmmss`; nil = newest recording in `dir`.
    public var stamp: String? = nil
    /// Mic speaker label; nil = macOS full user name.
    public var me: String? = nil
    public var diarize = true
    public var upload = false

    public init() {}
}

public struct TestCaptureOptions: Equatable, Sendable {
    public var seconds: Int = 30
    /// Per-stream switches: isolate which stream/setting breaks capture.
    public var mic = true
    public var system = true
    /// nil = ~/pa-test-capture (cwd is / under `open`; ~/Desktop would add a TCC prompt).
    public var outDir: String? = nil

    public init() {}
}

public struct UsageError: Error, Equatable, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

public let usage = """
    usage:
      pa test-capture [--seconds N] [--out DIR] [--no-mic] [--no-system]
          Record all system audio (global tap) + mic to two WAVs. Default: 30s, --out ~/pa-test-capture.
      pa mics
          List input devices: UID<TAB>name<TAB>flags (default,selected). Interactive: osx/pick-mic.sh.
      pa set-mic (UID | --default)
          Persist the mic to record from (config.json in ~/Library/Application Support/com.bitofant.pa).
      pa pair <server-url> <account> [--name DEVICE]
          Pair with the server; shows a code to enter in the web UI, waits for approval. Token → Keychain.
      pa status
          Show pairing state (asks the server).
      pa upload <transcript.json>
          Upload a TranscriptUpload JSON file (shared/api.ts) to the paired server.
      pa transcribe [DIR] [--stamp yyyyMMdd-HHmmss] [--me NAME] [--no-diarize] [--upload]
          Transcribe a test-capture recording (mic = you, system = diarized) → DIR/pa-<stamp>-transcript.json.
          Default: newest recording in ~/pa-test-capture; --me defaults to your macOS full name.
    """

/// `args` excludes argv[0].
public func parseCommand(_ args: [String]) throws(UsageError) -> Command {
    guard let sub = args.first else { return .help }
    switch sub {
    case "help", "-h", "--help":
        return .help
    case "test-capture":
        var o = TestCaptureOptions()
        var it = args.dropFirst().makeIterator()
        while let flag = it.next() {
            switch flag {
            case "--seconds":
                guard let v = it.next(), let n = Int(v), n > 0 else { throw UsageError("--seconds needs a positive integer") }
                o.seconds = n
            case "--out":
                guard let v = it.next(), !v.isEmpty else { throw UsageError("--out needs a directory") }
                o.outDir = v
            case "--no-mic":
                o.mic = false
            case "--no-system":
                o.system = false
            default:
                throw UsageError("unknown flag \(flag)")
            }
        }
        if !o.mic && !o.system { throw UsageError("--no-mic and --no-system leave nothing to record") }
        return .testCapture(o)
    case "mics":
        guard args.count == 1 else { throw UsageError("mics takes no arguments") }
        return .mics
    case "set-mic":
        guard args.count == 2, !args[1].isEmpty else { throw UsageError("set-mic needs a device UID or --default") }
        return .setMic(args[1] == "--default" ? nil : args[1])
    case "pair":
        var pos: [String] = []
        var name: String?
        var it = args.dropFirst().makeIterator()
        while let a = it.next() {
            if a == "--name" {
                guard let v = it.next()?.trimmingCharacters(in: .whitespaces), !v.isEmpty else { throw UsageError("--name needs a value") }
                name = v
            } else if a.hasPrefix("--") {
                throw UsageError("unknown flag \(a)")
            } else {
                pos.append(a)
            }
        }
        guard pos.count == 2 else { throw UsageError("pair needs <server-url> <account>") }
        let account = pos[1].trimmingCharacters(in: .whitespaces).lowercased()
        guard !account.isEmpty else { throw UsageError("account must not be empty") }
        return .pair(server: try parseServerURL(pos[0]), account: account, deviceName: name)
    case "status":
        guard args.count == 1 else { throw UsageError("status takes no arguments") }
        return .status
    case "upload":
        guard args.count == 2, !args[1].isEmpty else { throw UsageError("upload needs a transcript JSON file") }
        return .upload(args[1])
    case "transcribe":
        var o = TranscribeOptions()
        var it = args.dropFirst().makeIterator()
        while let a = it.next() {
            switch a {
            case "--stamp":
                guard let v = it.next(), parseCaptureStamp(v, timeZone: TimeZone(identifier: "UTC")!) != nil else {
                    throw UsageError("--stamp needs yyyyMMdd-HHmmss")
                }
                o.stamp = v
            case "--me":
                guard let v = it.next()?.trimmingCharacters(in: .whitespaces), !v.isEmpty else { throw UsageError("--me needs a name") }
                o.me = v
            case "--no-diarize":
                o.diarize = false
            case "--upload":
                o.upload = true
            default:
                if a.hasPrefix("--") { throw UsageError("unknown flag \(a)") }
                guard o.dir == nil, !a.isEmpty else { throw UsageError("transcribe takes one capture directory") }
                o.dir = a
            }
        }
        return .transcribe(o)
    default:
        throw UsageError("unknown command \(sub)")
    }
}
