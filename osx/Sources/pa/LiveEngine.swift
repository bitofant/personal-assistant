// preconcurrency: AVAudioPCMBuffer isn't Sendable; WavWriter hands each buffer over once (never touched again).
@preconcurrency import AVFoundation
import FluidAudio
import Foundation
import PACore

// Live preview while recording (written vs FluidAudio v0.17.4 source, not compiled yet). WavWriter queue (16 kHz mono) →
// per-stream `SlidingWindowAsrManager` → PACore `LiveWordAssembler` / `LiveChunkBuilder` / `LiveOutbox` → server.
// Best effort: any failure here only loses the preview; WAVs + the offline pass make the real transcript.

enum LiveASR {
    static let version = AsrModelVersion.v3
    /// 8 s left + 5 s chunk + 2 s right = the model's fixed 15 s window. A word is decoded once the audio reaches
    /// chunk end + right context → 2–7 s after it's spoken (default 11 s chunk would be up to 13 s).
    static let config = SlidingWindowAsrConfig(
        chunkSeconds: 5, hypothesisChunkSeconds: 1, leftContextSeconds: 8, rightContextSeconds: 2,
        minContextForConfirmation: 10, confirmationThreshold: 0.85
    ).applying(tdtConfig: TdtConfig(blankId: version.blankId))
}

/// Loaded once per daemon and kept (unlike the offline models): loading per meeting = seconds of missing preview.
actor LiveModels {
    static let shared = LiveModels()
    /// A Task, not the value: preload + first recording may ask at once (actor reentrancy) → must not load twice.
    private var loading: Task<AsrModels, Error>?

    func get() async throws -> AsrModels {
        let t = loading ?? Task { try await AsrModels.downloadAndLoad(version: LiveASR.version) }
        loading = t
        do { return try await t.value } catch {
            loading = nil // e.g. offline at first download → next recording retries
            throw error
        }
    }
}

private struct PCM: @unchecked Sendable { let buffer: AVAudioPCMBuffer }

typealias LiveSend = @Sendable (LiveChunk) async -> Result<LiveChunkResponse, ApiError>

/// Chunk assembly + sending for one recording (actor: ASR consumers, ticker and hooks touch it concurrently).
private actor LiveState {
    private var builder: LiveChunkBuilder
    private var assemblers: [LiveStream: LiveWordAssembler] = [.mic: LiveWordAssembler(), .system: LiveWordAssembler()]
    private var outbox = LiveOutbox()
    private let speakers: [LiveStream: String]
    private let id: String
    private let send: LiveSend
    private let log: @Sendable (String) -> Void
    private var pumping = false
    private var failing: String?
    private var sentAny = false
    private(set) var discarded = false
    private let startedAt: Date
    private var lags: [Double] = []

    init(meta: RecordingMeta, micSpeaker: String, send: @escaping LiveSend, log: @escaping @Sendable (String) -> Void) {
        builder = LiveChunkBuilder(startedAt: meta.startedAt, meeting: meta.meeting)
        speakers = [.mic: micSpeaker, .system: liveOthersLabel]
        id = meta.id
        startedAt = meta.startedAt
        self.send = send
        self.log = log
    }

    var summary: String { liveLagSummary(lags) ?? "nothing sent" }

    func add(_ stream: LiveStream, tokens: [TimedToken]) {
        enqueue(stream, words: assemblers[stream, default: LiveWordAssembler()].add(tokens))
    }

    func finishStream(_ stream: LiveStream) {
        enqueue(stream, words: assemblers[stream, default: LiveWordAssembler()].flush())
    }

    func setMeeting(_ m: MeetingMeta?) { builder.meeting = m }

    func end() {
        guard !discarded, let c = builder.chunk(.system, words: [], speaker: liveOthersLabel, ended: true) else { return }
        outbox.enqueue(c)
    }

    func discard() {
        discarded = true
        outbox.cancel("recording discarded")
    }

    var idle: Bool { outbox.pending.isEmpty || outbox.stopped != nil }

    private func enqueue(_ stream: LiveStream, words: [TimedWord]) {
        guard !discarded, let c = builder.chunk(stream, words: words, speaker: speakers[stream] ?? liveOthersLabel) else { return }
        outbox.enqueue(c)
        Task { await self.pump() }
    }

    /// Sends what's due, in order. Reentrant calls return at once (one sender at a time).
    func pump() async {
        guard !pumping else { return }
        pumping = true
        defer { pumping = false }
        while let c = outbox.next(now: Date()) {
            let r = liveSendResult(await send(c))
            outbox.record(r, for: c, now: Date())
            switch r {
            case .sent:
                if let end = c.segments.map(\.end).max() { lags.append(Date().timeIntervalSince(startedAt) - end) }
                if !sentAny { log("live \(id): preview streaming to server") }
                if let f = failing { log("live \(id): server reachable again (was: \(f))") }
                sentAny = true
                failing = nil
            case .failed(let e):
                if failing == nil { log("live \(id): ⚠️ send failed: \(e) → retrying, preview may lag") }
                failing = e.description
            case .finished:
                break
            }
            if let why = outbox.stopped {
                log("live \(id): stopped (\(why))")
                return
            }
        }
    }
}

/// One recording's live preview. `sink(_:)` closures run on capture threads; everything else from `pa run`'s task.
final class LivePreview: @unchecked Sendable {
    private let state: LiveState
    private let feeds: [LiveStream: AsyncStream<PCM>.Continuation]
    private let id: String
    private let discardRemote: @Sendable () async -> Void
    private let log: @Sendable (String) -> Void

    init(
        meta: RecordingMeta, micSpeaker: String, send: @escaping LiveSend,
        discardRemote: @escaping @Sendable () async -> Void, log: @escaping @Sendable (String) -> Void
    ) {
        state = LiveState(meta: meta, micSpeaker: micSpeaker, send: send, log: log)
        id = meta.id
        self.discardRemote = discardRemote
        self.log = log
        // Unbounded: dropping audio would shift every later timestamp. Parakeet runs ≫ real time, so it drains.
        let (micIn, micFeed) = AsyncStream.makeStream(of: PCM.self)
        let (systemIn, systemFeed) = AsyncStream.makeStream(of: PCM.self)
        let feeds: [LiveStream: AsyncStream<PCM>.Continuation] = [.mic: micFeed, .system: systemFeed]
        self.feeds = feeds
        let (state, id, log) = (state, meta.id, log)
        Task {
            let models: AsrModels
            do { models = try await LiveModels.shared.get() } catch {
                log("live \(id): ⚠️ ASR models unavailable: \(error) → no preview for this recording")
                for c in feeds.values { c.finish() } // later yields are dropped: no audio piles up
                return
            }
            let ticker = Task {
                // Retries after a failure pause; pump also runs on every new chunk.
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(3))
                    await state.pump()
                }
            }
            async let mic: Void = Self.transcribe(.mic, input: micIn, models: models, state: state, log: log, id: id)
            async let system: Void = Self.transcribe(.system, input: systemIn, models: models, state: state, log: log, id: id)
            _ = await (mic, system)
            await state.end()
            // Give the tail + end marker a moment to go out; after that the final transcript replaces it anyway.
            for _ in 0..<20 {
                await state.pump()
                if await state.idle { break }
                try? await Task.sleep(for: .seconds(1))
            }
            ticker.cancel()
            log("live \(id): done, \(await state.summary)")
        }
    }

    private static func transcribe(
        _ s: LiveStream, input: AsyncStream<PCM>, models: AsrModels, state: LiveState,
        log: @Sendable (String) -> Void, id: String
    ) async {
        let asr = SlidingWindowAsrManager(config: LiveASR.config)
        do {
            try await asr.loadModels(models)
            try await asr.startStreaming(source: s == .mic ? .microphone : .system)
        } catch {
            log("live \(id) \(s.rawValue): ⚠️ streaming ASR failed to start: \(error)")
            for await _ in input {} // drain until the recording stops
            return
        }
        // Subscribe before feeding: updates yielded with no subscriber are lost.
        let updates = await asr.transcriptionUpdates
        let consumer = Task {
            // Each update = that window's new tokens on the stream's timeline (= since recording start); the
            // confirmed/volatile flag is about confidence, not stability → every update is used.
            for await u in updates {
                await state.add(s, tokens: u.tokenTimings.map { TimedToken($0.token, start: $0.startTime, end: $0.endTime) })
            }
        }
        for await p in input { await asr.streamAudio(p.buffer) }
        // Recording stopped: decode the tail (no right context), then end the updates stream.
        do { _ = try await asr.finish() } catch { log("live \(id) \(s.rawValue): ⚠️ \(error)") }
        await asr.cancel()
        await consumer.value
        await state.finishStream(s)
        // No `asr.cleanup()`: it unloads models, and these are shared with later recordings (LiveModels).
    }

    /// For `WavWriter`: per written buffer, on its queue. Already 16 kHz mono Float32 (FluidAudio's fast path, no
    /// per-buffer resample) and fresh per call → no copy.
    func sink(_ s: LiveStream) -> @Sendable (AVAudioPCMBuffer) -> Void {
        let feed = feeds[s]
        return { b in feed?.yield(PCM(buffer: b)) }
    }

    func setMeeting(_ m: MeetingMeta?) {
        Task { await state.setMeeting(m) }
    }

    /// Capture stopped: finish decoding, send the tail + end marker (in the background).
    func stop() {
        for f in feeds.values { f.finish() }
    }

    /// Too short to keep: nothing more is sent and the server drops what it has.
    func discard() {
        let (state, discardRemote, log, id) = (state, discardRemote, log, id)
        Task {
            await state.discard()
            await discardRemote()
            log("live \(id): preview discarded")
        }
        stop()
    }
}
