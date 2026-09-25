import AVFoundation

/// Mic via AVAudioEngine with voice processing (AEC) so remote voices from
/// laptop speakers are suppressed in the mic stream.
final class MicCapture {
    private let engine = AVAudioEngine()
    private(set) var writer: WavWriter?

    func start(writingTo url: URL) throws {
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        // Read format after enabling VP: VP changes channel count/rate.
        let format = input.outputFormat(forBus: 0)
        let w = try WavWriter(url: url, format: format)
        writer = w
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            w.write(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        writer?.close()
    }
}
