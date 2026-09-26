import AVFoundation
import PACore

/// Thread-safe WAV sink + level meter. Called from Core Audio / AVAudioEngine
/// realtime-ish threads; file I/O there is acceptable for a spike, not for `pa run`.
final class WavWriter: @unchecked Sendable {
    let format: AVAudioFormat
    private let file: AVAudioFile
    private let lock = NSLock()
    private var _meter = LevelMeter()
    private var _frames: AVAudioFramePosition = 0
    private var _error: Error?
    private var _stats = CallbackStats()

    /// Distinguishes "callbacks stopped" from "callbacks run but deliver nothing".
    struct CallbackStats: CustomStringConvertible {
        var callbacks = 0
        var empty = 0
        var unreadable = 0
        var maxBuffers = 0
        /// First IOProc buffer list, e.g. "1ch 2048B, 2ch 4096B"; shows which buffer is the tap.
        var layout: String?
        /// Peak per buffer index across all IOProc callbacks (Float32 only).
        var bufferPeaks: [Float] = []
        /// Peak per channel of non-interleaved buffers: shows which mic channels carry signal.
        var channelPeaks: [Float] = []
        var description: String {
            let fmt = { (ps: [Float]) in ps.map { dbfs($0).map { String(format: "%.1f", $0) } ?? "—" }.joined(separator: ", ") }
            var s = "\(callbacks) callbacks, \(empty) empty, \(unreadable) unreadable"
            // Only the IOProc path sees buffer lists; "max 0" on AVAudioEngine streams was misleading.
            if maxBuffers > 0 { s += ", max \(maxBuffers) buffers/callback" }
            if let layout { s += "\n  buffer layout: [\(layout)]" }
            if !bufferPeaks.isEmpty { s += ", peak dBFS per buffer: [\(fmt(bufferPeaks))]" }
            if !channelPeaks.isEmpty { s += "\n  peak dBFS per channel: [\(fmt(channelPeaks))]" }
            return s
        }
    }

    init(url: URL, format: AVAudioFormat) throws {
        self.format = format
        file = try AVAudioFile(
            forWriting: url, settings: format.settings,
            commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    }

    func write(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            _stats.callbacks += 1
            guard buffer.frameLength > 0 else { _stats.empty += 1; return }
            guard _error == nil else { return }
            do { try file.write(from: buffer) } catch { _error = error; return }
            _frames += AVAudioFramePosition(buffer.frameLength)
            guard let data = buffer.floatChannelData else { return }
            // Interleaved: one pointer holding frames*channels samples.
            let channels = buffer.format.isInterleaved ? 1 : Int(buffer.format.channelCount)
            let perChannel = Int(buffer.frameLength) * (buffer.format.isInterleaved ? Int(buffer.format.channelCount) : 1)
            if _stats.channelPeaks.count < channels, !buffer.format.isInterleaved {
                _stats.channelPeaks = Array(repeating: 0, count: channels)
            }
            for ch in 0..<channels {
                let samples = UnsafeBufferPointer(start: data[ch], count: perChannel)
                _meter.add(samples)
                if !buffer.format.isInterleaved {
                    _stats.channelPeaks[ch] = max(_stats.channelPeaks[ch], samples.reduce(0) { max($0, abs($1)) })
                }
            }
        }
    }

    /// Aggregate IOProc input. Can hold >1 buffer (sub-device input streams and/or tap split per channel),
    /// so `AVAudioPCMBuffer(bufferListNoCopy:)` rejects it (live: 2 buffers, every callback unreadable).
    func write(bufferList: UnsafePointer<AudioBufferList>) {
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: bufferList))
        let isFloat = format.commonFormat == .pcmFormatFloat32
        let peaks: [Float] = abl.map { b in
            guard isFloat, let p = b.mData else { return 0 }
            let n = Int(b.mDataByteSize) / MemoryLayout<Float>.size
            return UnsafeBufferPointer(start: p.assumingMemoryBound(to: Float.self), count: n)
                .reduce(0) { max($0, abs($1)) }
        }
        lock.withLock {
            _stats.maxBuffers = max(_stats.maxBuffers, abl.count)
            if _stats.layout == nil {
                _stats.layout = abl.map { "\($0.mNumberChannels)ch \($0.mDataByteSize)B" }.joined(separator: ", ")
            }
            if _stats.bufferPeaks.count < peaks.count {
                _stats.bufferPeaks += Array(repeating: 0, count: peaks.count - _stats.bufferPeaks.count)
            }
            for (i, p) in peaks.enumerated() { _stats.bufferPeaks[i] = max(_stats.bufferPeaks[i], p) }
        }
        guard let buf = extractTap(abl) else {
            lock.withLock {
                _stats.callbacks += 1
                _stats.unreadable += 1
            }
            return
        }
        write(buf)
    }

    /// Copies the tap's samples into a buffer in `format` (interleaved). Aggregate lists sub-device
    /// streams before taps, so the tap = the *last* matching buffer(s).
    private func extractTap(_ abl: UnsafeMutableAudioBufferListPointer) -> AVAudioPCMBuffer? {
        let channels = Int(format.channelCount)
        let bytesPerSample = Int(format.streamDescription.pointee.mBitsPerChannel / 8)
        guard format.isInterleaved, bytesPerSample > 0 else { return nil }
        // One buffer carrying all channels interleaved.
        if let b = abl.last(where: { Int($0.mNumberChannels) == channels }), let src = b.mData {
            let frames = Int(b.mDataByteSize) / (bytesPerSample * channels)
            guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
                  let dst = out.mutableAudioBufferList.pointee.mBuffers.mData else { return nil }
            out.frameLength = AVAudioFrameCount(frames)
            memcpy(dst, src, frames * bytesPerSample * channels)
            return out
        }
        // One mono buffer per channel → interleave.
        let monos = Array(abl.suffix(channels))
        guard format.commonFormat == .pcmFormatFloat32, monos.count == channels,
              monos.allSatisfy({ $0.mNumberChannels == 1 && $0.mData != nil }) else { return nil }
        let frames = monos.map { Int($0.mDataByteSize) / MemoryLayout<Float>.size }.min() ?? 0
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let dst = out.floatChannelData?[0] else { return nil }
        out.frameLength = AVAudioFrameCount(frames)
        for (c, b) in monos.enumerated() {
            let src = b.mData!.assumingMemoryBound(to: Float.self)
            for f in 0..<frames { dst[f * channels + c] = src[f] }
        }
        return out
    }

    func close() { lock.withLock { file.close() } }

    var meter: LevelMeter { lock.withLock { _meter } }
    var error: Error? { lock.withLock { _error } }
    var stats: CallbackStats { lock.withLock { _stats } }
    /// nil if nothing was written (unknown, not 0s).
    var seconds: Double? {
        lock.withLock { _frames == 0 ? nil : Double(_frames) / format.sampleRate }
    }
}
