/// Parsed CLI invocation. Hand-rolled: too few flags to justify swift-argument-parser.
public enum Command: Equatable, Sendable {
    case help
    case testCapture(TestCaptureOptions)
    case mics
    /// nil = back to system default input.
    case setMic(String?)
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
    default:
        throw UsageError("unknown command \(sub)")
    }
}
