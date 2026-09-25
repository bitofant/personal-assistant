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

    init(url: URL, format: AVAudioFormat) throws {
        self.format = format
        file = try AVAudioFile(
            forWriting: url, settings: format.settings,
            commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    }

    func write(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
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
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: bufferList, deallocator: nil) else { return }
        write(buf)
    }

    func close() { lock.withLock { file.close() } }

    var meter: LevelMeter { lock.withLock { _meter } }
    var error: Error? { lock.withLock { _error } }
    /// nil if nothing was written (unknown, not 0s).
    var seconds: Double? {
        lock.withLock { _frames == 0 ? nil : Double(_frames) / format.sampleRate }
    }
}
