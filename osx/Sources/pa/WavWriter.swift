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
        var description: String {
            "\(callbacks) callbacks, \(empty) empty, \(unreadable) unreadable, max \(maxBuffers) buffers/callback"
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
            for ch in 0..<channels {
                _meter.add(UnsafeBufferPointer(start: data[ch], count: perChannel))
            }
        }
    }

    func write(bufferList: UnsafePointer<AudioBufferList>) {
        // >1 buffer for an interleaved tap = aggregate sub-device inputs mixed in with the tap.
        let n = Int(bufferList.pointee.mNumberBuffers)
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: bufferList, deallocator: nil) else {
            lock.withLock {
                _stats.callbacks += 1
                _stats.unreadable += 1
                _stats.maxBuffers = max(_stats.maxBuffers, n)
            }
            return
        }
        lock.withLock { _stats.maxBuffers = max(_stats.maxBuffers, n) }
        write(buf)
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
