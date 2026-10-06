// preconcurrency: AVAudioPCMBuffer isn't Sendable; each buffer is copied and handed over once (never touched again).
@preconcurrency import AVFoundation
import os
import PACore

private struct PCM: @unchecked Sendable { let buffer: AVAudioPCMBuffer }

/// Capture buffers are reused after the callback returns (AVAudioEngine) → copy before queueing.
private func copyPCM(_ b: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let out = AVAudioPCMBuffer(pcmFormat: b.format, frameCapacity: b.frameLength) else { return nil }
    out.frameLength = b.frameLength
    let src = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: b.audioBufferList))
    let dst = UnsafeMutableAudioBufferListPointer(out.mutableAudioBufferList)
    for (s, d) in zip(src, dst) {
        guard let from = s.mData, let to = d.mData else { continue }
        memcpy(to, from, Int(min(s.mDataByteSize, d.mDataByteSize)))
    }
    return out
}

/// Capture → WAV in FluidAudio's input format (`CaptureFormat`: 16 kHz mono Float32, ~6× smaller than 48 kHz stereo).
/// Capture callbacks only copy + enqueue; meter, downmix, resample, file write and the live sink run on a serial
/// background queue (file I/O in a capture callback can drop audio).
final class WavWriter: @unchecked Sendable {
    static let fileFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: CaptureFormat.sampleRate,
        channels: AVAudioChannelCount(CaptureFormat.channels), interleaved: false)!

    /// What the device delivers (Float32; any rate/channel count/layout).
    let inputFormat: AVAudioFormat
    private let monoFormat: AVAudioFormat
    /// One per stream, kept for the whole recording: a fresh converter per buffer (FluidAudio's streaming path)
    /// restarts the resampler filter at every buffer edge.
    private let converter: AVAudioConverter
    private let file: AVAudioFile
    private let queue: DispatchQueue
    /// Queue-only state.
    private var closed = false
    /// Guards the fields below (read from other threads for progress/summary).
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
        /// Buffers waiting for the writer queue; max > a few = the writer falls behind.
        var queued = 0
        var maxQueued = 0
        /// First IOProc buffer list, e.g. "1ch 2048B, 2ch 4096B"; shows which buffer is the tap.
        var layout: String?
        /// Peak per buffer index across all IOProc callbacks (Float32 only).
        var bufferPeaks: [Float] = []
        /// Peak per channel of non-interleaved input (before the downmix): shows which mic channels carry signal.
        var channelPeaks: [Float] = []
        var description: String {
            let fmt = { (ps: [Float]) in ps.map { dbfs($0).map { String(format: "%.1f", $0) } ?? "—" }.joined(separator: ", ") }
            var s = "\(callbacks) callbacks, \(empty) empty, \(unreadable) unreadable, writer backlog max \(maxQueued)"
            // Only the IOProc path sees buffer lists; "max 0" on AVAudioEngine streams was misleading.
            if maxBuffers > 0 { s += ", max \(maxBuffers) buffers/callback" }
            if let layout { s += "\n  buffer layout: [\(layout)]" }
            if !bufferPeaks.isEmpty { s += ", peak dBFS per buffer: [\(fmt(bufferPeaks))]" }
            if !channelPeaks.isEmpty { s += "\n  peak dBFS per channel: [\(fmt(channelPeaks))]" }
            return s
        }
    }

    /// Gets every converted buffer that reached the WAV (live preview), on the writer queue. Fresh buffer each
    /// call, never touched again by the writer → no copy needed.
    private let sink: (@Sendable (AVAudioPCMBuffer) -> Void)?

    init(url: URL, inputFormat: AVAudioFormat, label: String, sink: (@Sendable (AVAudioPCMBuffer) -> Void)? = nil) throws {
        // Our downmix reads Float32; AVAudioEngine input + Core Audio taps deliver Float32.
        guard inputFormat.commonFormat == .pcmFormatFloat32, inputFormat.channelCount > 0 else {
            throw SpikeError(description: "\(label): unsupported capture format \(describe(inputFormat)) (need Float32)")
        }
        self.inputFormat = inputFormat
        self.sink = sink
        monoFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: inputFormat.sampleRate, channels: 1, interleaved: false)!
        guard let c = AVAudioConverter(from: monoFormat, to: Self.fileFormat) else {
            throw SpikeError(description: "\(label): no converter \(describe(monoFormat)) → \(describe(Self.fileFormat))")
        }
        // Same settings as FluidAudio's AudioConverter.
        c.sampleRateConverterAlgorithm = AVSampleRateConverterAlgorithm_Mastering
        c.sampleRateConverterQuality = AVAudioQuality.max.rawValue
        converter = c
        queue = DispatchQueue(label: "pa.wav-writer.\(label)", qos: .userInitiated)
        file = try AVAudioFile(
            forWriting: url, settings: Self.fileFormat.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    }

    /// AVAudioEngine tap: copy + enqueue only.
    func write(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0 else {
            lock.withLock { _stats.callbacks += 1; _stats.empty += 1 }
            return
        }
        guard let copy = copyPCM(buffer) else {
            lock.withLock { _stats.callbacks += 1; _stats.unreadable += 1 }
            return
        }
        enqueue(copy)
    }

    /// Aggregate IOProc input. Can hold >1 buffer (sub-device input streams and/or tap split per channel),
    /// so `AVAudioPCMBuffer(bufferListNoCopy:)` rejects it (live: 2 buffers, every callback unreadable).
    func write(bufferList: UnsafePointer<AudioBufferList>) {
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: bufferList))
        let isFloat = inputFormat.commonFormat == .pcmFormatFloat32
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
        // extractTap copies → safe to queue.
        guard let buf = extractTap(abl) else {
            lock.withLock { _stats.callbacks += 1; _stats.unreadable += 1 }
            return
        }
        guard buf.frameLength > 0 else {
            lock.withLock { _stats.callbacks += 1; _stats.empty += 1 }
            return
        }
        enqueue(buf)
    }

    /// Copies the tap's samples into a buffer in `inputFormat` (interleaved). Aggregate lists sub-device
    /// streams before taps, so the tap = the *last* matching buffer(s).
    private func extractTap(_ abl: UnsafeMutableAudioBufferListPointer) -> AVAudioPCMBuffer? {
        let format = inputFormat
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

    private func enqueue(_ b: AVAudioPCMBuffer) {
        lock.withLock {
            _stats.callbacks += 1
            _stats.queued += 1
            _stats.maxQueued = max(_stats.maxQueued, _stats.queued)
        }
        let p = PCM(buffer: b)
        queue.async {
            self.process(p.buffer)
            self.lock.withLock { self._stats.queued -= 1 }
        }
    }

    // MARK: writer queue

    private func process(_ raw: AVAudioPCMBuffer) {
        guard !closed, lock.withLock({ _error == nil }), let data = raw.floatChannelData,
              let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: raw.frameLength),
              let out = mono.floatChannelData?[0] else { return }
        let frames = Int(raw.frameLength)
        let channels = Int(raw.format.channelCount)
        mono.frameLength = raw.frameLength
        // Meter on the raw input: an all-zero check must see what the device delivered.
        lock.withLock {
            if raw.format.isInterleaved {
                _meter.add(UnsafeBufferPointer(start: data[0], count: frames * channels))
            } else {
                if _stats.channelPeaks.count < channels { _stats.channelPeaks = Array(repeating: 0, count: channels) }
                for ch in 0..<channels {
                    let samples = UnsafeBufferPointer(start: data[ch], count: frames)
                    _meter.add(samples)
                    _stats.channelPeaks[ch] = max(_stats.channelPeaks[ch], samples.reduce(0) { max($0, abs($1)) })
                }
            }
        }
        if raw.format.isInterleaved {
            downmix(interleaved: UnsafeBufferPointer(start: data[0], count: frames * channels), channels: channels, into: out)
        } else {
            downmix(channels: (0..<channels).map { UnsafePointer(data[$0]) }, frames: frames, into: out)
        }
        convert(mono)
    }

    /// Resamples `input` (nil = end of stream: flush the converter's tail) and writes the result.
    private func convert(_ input: AVAudioPCMBuffer?) {
        let given = OSAllocatedUnfairLock(initialState: false)
        // .noDataNow (not .endOfStream) between buffers: keeps the converter's filter state for the next one.
        let block: AVAudioConverterInputBlock = { _, status in
            guard let input else {
                status.pointee = .endOfStream
                return nil
            }
            if given.withLock({ done in defer { done = true }; return done }) {
                status.pointee = .noDataNow
                return nil
            }
            status.pointee = .haveData
            return input
        }
        let ratio = Self.fileFormat.sampleRate / monoFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(input?.frameLength ?? 0) * ratio).rounded(.up)) + 1024
        while true {
            guard let out = AVAudioPCMBuffer(pcmFormat: Self.fileFormat, frameCapacity: capacity) else {
                fail(SpikeError(description: "can't allocate conversion buffer"))
                return
            }
            var err: NSError?
            let status = converter.convert(to: out, error: &err, withInputFrom: block)
            if status == .error {
                fail(err ?? SpikeError(description: "audio conversion failed"))
                return
            }
            if out.frameLength > 0 {
                do { try file.write(from: out) } catch {
                    fail(error)
                    return
                }
                lock.withLock { _frames += AVAudioFramePosition(out.frameLength) }
                // Only what reached the WAV: preview timeline stays aligned with the file (= offline transcript).
                sink?(out)
            }
            // .haveData = output buffer full, more to come.
            if status != .haveData { return }
        }
    }

    private func fail(_ e: Error) { lock.withLock { if _error == nil { _error = e } } }

    /// Waits for the backlog, flushes the resampler tail, closes the file. Call after capture stopped;
    /// later callbacks are dropped.
    func close() {
        queue.sync {
            guard !closed else { return }
            closed = true
            if lock.withLock({ _error == nil }) { convert(nil) }
            file.close()
        }
    }

    var meter: LevelMeter { lock.withLock { _meter } }
    var error: Error? { lock.withLock { _error } }
    var stats: CallbackStats { lock.withLock { _stats } }
    /// Seconds in the WAV; nil if nothing was written (unknown, not 0s).
    var seconds: Double? {
        lock.withLock { _frames == 0 ? nil : Double(_frames) / Self.fileFormat.sampleRate }
    }
}
