import Foundation
import Testing
@testable import PACore

private actor Recorder {
    var sent: [String] = []
    var logs: [String] = []
    var probes = 0
    /// Next results for send / probe (default: success / active).
    var sendScript: [ApiError?] = []
    var probeScript: [Result<DeviceStatus, ApiError>] = []

    func setSend(_ s: [ApiError?]) { sendScript = s }
    func setProbe(_ s: [Result<DeviceStatus, ApiError>]) { probeScript = s }
    func log(_ s: String) { logs.append(s) }

    /// blockNext: next send parks until `release()` → lets a test act while the worker is mid-drain.
    var blockNext = false
    var gate: CheckedContinuation<Void, Never>?
    var blocked: Bool { gate != nil }
    func setBlockNext() { blockNext = true }
    func release() { gate?.resume(); gate = nil }

    func send(_ u: TranscriptUpload) async throws -> TranscriptUploadResponse {
        sent.append(u.id)
        if blockNext {
            blockNext = false
            await withCheckedContinuation { gate = $0 }
        }
        if !sendScript.isEmpty, let e = sendScript.removeFirst() { throw e }
        return TranscriptUploadResponse(id: u.id, created: true)
    }

    func probe() throws -> DeviceMeResponse {
        probes += 1
        let s = try (probeScript.isEmpty ? .success(.active) : probeScript.removeFirst()).get()
        return DeviceMeResponse(deviceId: "d", account: "alice", deviceName: "Mac", status: s)
    }
}

private func upload(_ n: Int) -> TranscriptUpload {
    TranscriptUpload(
        id: String(format: "00000000-0000-4000-8000-%012d", n), startedAt: "2026-09-26T10:00:00Z", endedAt: "2026-09-26T10:30:00Z",
        meeting: nil, segments: [], asrModel: "m", diarizationModel: nil)
}

/// `sleep` = hang until cancelled → only a kick (or cancellation) advances `run()`.
private func setup(sleep: @escaping UploadWorker.Sleep = { _ in try await Task.sleep(nanoseconds: 3_600_000_000_000) })
    -> (UploadWorker, UploadQueue, Recorder)
{
    let rec = Recorder()
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pa-worker-\(UUID().uuidString)")
    let q = UploadQueue(store: UploadQueueStore(dir: dir)) { try await rec.send($0) }
    let w = UploadWorker(queue: q, probe: { try await rec.probe() }, log: { s in Task { await rec.log(s) } }, sleep: sleep)
    return (w, q, rec)
}

/// Polls (≤2s) for an async condition; real concurrency, so no fixed ordering.
private func eventually(_ cond: @Sendable () async throws -> Bool) async rethrows -> Bool {
    for _ in 0..<200 {
        if try await cond() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return false
}

@Suite struct UploadWorkerTests {
    @Test func delay() {
        let t = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(uploadWorkerDelay(halted: true, nextWake: t, now: t) == 60)
        #expect(uploadWorkerDelay(halted: false, nextWake: nil, now: t) == 60)
        #expect(uploadWorkerDelay(halted: false, nextWake: t.addingTimeInterval(-5), now: t) == 0)
        #expect(uploadWorkerDelay(halted: false, nextWake: t.addingTimeInterval(12), now: t) == 12)
        // Capped: the dir is rescanned for items other processes enqueued.
        #expect(uploadWorkerDelay(halted: false, nextWake: t.addingTimeInterval(3000), now: t) == 60)
    }

    @Test func haltedProbesAndResumesWhenActive() async throws {
        let (w, q, rec) = setup()
        try await q.enqueue(upload(1))
        await rec.setSend([ApiError(status: 401, "revoked")])
        await w.step()
        #expect(await q.halted != nil)

        // Unpaired / pending: stays halted, nothing sent; repeated identical probe result logged once.
        await rec.setProbe([.failure(ApiError(status: 401, "revoked")), .failure(ApiError(status: 401, "revoked")), .success(.pending)])
        await w.step()
        await w.step()
        await w.step()
        #expect(await q.halted != nil)
        #expect(await rec.sent.count == 1)
        #expect(await rec.probes == 3)

        // Re-paired → resume + upload in the same step.
        await w.step()
        #expect(await q.halted == nil)
        #expect(await rec.sent.count == 2)
        #expect(try await q.pending().isEmpty)
        #expect(await eventually { await rec.logs.filter { $0.hasPrefix("pairing check:") }.count == 3 })
        #expect(await rec.logs.contains("upload queue resumed (device active again)"))
    }

    @Test func notHaltedNeverProbes() async throws {
        let (w, q, rec) = setup()
        try await q.enqueue(upload(1))
        await w.step()
        #expect(await rec.probes == 0)
        #expect(await rec.sent == [upload(1).id])
    }

    @Test func kickWakesSleepingLoop() async throws {
        let (w, q, rec) = setup()
        let loop = Task { await w.run() }
        // First round: empty queue → sleeps (for an hour, per the fake sleep).
        try await Task.sleep(nanoseconds: 50_000_000)
        try await q.enqueue(upload(1))
        await w.kick()
        #expect(await eventually { await rec.sent == [upload(1).id] })
        // Kick while the worker is mid-drain (not waiting) is remembered: item 2 wasn't in that pass's listing.
        await rec.setBlockNext()
        try await q.enqueue(upload(2))
        await w.kick()
        #expect(await eventually { await rec.blocked })
        try await q.enqueue(upload(3))
        await w.kick()
        await rec.release()
        #expect(await eventually { await rec.sent.count == 3 })
        loop.cancel()
        await loop.value
    }

    @Test func runStopsOnCancel() async {
        let (w, _, _) = setup()
        let loop = Task { await w.run() }
        try? await Task.sleep(nanoseconds: 50_000_000)
        loop.cancel()
        // Hangs here if the kick-waiter leaks past cancellation.
        await loop.value
    }

    @Test func sleepDelayFollowsQueue() async throws {
        let delays = DelayLog()
        let (w, q, rec) = setup(sleep: { s in
            await delays.add(s)
            if await delays.count >= 3 { throw CancellationError() }
        })
        try await q.enqueue(upload(1))
        await rec.setSend([ApiError(status: 503, "down")])
        let loop = Task { await w.run() }
        #expect(await eventually { await delays.count >= 2 })
        loop.cancel()
        await loop.value
        let d = await delays.values
        // After the 503: wait ≈ the 30s backoff (not the 60s idle poll); then the retry succeeds → idle.
        #expect(d[0] > 25 && d[0] <= 30)
        #expect(await rec.sent.count >= 1)
    }

    @Test func queueLines() {
        let q = QueuedUpload(
            upload: upload(1), revision: "r", enqueuedAt: Date(timeIntervalSince1970: 0), attempts: 2,
            nextAttemptAt: Date(timeIntervalSince1970: 1_800_000_000), lastError: "HTTP 503: down")
        #expect(formatQueuedLine(q, parked: false) == "pending \(upload(1).id) attempts=2 next=2027-01-15T08:00:00Z HTTP 503: down")
        var p = q
        p.lastError = nil
        #expect(formatQueuedLine(p, parked: true) == "failed  \(upload(1).id) attempts=2 next=— —")
    }
}

private actor DelayLog {
    var values: [TimeInterval] = []
    var count: Int { values.count }
    func add(_ v: TimeInterval) { values.append(v) }
}
