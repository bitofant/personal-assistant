import Foundation
import Testing
@testable import PACore

private func t(_ text: String, _ start: Double, _ end: Double? = nil) -> TimedToken { TimedToken(text, start: start, end: end ?? start + 0.2) }
private func texts(_ w: [TimedWord]) -> [String] { w.map(\.text) }

@Suite struct WordsFromTokensTests {
    @Test func joinsContinuationTokensAndStripsMarkers() {
        let w = wordsFromTokens([t("▁Hel", 0, 0.2), t("lo", 0.2, 0.4), t("<blank>", 0.4), t(" world", 0.5, 0.9), t("!", 0.9, 1.0)])
        #expect(w == [TimedWord("Hello", start: 0, end: 0.4), TimedWord("world!", start: 0.5, end: 1.0)])
    }

    @Test func leadingContinuationStartsAWord() {
        #expect(texts(wordsFromTokens([t("lo", 0), t("▁x", 1)])) == ["lo", "x"])
        #expect(wordsFromTokens([t("▁", 0)]).isEmpty)
    }
}

@Suite struct LiveWordAssemblerTests {
    @Test func holdsTrailingWordUntilNextWindow() {
        var a = LiveWordAssembler()
        #expect(texts(a.add([t("▁shall", 1), t("▁we", 1.5), t("▁sta", 2)])) == ["shall", "we"])
        // Next window continues the cut word ("sta" + "rt") — must not become two words.
        #expect(texts(a.add([t("rt", 2.2), t("▁now", 3), t("▁please", 4)])) == ["start", "now"])
        #expect(texts(a.flush()) == ["please"])
        #expect(a.flush().isEmpty)
    }

    @Test func reDecodedWordIsNotDuplicated() {
        var a = LiveWordAssembler()
        _ = a.add([t("▁the", 1), t("▁relea", 2)])
        // Window 2 re-decoded the previous last word in full (FluidAudio #897): same start time → held copy dropped.
        let w = a.add([t("▁release", 2), t("▁first", 3), t("▁ok", 4)])
        #expect(texts(w) == ["release", "first"])
        #expect(w[0].start == 2)
    }

    @Test func silentWindowFlushesHeldWord() {
        var a = LiveWordAssembler()
        _ = a.add([t("▁bye", 1)])
        #expect(texts(a.add([t("<blank>", 6)])) == ["bye"])
        #expect(texts(a.add([])) == [])
    }

    @Test func noTokensLost() {
        // Every word comes out exactly once across arbitrary window cuts.
        let words = (0..<40).map { i in t(i % 3 == 0 ? "▁w\(i)" : "x\(i)", Double(i)) }
        var a = LiveWordAssembler()
        var out: [TimedWord] = []
        var i = 0
        for size in [3, 7, 1, 5, 9, 2, 13] where i < words.count {
            out += a.add(Array(words[i..<min(i + size, words.count)]))
            i += size
        }
        out += a.flush()
        #expect(out == wordsFromTokens(words))
    }
}

@Suite struct LiveChunkBuilderTests {
    @Test func seqPerStreamAndSegments() throws {
        var b = LiveChunkBuilder(startedAt: Date(timeIntervalSince1970: 1_790_233_203), meeting: nil)
        let first = b.chunk(.system, words: [TimedWord("Hi", start: 1, end: 1.3), TimedWord("all.", start: 1.4, end: 1.8)], speaker: liveOthersLabel)
        let c0 = try #require(first)
        #expect(c0.seq == 0 && c0.stream == .system && c0.ended == nil)
        #expect(c0.segments == [TranscriptSegment(start: 1, end: 1.8, speaker: "Others", text: "Hi all.")])
        #expect(c0.startedAt == "2026-09-24T07:00:03Z")
        let mic = b.chunk(.mic, words: [TimedWord("Yes", start: 2, end: 2.2)], speaker: "Me")
        #expect(mic?.seq == 0)
        let empty = b.chunk(.system, words: [], speaker: liveOthersLabel)
        #expect(empty == nil) // nothing to send: no seq used
        let next = b.chunk(.system, words: [TimedWord("x", start: 3, end: 3.1)], speaker: liveOthersLabel)
        #expect(next?.seq == 1)
        let last = b.chunk(.system, words: [], speaker: liveOthersLabel, ended: true)
        let end = try #require(last)
        #expect(end.seq == 2 && end.ended == true && end.segments.isEmpty)
    }

    @Test func encodesLikeTheFixture() throws {
        // Same keys the server parses (shared/fixtures/live-chunk.json); `ended` omitted when nil.
        let c = try JSONDecoder().decode(LiveChunk.self, from: fixture("live-chunk.json"))
        #expect(c.stream == .system && c.seq == 0 && c.meeting?.title == "Alice / Bob 1:1" && c.ended == nil)
        let json = String(decoding: try JSONEncoder().encode(c), as: UTF8.self)
        #expect(!json.contains("ended"))
        #expect(try JSONDecoder().decode(LiveChunkResponse.self, from: fixture("live-chunk-response.json")).accepted)
    }

    @Test func requests() throws {
        let server = URL(string: "https://pa.example")!
        let c = LiveChunk(stream: .mic, seq: 3, startedAt: "x", meeting: nil, segments: [])
        let r = try liveChunkRequest(server: server, token: "tok", id: "abc", chunk: c)
        #expect(r.method == "POST" && r.url.absoluteString == "https://pa.example/api/device/transcripts/abc/live")
        #expect(r.headers["Content-Type"] == "application/json" && r.headers["Authorization"] == "Bearer tok")
        let d = discardLiveRequest(server: server, token: "tok", id: "abc")
        #expect(d.method == "DELETE" && d.body == nil && d.url.path == "/api/device/transcripts/abc/live")
    }
}

@Suite struct LiveOutboxTests {
    private func chunk(_ seq: Int) -> LiveChunk { LiveChunk(stream: .system, seq: seq, startedAt: "x", meeting: nil, segments: []) }
    private let now = Date(timeIntervalSince1970: 1000)

    @Test func sendsInOrderAndPausesAfterTransientFailure() {
        var o = LiveOutbox()
        o.enqueue(chunk(0))
        o.enqueue(chunk(1))
        #expect(o.next(now: now)?.seq == 0)
        o.record(.failed(ApiError(status: nil, "offline")), for: chunk(0), now: now)
        #expect(o.next(now: now.addingTimeInterval(5)) == nil) // pausing
        // Same chunk (same seq) again after the pause: server dedups if the first try did land.
        #expect(o.next(now: now.addingTimeInterval(LiveOutbox.pauseAfterFailure))?.seq == 0)
        o.record(.sent, for: chunk(0), now: now)
        #expect(o.next(now: now.addingTimeInterval(60))?.seq == 1)
    }

    @Test func boundedDropsOldest() {
        var o = LiveOutbox()
        for i in 0...LiveOutbox.maxPending { o.enqueue(chunk(i)) }
        #expect(o.pending.count == LiveOutbox.maxPending && o.dropped == 1 && o.next(now: now)?.seq == 1)
    }

    @Test func stopsOnFinalDeletedOrUnauthorized() {
        for r: LiveSendResult in [.finished, .failed(ApiError(status: 401, "revoked"))] {
            var o = LiveOutbox()
            o.enqueue(chunk(0))
            o.record(r, for: chunk(0), now: now)
            #expect(o.stopped != nil && o.next(now: now.addingTimeInterval(3600)) == nil)
            o.enqueue(chunk(1))
            #expect(o.pending.isEmpty)
        }
    }

    @Test func badChunkSkippedNotRetried() {
        var o = LiveOutbox()
        o.enqueue(chunk(0))
        o.enqueue(chunk(1))
        o.record(.failed(ApiError(status: 400, "Invalid live chunk")), for: chunk(0), now: now)
        #expect(o.stopped == nil && o.next(now: now)?.seq == 1)
    }

    @Test func recordMatchesTheSentChunkNotTheHead() {
        // Overflow trimmed the head while chunk 1 was in flight: its success must not delete chunk 2.
        var o = LiveOutbox()
        o.enqueue(chunk(1))
        o.enqueue(chunk(2))
        o.record(.sent, for: chunk(0), now: now)
        #expect(o.pending.map(\.seq) == [1, 2])
        o.record(.sent, for: chunk(2), now: now)
        #expect(o.pending.map(\.seq) == [1])
        o.cancel("discarded")
        #expect(o.stopped == "discarded" && o.pending.isEmpty)
    }

    @Test func resultMapping() {
        #expect(liveSendResult(.success(LiveChunkResponse(accepted: true))) == .sent)
        #expect(liveSendResult(.success(LiveChunkResponse(accepted: false))) == .finished)
        #expect(liveSendResult(.failure(ApiError(status: 410, "deleted"))) == .finished)
        #expect(liveSendResult(.failure(ApiError(status: 503, "down"))) == .failed(ApiError(status: 503, "down")))
    }
}

@Suite struct LiveLagTests {
    @Test func percentiles() {
        #expect(liveLagSummary([]) == nil)
        #expect(liveLagSummary([3]) == "lag p50 3.0s, p95 3.0s, max 3.0s over 1 chunks")
        let lags = (1...20).map(Double.init).reversed()
        #expect(liveLagSummary(Array(lags)) == "lag p50 11.0s, p95 19.0s, max 20.0s over 20 chunks")
    }
}
