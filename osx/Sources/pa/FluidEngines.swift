import FluidAudio
import Foundation
import PACore

// FluidAudio adapters (API as of v0.17.4, see Package.swift pin). Models download to FluidAudio's cache on first
// load. Only file → words / turns; merging + labels live in PACore.

/// Parakeet TDT v3 (multilingual) on CoreML/ANE. Sendable: `AsrManager` is an actor.
final class FluidTranscriber: Transcriber {
    let model = "parakeet-tdt-0.6b-v3"
    private let asr: AsrManager

    private init(asr: AsrManager) { self.asr = asr }

    static func load() async throws -> FluidTranscriber {
        let v = AsrModelVersion.v3
        let models = try await AsrModels.downloadAndLoad(version: v)
        // Same config as fluidaudiocli `transcribe` → bench-asr.sh numbers carry over.
        let asr = AsrManager(config: ASRConfig(tdtConfig: TdtConfig(blankId: v.blankId), encoderHiddenSize: v.encoderHiddenSize))
        try await asr.loadModels(models)
        return FluidTranscriber(asr: asr)
    }

    func words(in audio: URL) async throws -> [TimedWord] {
        // Fresh decoder state per file: it carries context across calls.
        var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        // URL path resamples to 16 kHz mono itself (stereo tap WAV OK) and goes disk-backed for long files.
        let r = try await asr.transcribe(audio, decoderState: &state)
        return buildWordTimings(from: r.tokenTimings ?? []).map { TimedWord($0.word, start: $0.startTime, end: $0.endTime) }
    }
}

/// Offline pipeline (segmentation + embeddings + VBx clustering); speaker ids "S1", "S2", ….
/// `OfflineDiarizerManager` isn't Sendable, but after `prepareModels` it only reads its models (its own comment).
final class FluidDiarizer: SpeakerDiarizer, @unchecked Sendable {
    let model = "fluidaudio-offline-vbx-0.17.4"
    private let manager: OfflineDiarizerManager

    private init(manager: OfflineDiarizerManager) { self.manager = manager }

    static func load() async throws -> FluidDiarizer {
        let m = OfflineDiarizerManager()
        try await m.prepareModels()
        return FluidDiarizer(manager: m)
    }

    func turns(in audio: URL) async throws -> [SpeakerTurn] {
        try await manager.process(audio).segments.map {
            SpeakerTurn($0.speakerId, start: Double($0.startTimeSeconds), end: Double($0.endTimeSeconds))
        }
    }
}
