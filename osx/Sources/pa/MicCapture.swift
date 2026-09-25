import AudioToolbox
import AVFoundation
import CoreAudio
import PACore

/// Mic via AVAudioEngine, optionally with voice processing (AEC) so remote voices
/// from laptop speakers are suppressed in the mic stream.
/// @unchecked: config-change observer calls back on an arbitrary thread; spike-grade.
final class MicCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var observer: NSObjectProtocol?
    private(set) var writer: WavWriter?

    /// `deviceUID` nil = system default input.
    func start(voiceProcessing: Bool, deviceUID: String?, writingTo url: URL) throws {
        let input = engine.inputNode
        var wanted: AudioObjectID?
        if let deviceUID {
            wanted = try listInputDevices().first(where: { $0.uid == deviceUID })?.objectID
            if wanted == nil { print("mic: ⚠️ configured mic \(deviceUID) not connected → system default") }
        }
        if let wanted { try setDevice(input, wanted) }
        if voiceProcessing {
            try input.setVoiceProcessingEnabled(true)
            // VP ducks all other audio by default, incl. the meeting itself.
            input.voiceProcessingOtherAudioDuckingConfiguration =
                AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
            // Enabling VP may reset the unit to the default device; re-apply.
            if let wanted, currentDevice(input) != wanted { try setDevice(input, wanted) }
        }
        // Read format after enabling VP / switching device: both change channel count/rate.
        let format = input.outputFormat(forBus: 0)
        let actual = currentDevice(input)
        print("mic: \(actual.map(deviceName) ?? "?"), \(describe(format)), voice processing \(voiceProcessing ? "on" : "off")")
        if let wanted, actual != wanted { print("mic: ⚠️ wanted \(deviceName(wanted)), unit reports another device") }
        // Don't touch mainMixerNode here: with VP on, engine.start fails -10875 (outputNode kAUInitialize), verified live.
        // Device/format switch stops the engine silently (live: fires when the tap aggregate is created) → restart.
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in self?.configurationChanged() }

        let w = try WavWriter(url: url, format: format)
        writer = w
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            w.write(buffer)
        }
        engine.prepare()
        try engine.start()
        printVPState()
    }

    /// Muted/bypassed VP = silent buffers without error; suspected cause of all-zero mic.
    private func printVPState() {
        let i = engine.inputNode
        guard i.isVoiceProcessingEnabled else { return }
        print("mic: VP bypassed=\(i.isVoiceProcessingBypassed), inputMuted=\(i.isVoiceProcessingInputMuted), AGC=\(i.isVoiceProcessingAGCEnabled)")
    }

    private func configurationChanged() {
        let f = engine.inputNode.outputFormat(forBus: 0)
        print("mic: ⚠️ engine configuration changed (running: \(engine.isRunning), now \(describe(f)))")
        // WAV format is fixed at start; a different format would corrupt the file.
        guard let w = writer, f.sampleRate == w.format.sampleRate, f.channelCount == w.format.channelCount else {
            print("mic: ⚠️ format changed mid-recording → not restarting")
            return
        }
        do {
            try engine.start()
            print("mic: engine restarted")
            printVPState()
        } catch {
            print("mic: ⚠️ engine restart failed: \(error)")
        }
    }

    private func setDevice(_ node: AVAudioInputNode, _ dev: AudioObjectID) throws {
        guard let unit = node.audioUnit else { throw SpikeError(description: "mic: input node has no audio unit") }
        var d = dev
        try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                       &d, UInt32(MemoryLayout<AudioObjectID>.size)), "set mic device \(deviceName(dev))")
    }

    /// Device the IO unit actually uses (ground truth, vs. what we asked for).
    private func currentDevice(_ node: AVAudioInputNode) -> AudioObjectID? {
        guard let unit = node.audioUnit else { return nil }
        var d = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let st = AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &d, &size)
        return st == noErr ? d : nil
    }

    func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        writer?.close()
    }
}
