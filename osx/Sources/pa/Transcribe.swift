import AVFoundation
import Foundation
import PACore

/// Spike: test-capture WAVs → TranscriptUpload JSON next to them (+ optional upload). Bare binary is fine:
/// reading files + CoreML need no TCC.
func transcribe(_ o: TranscribeOptions) async throws {
    let dir = URL(fileURLWithPath: ((o.dir ?? "~/pa-test-capture") as NSString).expandingTildeInPath, isDirectory: true)
    let cap = try pickCapture(findCaptures(try FileManager.default.contentsOfDirectory(atPath: dir.path)), stamp: o.stamp, dir: dir.path)
    // findCaptures only returns parseable stamps.
    let startedAt = parseCaptureStamp(cap.stamp, timeZone: .current)!
    let mic = cap.mic.map { dir.appending(path: $0) }
    let system = cap.system.map { dir.appending(path: $0) }
    let me = o.me ?? (NSFullUserName().isEmpty ? "Me" : NSFullUserName())
    print("recording \(cap.stamp): mic \(cap.mic ?? "—"), system \(cap.system ?? "—"), mic speaker \"\(me)\"")

    print("loading models (first run downloads them) …")
    var t0 = Date()
    let transcriber = try await FluidTranscriber.load()
    var diarizer: FluidDiarizer?
    if o.diarize, system != nil { diarizer = try await FluidDiarizer.load() }
    print(String(format: "models ready in %.1fs", Date().timeIntervalSince(t0)))

    t0 = Date()
    let t = try await transcribeRecording(mic: mic, system: system, transcriber: transcriber, diarizer: diarizer, micSpeaker: me)
    let elapsed = Date().timeIntervalSince(t0)
    for w in t.warnings { eprint("warning: \(w)") }

    let duration = try [mic, system].compactMap { $0 }.map(wavSeconds).max() ?? 0
    let out = dir.appending(path: transcriptFileName(stamp: cap.stamp))
    // Reuse an earlier run's id → re-upload replaces on the server instead of duplicating.
    let id = (try? JSONDecoder().decode(TranscriptUpload.self, from: Data(contentsOf: out))).flatMap { UUID(uuidString: $0.id) } ?? UUID()
    let u = makeTranscriptUpload(id: id, startedAt: startedAt, duration: duration, meeting: nil, transcription: t)
    try encodeTranscriptUpload(u).write(to: out, options: .atomic)

    print("---")
    for s in u.segments.prefix(20) { print(formatSegmentLine(s)) }
    if u.segments.count > 20 { print("… \(u.segments.count - 20) more") }
    print("---")
    let speakers = Set(u.segments.compactMap(\.speaker)).sorted()
    // Both streams sequentially; RTFx vs the longer one.
    print(String(format: "audio %.1fs, transcribe+diarize %.1fs (%.0fx realtime), %d segments, speakers: %@",
                 duration, elapsed, elapsed > 0 ? duration / elapsed : 0, u.segments.count,
                 speakers.isEmpty ? "—" : speakers.joined(separator: ", ")))
    print("asr \(u.asrModel), diarization \(u.diarizationModel ?? "—")")
    print("→ \(out.path)")
    if o.upload { try await upload(out.path) }
}

private func wavSeconds(_ url: URL) throws -> Double {
    let f = try AVAudioFile(forReading: url)
    return Double(f.length) / f.fileFormat.sampleRate
}
