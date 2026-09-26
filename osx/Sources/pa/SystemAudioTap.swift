import AVFoundation
import CoreAudio
import Foundation

/// Global Core Audio tap → private aggregate device → IOProc → WAV.
/// Global, not per-app: user never has interfering audio, and it covers Zoom/browser/anything.
/// Permission ("System Audio Recording Only") prompts on first tap; denial = silent buffers, no error.
final class SystemAudioTap {
    private var tapID = unknownObject
    private var aggregateID = unknownObject
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "pa.system-tap", qos: .userInitiated)
    private(set) var writer: WavWriter?

    func start(writingTo url: URL) throws {
        // No exclusions: pa plays no audio itself.
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        desc.uuid = UUID()
        desc.name = "pa test-capture"
        desc.isPrivate = true
        // Tap must not silence the meeting for the user.
        desc.muteBehavior = .unmuted
        try check(AudioHardwareCreateProcessTap(desc, &tapID), "AudioHardwareCreateProcessTap")

        // Default output (where meeting audio plays), not the system/alert-sound device.
        let output = try defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
        let outputUID = try deviceUID(output)
        let alerts = try defaultDevice(kAudioHardwarePropertyDefaultSystemOutputDevice)
        print("system: aggregate clocked by \(deviceName(output))"
            + (alerts == output ? "" : " (alert sounds go to \(deviceName(alerts)))"))
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "pa-tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: desc.uuid.uuidString,
            ]],
        ]
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "AudioHardwareCreateAggregateDevice")

        var asbd = try readScalar(tapID, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            throw CoreAudioError(what: "tap format unsupported by AVAudioFormat", status: -1)
        }
        print("system: tap format \(describe(format))")
        let w = try WavWriter(url: url, format: format)
        writer = w

        try check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, _, _, _ in
            w.write(bufferList: input)
        }, "AudioDeviceCreateIOProcIDWithBlock")
        try check(AudioDeviceStart(aggregateID, procID), "AudioDeviceStart")
    }

    /// Idempotent; safe after a partial `start`.
    func stop() {
        if aggregateID != unknownObject {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = unknownObject
        }
        procID = nil
        if tapID != unknownObject {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = unknownObject
        }
        writer?.close()
    }
}
