import AVFoundation
import Foundation
import os
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

private let logger = Logger(subsystem: bundleID, category: "run")

/// stdout (→ ~/Library/Logs/com.bitofant.pa.log under launchd) + unified log (`log stream --predicate 'subsystem == "com.bitofant.pa"'`).
func daemonLog(_ s: String) {
    print("\(ISO8601DateFormatter().string(from: Date())) \(s)")
    // Not a TTY under launchd → block-buffered; flush so the log file is live.
    fflush(nil)
    logger.notice("\(s, privacy: .public)")
}

func recordingsDir() -> URL {
    agentConfigURL().deletingLastPathComponent().appending(path: "recordings", directoryHint: .isDirectory)
}

/// Detector cadence: mic/app/calendar polled every `stepSeconds`; calendar + config re-read every `calendarSeconds`.
private let stepSeconds = 5.0
private let calendarSeconds = 60.0

/// Daemon. SIGTERM/SIGINT: the current recording is closed + kept (transcribed at next start), then exit 0.
/// Mid-upload SIGTERM is safe too: the file stays queued and is re-sent (server upserts by id).
func run(record: Bool) async throws {
    let queue = makeUploadQueue()
    let worker = UploadWorker(queue: queue, probe: {
        let (server, token) = try pairedOr401()
        return try await send(deviceMeRequest(server: server, token: token), as: DeviceMeResponse.self)
    }, log: daemonLog)
    daemonLog("pa run: upload queue \(uploadQueueDir().path), \(try await queue.pending().count) pending")
    let uploads = Task { await worker.run() }

    let recording: Task<Void, Never>
    if record {
        recording = Task {
            // Before recoverInterrupted: it would mark the other process's live recording as ended.
            guard await acquireRunLock() else { return }
            let store = RecordingStore(dir: recordingsDir())
            do {
                for m in try store.recoverInterrupted() { daemonLog("recording \(m.id) was interrupted (pa stopped) → transcribing what was saved") }
            } catch {
                daemonLog("⚠️ recordings: \(error)")
            }
            let (kicks, kick) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
            let transcribing = Task { await transcribeLoop(store: store, queue: queue, worker: worker, kicks: kicks, kick: kick) }
            await recordLoop(store: store, onFinished: { kick.yield() })
            // Don't wait for a transcription in flight (launchd SIGKILLs after 20s): it restarts from its sidecar.
            transcribing.cancel()
        }
    } else {
        daemonLog("pa run: --no-record → upload worker only")
        recording = Task { while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) } }
    }

    // Default SIGTERM kills mid-write → WAV header never finalized. Handle it: stop the loop, close files, exit.
    let signals = [SIGTERM, SIGINT].map { sig in
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        src.setEventHandler { recording.cancel() }
        src.resume()
        return src
    }
    await recording.value
    uploads.cancel()
    daemonLog("pa run: stopped")
    _ = signals
    exit(0)
}

/// One recorder per user: LaunchAgent + a manual `osx/pa run` would record every meeting twice. Waits (polling, so
/// SIGTERM still works) until the other one exits. false = cancelled while waiting. Lock fd stays open until exit.
private func acquireRunLock() async -> Bool {
    let dir = agentConfigURL().deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let fd = Darwin.open(dir.appending(path: "run.lock").path, O_RDWR | O_CREAT, 0o644)
    guard fd >= 0 else {
        daemonLog("⚠️ can't open run.lock (errno \(errno)) → recording without the single-instance guard")
        return true
    }
    var told = false
    while flock(fd, LOCK_EX | LOCK_NB) != 0 {
        if !told { daemonLog("another `pa run` is recording (LaunchAgent?) → waiting for it to exit") }
        told = true
        do { try await Task.sleep(for: .seconds(5)) } catch { return false }
    }
    if told { daemonLog("other `pa run` exited → recording here") }
    return true
}

/// Polls mic / meeting apps / calendar → detector → recordings. Non-Sendable state (EventKit, controller,
/// recorders) lives only in this task.
private func recordLoop(store: RecordingStore, onFinished: @escaping @Sendable () -> Void) async {
    guard await AVAudioApplication.requestRecordPermission() else {
        daemonLog("⚠️ microphone permission denied → not recording (System Settings → Privacy & Security → Microphone → PA)")
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
        return
    }
    let controller = RecordingController(store: store, makeRecorder: { CaptureRecorder(log: daemonLog) }, log: daemonLog)
    controller.onFinished = onFinished
    let calendar = CalendarReader()
    var config = AgentConfig()
    var configError: String?
    var events: [CalendarEvent] = []
    var refreshedAt = Date.distantPast
    var lastSignals = ""
    var lastCalendarNote = ""
    let ownPID = getpid()

    while !Task.isCancelled {
        let now = Date()
        if now.timeIntervalSince(refreshedAt) >= calendarSeconds {
            refreshedAt = now
            // Re-read → workCalendars / ignoreMicApps edits apply live; a broken edit keeps the previous config.
            do {
                config = try loadAgentConfig()
                configError = nil
            } catch {
                if configError != "\(error)" { daemonLog("⚠️ config: \(error) → keeping previous settings") }
                configError = "\(error)"
            }
            let work = config.workCalendars ?? []
            let note: String
            if work.isEmpty {
                events = []
                note = "no workCalendars configured → recordings are ad-hoc"
            } else if await calendar.requestAccess() {
                events = calendar.events(now: now, workCalendars: work)
                note = "calendar: \(events.count) work events around now"
            } else {
                events = []
                note = "⚠️ calendar access denied → recordings are ad-hoc (grant: System Settings → Privacy & Security → Calendars → PA, then restart pa run)"
            }
            if note != lastCalendarNote { daemonLog(note) }
            lastCalendarNote = note
        }
        let users = micUsers(audioClients(), ownPID: ownPID, ignore: config.ignoreMicApps ?? [])
        let apps = runningMeetingApps()
        // Logged on change only: shows which process holds the mic (→ `ignoreMicApps` if it's not a call).
        let sig = "mic: \(describeClients(users)); meeting apps: \(apps.isEmpty ? "none" : apps.sorted().joined(separator: ", "))"
        if sig != lastSignals { daemonLog(sig) }
        lastSignals = sig
        controller.step(DetectorInput(now: now, events: events, micInUse: !users.isEmpty, meetingAppRunning: !apps.isEmpty))
        do { try await Task.sleep(for: .seconds(stepSeconds)) } catch { break }
    }
    controller.shutdown(now: Date())
}

/// Finished recordings → transcript → upload queue. Woken per finished recording, and every 10 min to retry failures.
private func transcribeLoop(
    store: RecordingStore, queue: UploadQueue, worker: UploadWorker,
    kicks: AsyncStream<Void>, kick: AsyncStream<Void>.Continuation
) async {
    let me = NSFullUserName().isEmpty ? "Me" : NSFullUserName()
    let processor = RecordingProcessor(
        store: store,
        transcribe: { mic, system in
            // Loaded per recording, released after: a few s per meeting vs ~1 GB held all day.
            let transcriber = try await FluidTranscriber.load()
            var diarizer: FluidDiarizer?
            var diarizeWarning: String?
            if system != nil {
                do { diarizer = try await FluidDiarizer.load() } catch { diarizeWarning = "diarizer unavailable, speakers left unknown: \(error)" }
            }
            var t = try await transcribeRecording(mic: mic, system: system, transcriber: transcriber, diarizer: diarizer, micSpeaker: me)
            if let diarizeWarning { t.warnings.append(diarizeWarning) }
            return t
        },
        enqueue: { u in
            try await queue.enqueue(u)
            await worker.kick()
        },
        keepAudioDays: { (try? loadAgentConfig())?.keepAudioDays },
        log: daemonLog)
    // Retry failed attempts (e.g. model download while offline) without waiting for the next meeting.
    let ticker = Task {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(600))
            kick.yield()
        }
    }
    defer { ticker.cancel() }
    await processor.processPending()
    for await _ in kicks {
        if Task.isCancelled { break }
        await processor.processPending()
    }
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
    let (recs, badRecs) = try RecordingStore(dir: recordingsDir()).all()
    for m in recs { print(formatRecordingLine(m)) }
    for name in badRecs { print("unreadable recordings/\(name)") }
    let store = UploadQueueStore(dir: uploadQueueDir())
    // load() moves unreadable files into failed/ → reported once, via parked().
    let pending = try store.load().items
    let (parked, unreadable) = try store.parked()
    for q in pending { print(formatQueuedLine(q, parked: false)) }
    for q in parked { print(formatQueuedLine(q, parked: true)) }
    for name in unreadable { print("unreadable failed/\(name)") }
    if pending.isEmpty && parked.isEmpty && unreadable.isEmpty { print("queue empty (\(store.dir.path))") }
}
