import AVFoundation
import CoreAudio

/// Mic via AVAudioEngine, optionally with voice processing (AEC) so remote voices
/// from laptop speakers are suppressed in the mic stream.
final class MicCapture {
    private let engine = AVAudioEngine()
    private var observer: NSObjectProtocol?
    private(set) var writer: WavWriter?

    func start(voiceProcessing: Bool, writingTo url: URL) throws {
        let input = engine.inputNode
        if voiceProcessing {
            try input.setVoiceProcessingEnabled(true)
            // VP ducks all other audio by default, incl. the meeting itself.
            input.voiceProcessingOtherAudioDuckingConfiguration =
                AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        }
        // Read format after enabling VP: VP changes channel count/rate.
        let format = input.outputFormat(forBus: 0)
        let dev = (try? defaultDevice(kAudioHardwarePropertyDefaultInputDevice)).map(deviceName) ?? "?"
        print("mic: \(dev), \(describe(format)), voice processing \(voiceProcessing ? "on" : "off")")
        // VP is one IO unit for input+output; give it an output graph so it's driven.
        _ = engine.mainMixerNode
        // Device/format switch stops the engine silently; make it visible.
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { _ in print("mic: ⚠️ engine configuration changed → engine stopped") }

        let w = try WavWriter(url: url, format: format)
        writer = w
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            w.write(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        writer?.close()
    }
}
