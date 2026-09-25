/// Parsed CLI invocation. Hand-rolled: too few flags to justify swift-argument-parser.
public enum Command: Equatable, Sendable {
    case help
    case testCapture(TestCaptureOptions)
}

public struct TestCaptureOptions: Equatable, Sendable {
    public var seconds: Int = 30
    /// Bundle-id prefixes whose audio to tap; ignored when `global`.
    public var apps: [String] = ["us.zoom"]
    public var global = false
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
      pa test-capture [--seconds N] [--app BUNDLE_PREFIX]... [--global] [--out DIR]
          Record system audio (process tap) + mic to two WAVs. Default: 30s, --app us.zoom,
          --out ~/pa-test-capture.
    """

/// `args` excludes argv[0].
public func parseCommand(_ args: [String]) throws(UsageError) -> Command {
    guard let sub = args.first else { return .help }
    switch sub {
    case "help", "-h", "--help":
        return .help
    case "test-capture":
        var o = TestCaptureOptions()
        var explicitApps: [String] = []
        var it = args.dropFirst().makeIterator()
        while let flag = it.next() {
            switch flag {
            case "--seconds":
                guard let v = it.next(), let n = Int(v), n > 0 else { throw UsageError("--seconds needs a positive integer") }
                o.seconds = n
            case "--app":
                guard let v = it.next(), !v.isEmpty else { throw UsageError("--app needs a bundle id prefix") }
                explicitApps.append(v)
            case "--global":
                o.global = true
            case "--out":
                guard let v = it.next(), !v.isEmpty else { throw UsageError("--out needs a directory") }
                o.outDir = v
            default:
                throw UsageError("unknown flag \(flag)")
            }
        }
        if !explicitApps.isEmpty { o.apps = explicitApps }
        if o.global && !explicitApps.isEmpty { throw UsageError("--global and --app are mutually exclusive") }
        return .testCapture(o)
    default:
        throw UsageError("unknown command \(sub)")
    }
}
