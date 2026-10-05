import Foundation

// Menu bar state, derived only from files `pa run` already writes (run.lock, sidecars, note/pause requests, upload
// queue) → no daemon→menu IPC to keep in sync.

public enum MenuState: Equatable, Sendable {
    case notRunning
    case idle
    case paused
    /// meeting nil = ad-hoc call.
    case meeting(MeetingMeta?, since: Date)
    case note(since: Date)
}

public struct MenuStatus: Equatable, Sendable {
    public var state: MenuState
    public var paused: Bool
    /// note-request.json present (menu shows "Stop note" even before the daemon reacts).
    public var noteRequested: Bool
    public var pendingUploads: Int
    public var failedUploads: Int
    /// Open recording's id (= upload id = web transcript id); nil = not recording.
    public var recordingId: String?
    public var headline: String
    /// SF Symbol for the status item.
    public var symbolName: String
}

/// `recordings` = all sidecars; open ones (no `endedAt`) only count while the daemon runs (else crash leftovers).
public func menuStatus(
    daemonRunning: Bool, recordings: [RecordingMeta], note: NoteRequest?, pause: PauseRequest?,
    pendingUploads: Int, failedUploads: Int, now: Date
) -> MenuStatus {
    let state: MenuState
    var recordingId: String?
    if !daemonRunning {
        state = .notRunning
    } else if let r = recordings.filter({ $0.endedAt == nil }).max(by: { ($0.startedAt, $0.id) < ($1.startedAt, $1.id) }) {
        state = r.noteId != nil ? .note(since: r.startedAt) : .meeting(r.meeting, since: r.startedAt)
        recordingId = r.id
    } else {
        state = pause != nil ? .paused : .idle
    }
    var headline: String
    let symbol: String
    switch state {
    case .notRunning:
        headline = "pa run isn't running"
        symbol = "exclamationmark.triangle"
    case .idle:
        headline = "Watching for meetings"
        symbol = "waveform"
    case .paused:
        headline = "Recording paused"
        symbol = "pause.circle"
    case let .meeting(m, since):
        let title = m.map { $0.title ?? "(untitled)" } ?? "ad-hoc call"
        headline = "Recording: \(title) · \(minutes(now.timeIntervalSince(since)))"
        symbol = "record.circle.fill"
    case let .note(since):
        headline = "Recording note · \(minutes(now.timeIntervalSince(since)))"
        symbol = "mic.fill"
    }
    if pause != nil && state != .paused { headline += " (meetings paused)" }
    return MenuStatus(
        state: state, paused: pause != nil, noteRequested: note != nil, pendingUploads: pendingUploads,
        failedUploads: failedUploads, recordingId: recordingId, headline: headline, symbolName: symbol)
}

/// Thin file wrapper (shared by `pa status` and the menu app). Unreadable files count as absent.
public func readMenuStatus(_ paths: AgentPaths, now: Date = Date()) -> MenuStatus {
    let uploads = UploadQueueStore(dir: paths.uploadQueue).counts()
    return menuStatus(
        daemonRunning: daemonIsRunning(lock: paths.runLock),
        recordings: (try? RecordingStore(dir: paths.recordings).all().items) ?? [],
        note: NoteRequestStore(url: paths.noteRequest).load(),
        pause: PauseStore(url: paths.pause).load(),
        pendingUploads: uploads.pending,
        failedUploads: uploads.parked,
        now: now)
}

/// Web page of the running recording (live preview, then the final transcript; same id). nil = not recording, live
/// preview off (page would 404 until transcribed), or no valid server URL.
public func liveTranscriptURL(_ status: MenuStatus, config: AgentConfig?) -> URL? {
    guard let id = status.recordingId, let config, config.liveEnabled, let s = config.serverURL,
          let server = try? parseServerURL(s), let frag = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(["-"]))
    else { return nil }
    // Hash route = `web/routes.ts` `transcriptHash`.
    return URL(string: server.absoluteString + "/#/t/" + frag)
}

private func minutes(_ s: TimeInterval) -> String { "\(max(0, Int(s / 60))) min" }

/// Menu started note `id`: the daemon removed the request without ever writing its sidecar → refused (meeting/call).
public func noteWasRefused(id: String, note: NoteRequest?, recordings: [RecordingMeta]) -> Bool {
    note?.id != id && !recordings.contains { $0.noteId == id }
}
