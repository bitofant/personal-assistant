import Foundation

// `pa run` upload loop: drain → sleep until next due (or kick) → repeat; while halted (401), probe pairing.
// I/O injected (probe, sleep, log) → loop logic tested on Linux; `pa` only supplies URLSession + Keychain.

public enum UploadWorkerTiming {
    /// Rescan the queue dir even when idle: another process (`pa transcribe --upload`) may have enqueued.
    public static let idlePoll: TimeInterval = 60
    /// While halted: how often `/api/device/me` is asked whether re-pairing happened.
    public static let haltedPoll: TimeInterval = 60
}

/// Seconds to wait before the next step. Pure.
public func uploadWorkerDelay(halted: Bool, nextWake: Date?, now: Date) -> TimeInterval {
    if halted { return UploadWorkerTiming.haltedPoll }
    guard let w = nextWake else { return UploadWorkerTiming.idlePoll }
    return min(max(w.timeIntervalSince(now), 0), UploadWorkerTiming.idlePoll)
}

public actor UploadWorker {
    public typealias Probe = @Sendable () async throws -> DeviceMeResponse
    public typealias Sleep = @Sendable (TimeInterval) async throws -> Void

    public let queue: UploadQueue
    private let probe: Probe
    private let sleep: Sleep
    private let log: @Sendable (String) -> Void
    private let now: @Sendable () -> Date
    /// Last probe outcome logged; only changes are logged (probe runs every minute while halted).
    private var lastProbe: String?
    private var pendingKick = false
    private var waiter: CheckedContinuation<Void, Never>?

    public init(
        queue: UploadQueue, probe: @escaping Probe, log: @escaping @Sendable (String) -> Void,
        now: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping Sleep = { try await Task.sleep(nanoseconds: UInt64($0 * 1e9)) }
    ) {
        self.queue = queue
        self.probe = probe
        self.log = log
        self.now = now
        self.sleep = sleep
    }

    /// Until cancelled. Errors (disk) are logged, never fatal: the next round retries.
    public func run() async {
        while !Task.isCancelled {
            await step()
            let delay: TimeInterval
            do {
                delay = uploadWorkerDelay(halted: await queue.halted != nil, nextWake: try await queue.nextWake(), now: now())
            } catch {
                log("upload queue: \(error)")
                delay = UploadWorkerTiming.idlePoll
            }
            await waitOrKick(delay)
        }
    }

    /// One round: if halted, probe pairing (resume when active); then drain.
    public func step() async {
        if await queue.halted != nil {
            let state: String
            do {
                let me = try await probe()
                state = me.status == .active ? "active" : "pending approval"
            } catch {
                state = "\(error)"
            }
            if state != lastProbe { log("pairing check: \(state)") }
            lastProbe = state
            guard state == "active" else { return }
            lastProbe = nil
            await queue.resume()
            log("upload queue resumed (device active again)")
        }
        do {
            for e in try await queue.drain() { log(e.description) }
        } catch {
            log("upload queue: \(error)")
        }
    }

    /// Something was enqueued in-process: don't wait out the idle poll.
    public func kick() {
        if let w = waiter {
            waiter = nil
            w.resume()
        } else {
            pendingKick = true
        }
    }

    private func waitOrKick(_ seconds: TimeInterval) async {
        await withTaskGroup(of: Void.self) { g in
            g.addTask { [sleep] in try? await sleep(seconds) }
            g.addTask {
                await withTaskCancellationHandler {
                    await self.waitForKick()
                } onCancel: {
                    Task { await self.cancelWait() }
                }
            }
            await g.next()
            g.cancelAll()
        }
    }

    private func waitForKick() async {
        if pendingKick {
            pendingKick = false
            return
        }
        await withCheckedContinuation { c in
            // onCancel may have run before we got here (its hop found no waiter) → don't hang the group.
            if Task.isCancelled { c.resume() } else { waiter = c }
        }
    }

    private func cancelWait() {
        waiter?.resume()
        waiter = nil
    }
}

/// `pa queue` line: `pending|failed <id> attempts=N next=<iso|—> <lastError|—>`.
public func formatQueuedLine(_ q: QueuedUpload, parked: Bool) -> String {
    let next = parked ? "—" : ISO8601DateFormatter().string(from: q.nextAttemptAt)
    return "\(parked ? "failed " : "pending") \(q.upload.id) attempts=\(q.attempts) next=\(next) \(q.lastError ?? "—")"
}
