import Foundation

/// Running peak/RMS of float samples. Silence detection matters: a denied
/// system-audio permission yields a silent tap, not an error.
public struct LevelMeter: Sendable {
    public private(set) var peak: Float = 0
    private var sumSquares: Double = 0
    public private(set) var samples: Int = 0

    public init() {}

    public mutating func add<C: Collection>(_ values: C) where C.Element == Float {
        for s in values {
            let a = abs(s)
            if a > peak { peak = a }
            sumSquares += Double(s) * Double(s)
        }
        samples += values.count
    }

    /// nil = no samples seen (unknown, not silent).
    public var peakOrNil: Float? { samples == 0 ? nil : peak }
    public var rms: Float? { samples == 0 ? nil : Float((sumSquares / Double(samples)).squareRoot()) }
    public var isAllZeros: Bool { samples > 0 && peak == 0 }
}

/// dBFS; nil stays nil (missing ≠ silent); zero clamps to `floor`.
public func dbfs(_ amplitude: Float?, floor: Float = -120) -> Float? {
    guard let a = amplitude else { return nil }
    guard a > 0 else { return floor }
    return max(floor, 20 * log10(a))
}

/// Single formatter for the per-stream summary line.
public func formatLevel(label: String, meter: LevelMeter, seconds: Double?) -> String {
    let fmt = { (v: Float?) in v.map { String(format: "%.1f dBFS", $0) } ?? "—" }
    let dur = seconds.map { String(format: "%.1fs", $0) } ?? "—"
    let warn = meter.isAllZeros ? "  ⚠️ all zeros (permission denied, or nothing playing?)" : ""
    return "\(label): \(dur), peak \(fmt(dbfs(meter.peakOrNil))), rms \(fmt(dbfs(meter.rms)))\(warn)"
}
