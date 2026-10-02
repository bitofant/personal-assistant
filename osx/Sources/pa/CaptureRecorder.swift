import Foundation
import PACore

/// `pa run` capture: mic (AVAudioEngine) + global system tap → two WAVs. Either stream alone is still worth keeping.
/// Optional live preview fed from the same buffers (see LiveEngine.swift).
final class CaptureRecorder: AudioRecorder {
    private var mic: MicCapture?
    private var system: SystemAudioTap?
    private let log: (String) -> Void
    /// nil = live preview off (config) / not paired.
    private let makeLive: (RecordingMeta) -> LivePreview?
    private var meta: RecordingMeta?
    private var live: LivePreview?

    init(log: @escaping (String) -> Void, makeLive: @escaping (RecordingMeta) -> LivePreview? = { _ in nil }) {
        self.log = log
        self.makeLive = makeLive
    }

    func prepare(_ meta: RecordingMeta) { self.meta = meta }

    func meetingChanged(_ meeting: MeetingMeta?) { live?.setMeeting(meeting) }

    func willDiscard() {
        live?.discard()
        live = nil
    }

    func start(mic micURL: URL, system systemURL: URL) throws {
        live = meta.flatMap(makeLive)
        var errors: [String] = []
        let m = MicCapture()
        do {
            // Read per recording → `pa set-mic` applies without restarting the daemon.
            try m.start(deviceUID: (try? loadAgentConfig())?.micDeviceUID, writingTo: micURL, sink: live?.sink(.mic))
            mic = m
        } catch {
            m.stop()
            errors.append("mic: \(error)")
        }
        // After the mic: creating the tap aggregate reconfigures the mic engine (MicCapture restarts it).
        let s = SystemAudioTap()
        do {
            try s.start(writingTo: systemURL, name: "pa run", sink: live?.sink(.system))
            system = s
        } catch {
            s.stop()
            errors.append("system: \(error)")
        }
        if mic == nil && system == nil {
            live?.discard()
            live = nil
            throw SpikeError(description: errors.joined(separator: "; "))
        }
        for e in errors { log("⚠️ \(e) → recording the other stream only") }
    }

    func stop() -> [String] {
        mic?.stop()
        system?.stop()
        live?.stop()
        live = nil
        let streams: [(String, WavWriter?)] = [("mic", mic?.writer), ("system", system?.writer)]
        mic = nil
        system = nil
        return streams.flatMap { label, writer -> [String] in
            guard let w = writer else { return [] }
            return streamWarnings(label: label, meter: w.meter, seconds: w.seconds, writeError: w.error.map { e in "\(e)" })
        }
    }
}
