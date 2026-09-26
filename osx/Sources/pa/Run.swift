import Foundation
import PACore

// Thin I/O for the upload queue: queue/worker logic lives in PACore (Linux-tested).

func uploadQueueDir() -> URL {
    agentConfigURL().deletingLastPathComponent().appending(path: "upload-queue", directoryHint: .isDirectory)
}

/// Unpaired (no config/token) → 401-shaped error so the queue halts instead of retrying forever.
private func pairedOr401() throws(ApiError) -> (server: URL, token: String) {
    do {
        let (server, token, _) = try pairedServer()
        return (server, token)
    } catch {
        throw ApiError(status: 401, "\(error)")
    }
}

/// Token + server read per send → `pa pair` in another process takes effect without restarting `pa run`.
func makeUploadQueue() -> UploadQueue {
    UploadQueue(store: UploadQueueStore(dir: uploadQueueDir())) { u in
        let (server, token) = try pairedOr401()
        return try await send(try uploadRequest(server: server, token: token, upload: u), as: TranscriptUploadResponse.self)
    }
}

func daemonLog(_ s: String) {
    print("\(ISO8601DateFormatter().string(from: Date())) \(s)")
    // Not a TTY under launchd → block-buffered; flush so the log file is live.
    fflush(nil)
}

/// Daemon. SIGTERM mid-send is safe: the file stays queued and is re-sent (server upserts by id).
func run() async throws {
    let queue = makeUploadQueue()
    let worker = UploadWorker(queue: queue, probe: {
        let (server, token) = try pairedOr401()
        return try await send(deviceMeRequest(server: server, token: token), as: DeviceMeResponse.self)
    }, log: daemonLog)
    daemonLog("pa run: upload queue \(uploadQueueDir().path), \(try await queue.pending().count) pending")
    await worker.run()
}

/// Queue first (survives offline), then one attempt now.
func enqueueAndTryUpload(_ u: TranscriptUpload) async throws {
    let queue = makeUploadQueue()
    try await queue.enqueue(u)
    let events = try await queue.drain()
    for e in events { print(e) }
    if try await queue.pending().contains(where: { $0.upload.id == u.id.lowercased() }) {
        print("still queued; `pa run` retries it (see `pa queue`)")
    }
}

func listQueue() throws {
    let store = UploadQueueStore(dir: uploadQueueDir())
    // load() moves unreadable files into failed/ → reported once, via parked().
    let pending = try store.load().items
    let (parked, unreadable) = try store.parked()
    for q in pending { print(formatQueuedLine(q, parked: false)) }
    for q in parked { print(formatQueuedLine(q, parked: true)) }
    for name in unreadable { print("unreadable failed/\(name)") }
    if pending.isEmpty && parked.isEmpty && unreadable.isEmpty { print("queue empty (\(store.dir.path))") }
}
