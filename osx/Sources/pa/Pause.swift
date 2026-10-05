import Foundation
import PACore

// `pa pause` / `pa resume`: bare binary (no TCC); writes/deletes pause.json, `pa run` applies it within ~1 s.

func setPaused(_ paused: Bool) throws {
    let store = pauseStore()
    if paused {
        let p = try store.pause(now: Date())
        print("pa pause: meeting recording paused since \(isoTimestamp(p.pausedAt)) (spoken notes still work); `pa resume` to undo")
    } else {
        print(try store.resume() == nil ? "pa resume: wasn't paused" : "pa resume: meeting recording resumed")
    }
    // Flag still written: a daemon started later honors it.
    if !daemonIsRunning(lock: runLockURL()) { print("note: `pa run` isn't recording right now (LaunchAgent not loaded? see osx/install.sh)") }
}
