import Foundation

// When `pa run` records: pure state machine, called every few seconds with fresh signals. `pa` does the I/O
// (EventKit, Core Audio) and executes the returned actions.

public struct DetectionTiming: Equatable, Sendable {
    /// Event window = [start - preRoll, end + postRoll): people join early, meetings run over.
    public var preRoll: TimeInterval = 5 * 60
    public var postRoll: TimeInterval = 10 * 60
    /// No activity this long → stop (mic reconnects / device switches shouldn't split a recording).
    public var dropoutGrace: TimeInterval = 2 * 60
    /// Active for less than this → discard (dictation, Siri, a quick mic test).
    public var minActive: TimeInterval = 60

    public init() {}
}

public struct DetectorInput: Sendable {
    public var now: Date
    /// Already filtered by `eligibleEvents` (work calendars only).
    public var events: [CalendarEvent]
    /// ⚠️ In use by processes *other than pa*: counting our own capture would keep every recording alive forever.
    public var micInUse: Bool
    public var meetingAppRunning: Bool

    public init(now: Date, events: [CalendarEvent], micInUse: Bool, meetingAppRunning: Bool) {
        self.now = now
        self.events = events
        self.micInUse = micInUse
        self.meetingAppRunning = meetingAppRunning
    }
}

public struct RecordingSession: Equatable, Sendable {
    public var startedAt: Date
    /// nil = ad-hoc (no calendar event); latest snapshot (moved/extended events are refreshed each step).
    public var event: CalendarEvent?
    public var lastActiveAt: Date
    /// Once the mic was used, only the mic counts as activity (app merely running ≠ still in the call).
    public var micSeen: Bool
}

public struct DetectorState: Equatable, Sendable {
    public var session: RecordingSession?
    /// eventId → window end: events whose recording already stopped; the app alone won't restart them.
    public var finished: [String: Date] = [:]

    public init() {}
}

public enum StopReason: String, Equatable, Sendable {
    /// No activity for `dropoutGrace`.
    case inactive
    /// Current event is over and the next one has started (back-to-back).
    case nextMeeting
}

public enum RecorderAction: Equatable, Sendable {
    case start(event: CalendarEvent?)
    /// Running ad-hoc recording belongs to this event (call started early): relabel, don't split.
    case attach(event: CalendarEvent)
    /// Keep: transcribe + upload.
    case stop(RecordingSession, StopReason)
    /// Too short to be a meeting: delete the audio.
    case discard(RecordingSession)
}

public func detectStep(_ state: DetectorState, _ i: DetectorInput, timing t: DetectionTiming = DetectionTiming())
    -> (DetectorState, [RecorderAction])
{
    var s = state
    var actions: [RecorderAction] = []
    let now = i.now
    s.finished = s.finished.filter { $0.value > now }

    func inWindow(_ e: CalendarEvent) -> Bool { e.start.addingTimeInterval(-t.preRoll) <= now && now < e.end.addingTimeInterval(t.postRoll) }
    func inCore(_ e: CalendarEvent) -> Bool { e.start <= now && now < e.end }
    // Ties broken by eventId → deterministic.
    func latestStart(_ es: [CalendarEvent]) -> CalendarEvent? { es.max { ($0.start, $0.eventId) < ($1.start, $1.eventId) } }
    func earliestStart(_ es: [CalendarEvent]) -> CalendarEvent? { es.min { ($0.start, $0.eventId) < ($1.start, $1.eventId) } }
    /// Core (latest start = the one you moved on to) > upcoming (pre-roll). Never an ended event: a call right after
    /// a meeting is more likely a new ad-hoc call than a rejoin.
    func pick(_ es: [CalendarEvent]) -> CalendarEvent? {
        latestStart(es.filter(inCore)) ?? earliestStart(es.filter { inWindow($0) && now < $0.start })
    }
    func begin(_ e: CalendarEvent?) {
        s.session = RecordingSession(startedAt: now, event: e, lastActiveAt: now, micSeen: i.micInUse)
        actions.append(.start(event: e))
    }
    func finish(_ cur: RecordingSession, _ reason: StopReason) {
        actions.append(cur.lastActiveAt.timeIntervalSince(cur.startedAt) < t.minActive ? .discard(cur) : .stop(cur, reason))
        if let e = cur.event { s.finished[e.eventId] = e.end.addingTimeInterval(t.postRoll) }
        s.session = nil
    }
    // App-only starts need a real meeting (someone invited) not already recorded: "Focus time" + Zoom open all day ≠ a call.
    let appStartable = i.events.filter { !$0.attendees.isEmpty && s.finished[$0.eventId] == nil }

    guard var cur = s.session else {
        if i.micInUse {
            // Mic = user is in a call: rejoining a finished meeting still links to it.
            begin(pick(i.events))
        } else if i.meetingAppRunning, let e = pick(appStartable) {
            begin(e)
        }
        return (s, actions)
    }

    if let e = cur.event, let fresh = i.events.first(where: { $0.eventId == e.eventId }) { cur.event = fresh }
    let curInWindow = cur.event.map(inWindow) ?? false
    if i.micInUse || (!cur.micSeen && i.meetingAppRunning && curInWindow) { cur.lastActiveAt = now }
    if i.micInUse { cur.micSeen = true }

    // Back-to-back: current event over, another one started → split at its start.
    if let e = cur.event, now >= e.end,
       let next = latestStart(i.events.filter { inCore($0) && $0.eventId != e.eventId }) {
        finish(cur, .nextMeeting)
        if i.micInUse || i.meetingAppRunning { begin(next) }
        return (s, actions)
    }

    // Ad-hoc call that turns out to be (early for) a meeting: relabel, keep one recording.
    if cur.event == nil, let e = pick(i.events) {
        cur.event = e
        actions.append(.attach(event: e))
    }

    if now.timeIntervalSince(cur.lastActiveAt) >= t.dropoutGrace {
        finish(cur, .inactive)
    } else {
        s.session = cur
    }
    return (s, actions)
}
