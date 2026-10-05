import Foundation
import PACore

// `pa note`: bare binary (no TCC: it only writes a request file; `pa run` does the recording).

func note(_ action: NoteAction) async throws {
    let store = noteRequestStore()
    let recordings = RecordingStore(dir: recordingsDir())
    switch action {
    case .toggle:
        try await note(store.load() == nil ? .start : .stop)
    case .start:
        guard daemonIsRecording() else {
            eprint("pa note: `pa run` isn't recording (LaunchAgent not loaded? see osx/install.sh) → no note")
            exit(1)
        }
        let r = try store.start(now: Date())
        switch try await waitForNoteStart(id: r.id, store: store, recordings: recordings) {
        case .recording(let m):
            print("pa note: recording note \(m.id) (mic only); `pa note stop` to end")
        case .refused:
            eprint("pa note: refused: a meeting/call is being recorded")
            exit(1)
        case .timedOut:
            store.clear(id: r.id)
            eprint("pa note: `pa run` didn't start the note within 15 s → withdrawn (see ~/Library/Logs/\(bundleID).log)")
            exit(1)
        }
    case .stop:
        guard let r = try store.stop() else {
            print("pa note: no note recording")
            return
        }
        switch try await waitForNoteStop(id: r.id, recordings: recordings) {
        case .some(let m?):
            let secs = Int((m.endedAt ?? m.startedAt).timeIntervalSince(m.startedAt))
            print("pa note: note \(m.id) stopped, \(secs)s → transcribing + uploading")
        case .some(nil):
            print("pa note: stopped")
        case nil:
            eprint("pa note: request removed, but `pa run` hasn't closed the recording within 15 s (see the log)")
            exit(1)
        }
    case .status:
        guard let r = store.load() else {
            print("pa note: no note recording")
            return
        }
        if let m = try recordings.all().items.first(where: { $0.noteId == r.id && $0.endedAt == nil }) {
            print("pa note: recording note \(m.id) for \(Int(Date().timeIntervalSince(m.startedAt)))s")
        } else {
            print("pa note: requested at \(isoTimestamp(r.requestedAt)), not recording (is `pa run` running?)")
        }
    }
}

/// `pa run` holds run.lock while recording: taking it here means nobody is.
private func daemonIsRecording() -> Bool {
    let fd = Darwin.open(runLockURL().path, O_RDWR | O_CREAT, 0o644)
    guard fd >= 0 else { return true } // can't tell → let the 15 s wait decide
    defer { close(fd) }
    if flock(fd, LOCK_EX | LOCK_NB) == 0 {
        flock(fd, LOCK_UN)
        return false
    }
    return true
}
