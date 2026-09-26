import Foundation
import Testing
@testable import PACore

/// Scripted server: per-call result, default = success.
private actor FakeServer {
    var calls: [String] = []
    var script: [Result<Bool, ApiError>] = []
    /// Runs during the send (before it returns) to simulate a concurrent enqueue.
    var during: (@Sendable () async -> Void)?

    func setScript(_ s: [Result<Bool, ApiError>]) { script = s }
    func setDuring(_ f: (@Sendable () async -> Void)?) { during = f }

    func send(_ u: TranscriptUpload) async throws -> TranscriptUploadResponse {
        calls.append(u.id)
        if let f = during { during = nil; await f() }
        let r = script.isEmpty ? .success(true) : script.removeFirst()
        return TranscriptUploadResponse(id: u.id, created: try r.get())
    }
}

private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var t = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { lock.withLock { t } }
    func advance(_ s: TimeInterval) { lock.withLock { t += s } }
}

private func upload(_ n: Int) -> TranscriptUpload {
    TranscriptUpload(
        id: String(format: "00000000-0000-4000-8000-%012d", n), startedAt: "2026-09-26T10:00:00Z", endedAt: "2026-09-26T10:30:00Z",
        meeting: nil, segments: [TranscriptSegment(start: 0, end: 1, speaker: nil, text: "hi \(n)")], asrModel: "m", diarizationModel: nil)
}

private func setup() -> (UploadQueue, FakeServer, Clock, URL) {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pa-queue-\(UUID().uuidString)")
    let server = FakeServer(), clock = Clock()
    let q = UploadQueue(store: UploadQueueStore(dir: dir), now: { clock.now }, send: { try await server.send($0) })
    return (q, server, clock, dir)
}

private func files(_ dir: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
}

@Suite struct UploadQueueTests {
    @Test func classify() {
        #expect(classifyUploadFailure(ApiError(status: nil, "offline")) == .retry)
        #expect(classifyUploadFailure(ApiError(status: 401, "revoked")) == .halt)
        #expect(classifyUploadFailure(ApiError(status: 410, "gone")) == .drop)
        for s in [403, 408, 429, 500, 502, 503] { #expect(classifyUploadFailure(ApiError(status: s, "")) == .retry) }
        for s in [400, 404, 413, 415] { #expect(classifyUploadFailure(ApiError(status: s, "")) == .park) }
    }

    @Test func backoff() {
        #expect([1, 2, 3, 8, 100].map { uploadBackoff(failures: $0) } == [30, 60, 120, 3600, 3600])
    }

    @Test func persistsAndUploadsOldestFirst() async throws {
        let (q, server, clock, dir) = setup()
        try await q.enqueue(upload(2))
        clock.advance(1)
        try await q.enqueue(upload(1))
        #expect(files(dir).count == 2)
        // Survives a restart: a fresh queue on the same dir sees both.
        let q2 = UploadQueue(store: UploadQueueStore(dir: dir), now: { clock.now }, send: { try await server.send($0) })
        let ev = try await q2.drain()
        #expect(ev == [.uploaded(id: upload(2).id, created: true), .uploaded(id: upload(1).id, created: true)])
        #expect(files(dir).isEmpty)
        #expect(try await q2.nextWake() == nil)
    }

    @Test func normalizesIdAndRejectsNonUUID() async throws {
        let (q, _, _, dir) = setup()
        var u = upload(1)
        u.id = u.id.uppercased()
        try await q.enqueue(u)
        #expect(files(dir) == ["\(upload(1).id).json"])
        u.id = "../../etc/passwd"
        await #expect(throws: UsageError.self) { try await q.enqueue(u) }
    }

    @Test func retriesWithBackoffAndStopsPass() async throws {
        let (q, server, clock, dir) = setup()
        try await q.enqueue(upload(1))
        clock.advance(1)
        try await q.enqueue(upload(2))
        await server.setScript([.failure(ApiError(status: 503, "down")), .failure(ApiError(status: nil, "offline"))])

        let ev = try await q.drain()
        #expect(ev.count == 1)
        guard case let .retrying(id, attempt, _, _) = ev[0] else { Issue.record("\(ev)"); return }
        #expect(id == upload(1).id && attempt == 1)
        // Pass stopped: item 2 not tried during an outage.
        #expect(await server.calls == [upload(1).id])
        #expect(try await q.pending().first { $0.upload.id == upload(1).id }?.lastError == "HTTP 503: down")

        // Queue-wide wait: nothing happens before it elapses.
        #expect(try await q.drain() == [])
        #expect(try await q.nextWake() == clock.now.addingTimeInterval(30))
        clock.advance(30)
        // Item 2 (due) goes first, still failing → second failure doubles the queue wait.
        let ev2 = try await q.drain()
        guard case let .retrying(id2, _, at2, _) = ev2.first else { Issue.record("\(ev2)"); return }
        #expect(id2 == upload(2).id && at2 == clock.now.addingTimeInterval(60))
        clock.advance(60)
        #expect(try await q.drain().count == 2)
        #expect(files(dir).isEmpty)
    }

    @Test func goneDropsAndContinues() async throws {
        let (q, server, clock, dir) = setup()
        try await q.enqueue(upload(1))
        clock.advance(1)
        try await q.enqueue(upload(2))
        await server.setScript([.failure(ApiError(status: 410, "deleted"))])
        let ev = try await q.drain()
        #expect(ev == [.dropped(id: upload(1).id, reason: "HTTP 410: deleted"), .uploaded(id: upload(2).id, created: true)])
        #expect(files(dir).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("failed").path))
    }

    @Test func unauthorizedHaltsUntilResume() async throws {
        let (q, server, clock, dir) = setup()
        try await q.enqueue(upload(1))
        try await q.enqueue(upload(2))
        await server.setScript([.failure(ApiError(status: 401, "Unknown or revoked device token."))])
        #expect(try await q.drain() == [.halted(reason: "HTTP 401: Unknown or revoked device token.")])
        #expect(await q.halted == "Unknown or revoked device token.")
        // Nothing lost, attempt not counted, no further sends while halted — even long after.
        #expect(try await q.pending().map(\.attempts) == [0, 0])
        clock.advance(86400)
        try await q.enqueue(upload(3))
        #expect(try await q.drain() == [])
        #expect(try await q.nextWake() == nil)
        #expect(await server.calls.count == 1)
        #expect(files(dir).count == 3)

        await q.resume()
        #expect(try await q.drain().count == 3)
        #expect(files(dir).isEmpty)
    }

    @Test func badRequestParksKeepsData() async throws {
        let (q, server, _, dir) = setup()
        try await q.enqueue(upload(1))
        await server.setScript([.failure(ApiError(status: 413, "too big"))])
        #expect(try await q.drain() == [.parked(id: upload(1).id, reason: "HTTP 413: too big")])
        #expect(files(dir).isEmpty)
        #expect(files(dir.appendingPathComponent("failed")) == ["\(upload(1).id).json"])
        // Not retried; re-enqueue (fixed content) un-parks.
        #expect(try await q.drain() == [])
        try await q.enqueue(upload(1))
        #expect(files(dir.appendingPathComponent("failed")).isEmpty)
        #expect(try await q.drain() == [.uploaded(id: upload(1).id, created: true)])
    }

    @Test func reenqueueDuringSendIsNotLost() async throws {
        let (q, server, _, dir) = setup()
        try await q.enqueue(upload(1))
        var n = upload(1)
        n.segments[0].text = "newer"
        let newer = n
        await server.setDuring { try? await q.enqueue(newer) }
        #expect(try await q.drain().count == 1)
        // Newer version still pending (sent version settled without deleting it).
        #expect(try await q.pending().map(\.upload) == [newer])
        #expect(files(dir).count == 1)
        #expect(try await q.drain() == [.uploaded(id: upload(1).id, created: true)])
        #expect(await server.calls.count == 2)
    }

    @Test func corruptFileMovedAside() async throws {
        let (q, _, _, dir) = setup()
        try await q.enqueue(upload(1))
        try Data("garbage".utf8).write(to: dir.appendingPathComponent("junk.json"))
        let ev = try await q.drain()
        #expect(ev == [.corrupt(file: "junk.json"), .uploaded(id: upload(1).id, created: true)])
        #expect(files(dir.appendingPathComponent("failed")) == ["junk.json"])
    }
}
