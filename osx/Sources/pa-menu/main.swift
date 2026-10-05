import AppKit
import PACore

// PAMenu.app: status item for `pa run`. All state comes from the daemon's files (`readMenuStatus`); actions write the
// same request files as `pa note` / `pa pause`. Separate process → a menu crash never touches a recording.

@MainActor
final class MenuController: NSObject, NSMenuDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let paths = AgentPaths.default
    private var status: MenuStatus
    /// Note started from this menu, awaiting the daemon (sidecar = started; request gone without one = refused).
    private var pendingNote: (id: String, at: Date)?
    /// One-off feedback line (refused note, write error), shown until `until`.
    private var message: (text: String, until: Date)?
    private var timer: Timer?

    override init() {
        status = readMenuStatus(paths)
        super.init()
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        item.menu = menu
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    private func refresh() {
        let now = Date()
        status = readMenuStatus(paths, now: now)
        if let p = pendingNote {
            let recs = (try? RecordingStore(dir: paths.recordings).all().items) ?? []
            let note = NoteRequestStore(url: paths.noteRequest)
            if recs.contains(where: { $0.noteId == p.id }) {
                pendingNote = nil
            } else if noteWasRefused(id: p.id, note: note.load(), recordings: recs) {
                pendingNote = nil
                show("Note refused: a meeting/call is being recorded")
            } else if now.timeIntervalSince(p.at) > 15 {
                // Same timeout + withdrawal as `pa note start`: a stuck daemon mustn't start it much later.
                note.clear(id: p.id)
                pendingNote = nil
                show("Note not started: pa run didn't react (see log)")
            }
        }
        if let m = message, m.until < now { message = nil }
        let image = NSImage(systemSymbolName: status.symbolName, accessibilityDescription: status.headline)
        image?.isTemplate = true
        item.button?.image = image
        item.button?.toolTip = status.headline
    }

    private func show(_ text: String) { message = (text, Date().addingTimeInterval(15)) }

    func menuNeedsUpdate(_ menu: NSMenu) {
        refresh()
        menu.removeAllItems()
        menu.addItem(info(status.headline))
        if let m = message { menu.addItem(info(m.text)) }
        if status.pendingUploads > 0 || status.failedUploads > 0 {
            menu.addItem(info("Uploads: \(status.pendingUploads) pending, \(status.failedUploads) failed"))
        }
        menu.addItem(.separator())
        let running = status.state != .notRunning
        if status.noteRequested {
            menu.addItem(action("Stop note", #selector(stopNote)))
        } else {
            menu.addItem(action("Start note", #selector(startNote), enabled: running))
        }
        menu.addItem(status.paused
            ? action("Resume recording", #selector(resumeRecording))
            : action("Pause recording", #selector(pauseRecording)))
        menu.addItem(.separator())
        if webURL() != nil { menu.addItem(action("Open web UI", #selector(openWeb))) }
        menu.addItem(action("Open log", #selector(openLog)))
        menu.addItem(action("Quit PA menu", #selector(quit)))
    }

    private func info(_ title: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }

    private func action(_ title: String, _ sel: Selector, enabled: Bool = true) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        i.target = self
        i.isEnabled = enabled
        return i
    }

    private func attempt(_ what: String, _ f: () throws -> Void) {
        do { try f() } catch { show("⚠️ \(what) failed: \(error)") }
        refresh()
    }

    @objc private func startNote() {
        attempt("start note") {
            let r = try NoteRequestStore(url: paths.noteRequest).start(now: Date())
            pendingNote = (r.id, Date())
        }
    }

    @objc private func stopNote() {
        attempt("stop note") {
            try NoteRequestStore(url: paths.noteRequest).stop()
            pendingNote = nil
        }
    }

    @objc private func pauseRecording() { attempt("pause") { try PauseStore(url: paths.pause).pause(now: Date()) } }

    @objc private func resumeRecording() { attempt("resume") { try PauseStore(url: paths.pause).resume() } }

    private func webURL() -> URL? {
        guard let data = try? Data(contentsOf: paths.config), let s = (try? parseAgentConfig(data))?.serverURL else { return nil }
        return URL(string: s)
    }

    @objc private func openWeb() {
        if let u = webURL() { NSWorkspace.shared.open(u) }
    }

    @objc private func openLog() {
        let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/\(bundleID).log")
        NSWorkspace.shared.open(log)
    }

    /// Exit 0 → the LaunchAgent (`KeepAlive.SuccessfulExit=false`) doesn't restart it until next login.
    @objc private func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = MenuController()
app.run()
