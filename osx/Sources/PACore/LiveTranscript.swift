import Foundation

// Live preview while recording: streaming ASR window updates → final words → segments → chunks for the server.
// Pure; `pa/LiveEngine.swift` feeds it from FluidAudio. Best effort: the offline pass still makes the real transcript.

/// One ASR token; `text` keeps the SentencePiece word-start marker (`▁` or a leading space). Seconds from recording start.
public struct TimedToken: Equatable, Sendable {
    public var text: String
    public var start: Double
    public var end: Double

    public init(_ text: String, start: Double, end: Double) {
        self.text = text
        self.start = start
        self.end = end
    }
}

func startsWord(_ token: String) -> Bool { token.hasPrefix("▁") || token.hasPrefix(" ") }

private func isSpecial(_ token: String) -> Bool { token.isEmpty || token == "<blank>" || token == "<pad>" }

/// Tokens → words (word = word-start token + following continuation tokens).
public func wordsFromTokens(_ tokens: [TimedToken]) -> [TimedWord] {
    var out: [TimedWord] = []
    for t in tokens where !isSpecial(t.text) {
        if startsWord(t.text) || out.isEmpty {
            out.append(TimedWord(String(t.text.drop(while: { $0 == "▁" || $0 == " " })), start: t.start, end: t.end))
        } else {
            out[out.count - 1].text += t.text
            out[out.count - 1].end = t.end
        }
    }
    return out.filter { !$0.text.isEmpty }
}

/// Per stream. Each sliding-window update = that window's new tokens (FluidAudio dedups against earlier windows), but
/// its last word may be cut at the window edge or re-decoded whole by the next window (FluidAudio #897). So the
/// trailing word is held back until the next update shows which: overlap in time = re-decoded (held copy dropped),
/// otherwise prepended (a continuation token then joins it). Don't emit it early: duplicates/split words.
public struct LiveWordAssembler: Sendable {
    private var held: [TimedToken] = []

    public init() {}

    /// Words that are now final.
    public mutating func add(_ update: [TimedToken]) -> [TimedWord] {
        let tokens = update.filter { !isSpecial($0.text) }
        // Silent window: nothing can continue/re-decode the held word anymore.
        guard let first = tokens.first else { return flush() }
        var all = tokens
        if let lastHeld = held.last, first.start > lastHeld.start { all = held + tokens }
        let cut = all.lastIndex(where: { startsWord($0.text) }) ?? 0
        held = Array(all[cut...])
        return wordsFromTokens(Array(all[..<cut]))
    }

    /// End of stream (or silence): the held word is final.
    public mutating func flush() -> [TimedWord] {
        defer { held = [] }
        return wordsFromTokens(held)
    }
}

/// Builds `LiveChunk`s for one recording; seq per stream from 0. Meeting may change (ad-hoc call relabelled).
public struct LiveChunkBuilder: Sendable {
    public let startedAt: String
    public var meeting: MeetingMeta?
    private var nextSeq: [LiveStream: Int] = [:]

    public init(startedAt: Date, meeting: MeetingMeta?) {
        self.startedAt = isoTimestamp(startedAt)
        self.meeting = meeting
    }

    /// nil = nothing to send (no words and not the end marker).
    public mutating func chunk(_ stream: LiveStream, words: [TimedWord], speaker: String, ended: Bool = false) -> LiveChunk? {
        let segments = groupSegments(words, speakers: Array(repeating: speaker, count: words.count))
        guard !segments.isEmpty || ended else { return nil }
        let seq = nextSeq[stream, default: 0]
        nextSeq[stream] = seq + 1
        return LiveChunk(stream: stream, seq: seq, startedAt: startedAt, meeting: meeting, segments: segments, ended: ended ? true : nil)
    }
}

/// Speaker label for live system audio (not diarized live; real speakers come with the final transcript).
public let liveOthersLabel = "Others"

public enum LiveSendResult: Equatable, Sendable {
    case sent
    /// Final transcript already stored (`accepted: false`), or deleted on the server (410): stop for this recording.
    case finished
    case failed(ApiError)
}

/// In-memory outbox for one recording. Unsent chunks are kept (bounded) and resent in order with their own seq
/// (server dedups if one did arrive), so a short blip doesn't lose text. Not persisted: the final upload covers it.
public struct LiveOutbox: Sendable {
    public static let maxPending = 120 // ~10 min of 5 s chunks per stream pair
    public static let pauseAfterFailure: TimeInterval = 15

    public private(set) var pending: [LiveChunk] = []
    public private(set) var stopped: String?
    /// Chunks dropped because the outbox overflowed.
    public private(set) var dropped = 0
    private var pausedUntil: Date = .distantPast

    public init() {}

    public mutating func enqueue(_ c: LiveChunk) {
        guard stopped == nil else { return }
        pending.append(c)
        if pending.count > Self.maxPending {
            pending.removeFirst(pending.count - Self.maxPending)
            dropped += 1
        }
    }

    /// Next chunk to send, or nil (empty, stopped, or pausing after a failure).
    public func next(now: Date) -> LiveChunk? {
        stopped == nil && now >= pausedUntil ? pending.first : nil
    }

    /// `c` = the chunk that was sent (matched by stream + seq: with actor reentrancy the outbox may have changed meanwhile).
    public mutating func record(_ r: LiveSendResult, for c: LiveChunk, now: Date) {
        let forget = { (o: inout LiveOutbox) in o.pending.removeAll { $0.stream == c.stream && $0.seq == c.seq } }
        switch r {
        case .sent:
            forget(&self)
        case .finished:
            stop("final transcript already on the server, or deleted there")
        case .failed(let e):
            switch classifyUploadFailure(e) {
            case .retry: pausedUntil = now.addingTimeInterval(Self.pauseAfterFailure)
            case .drop: stop("deleted on the server")
            // 401: the upload queue halts + waits for re-pair; live just stops for this recording.
            case .halt: stop(e.description)
            // Same body fails forever: skip it, keep going with the rest.
            case .park: forget(&self)
            }
        }
    }

    /// Recording discarded: nothing more to send.
    public mutating func cancel(_ reason: String) { stop(reason) }

    private mutating func stop(_ reason: String) {
        stopped = reason
        pending = []
    }
}

/// Response → result (pure). 410 = deleted while recording.
public func liveSendResult(_ r: Result<LiveChunkResponse, ApiError>) -> LiveSendResult {
    switch r {
    case .success(let ok): ok.accepted ? .sent : .finished
    case .failure(let e) where e.status == 410: .finished
    case .failure(let e): .failed(e)
    }
}

/// Speech → server lag per sent chunk: accept time − (recording start + last segment end). Excludes the web poll
/// (≤2 s). Slightly low: capture starts a moment after `startedAt`. mac-check greps "lag p50".
public func liveLagSummary(_ lags: [Double]) -> String? {
    guard !lags.isEmpty else { return nil }
    let s = lags.sorted()
    let p = { (q: Double) in s[min(s.count - 1, Int((Double(s.count - 1) * q).rounded()))] }
    return String(format: "lag p50 %.1fs, p95 %.1fs, max %.1fs over %d chunks", p(0.5), p(0.95), s[s.count - 1], s.count)
}
