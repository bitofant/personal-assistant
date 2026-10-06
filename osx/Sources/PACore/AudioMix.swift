/// Recording WAVs = FluidAudio's model input (`AudioConverter` default target, v0.17.4): 16 kHz mono Float32,
/// non-interleaved. ASR, offline diarization and live preview then skip their own conversion.
public enum CaptureFormat {
    public static let sampleRate = 16_000.0
    public static let channels = 1
    /// Float32 bytes per second of one stream (≈ 230 MB/h).
    public static let bytesPerSecond = Int(sampleRate) * channels * 4
}

/// Mean of `channels` (non-interleaved, `frames` each) → `out`. Mean, not sum: can't clip. Done here, not by
/// AVAudioConverter: its 2→1 remap without `downmix` keeps channel 0 only (a right-only mic would be silent).
public func downmix(channels: [UnsafePointer<Float>], frames: Int, into out: UnsafeMutablePointer<Float>) {
    guard let first = channels.first else { return }
    if channels.count == 1 {
        out.update(from: first, count: frames)
        return
    }
    let scale = 1 / Float(channels.count)
    for f in 0..<frames {
        var sum: Float = 0
        for c in channels { sum += c[f] }
        out[f] = sum * scale
    }
}

/// Interleaved variant: `samples` = frames × `channels`. Returns the frame count written to `out`.
@discardableResult
public func downmix(interleaved samples: UnsafeBufferPointer<Float>, channels: Int, into out: UnsafeMutablePointer<Float>) -> Int {
    guard channels > 0 else { return 0 }
    let frames = samples.count / channels
    let scale = 1 / Float(channels)
    for f in 0..<frames {
        var sum: Float = 0
        for c in 0..<channels { sum += samples[f * channels + c] }
        out[f] = sum * scale
    }
    return frames
}
