import Foundation

// Platform-neutral calendar model: `pa` maps EKEvent → CalendarEvent; filtering + wire mapping are pure (tested).

public enum ParticipationStatus: String, Codable, Equatable, Sendable {
    case accepted, declined, tentative, pending, unknown
}

public struct CalendarEvent: Equatable, Sendable {
    public var calendarName: String
    /// Account/source title (EKSource.title), e.g. "Exchange" or "you@corp.com": disambiguates same-named calendars.
    public var calendarSource: String?
    /// Stable across devices/occurrences (EKEvent.calendarItemExternalIdentifier).
    public var externalId: String
    public var isRecurring: Bool
    /// Original start of this occurrence (EKEvent.occurrenceDate): stays put if one occurrence is moved.
    public var occurrenceDate: Date
    public var title: String?
    public var start: Date
    public var end: Date
    public var isAllDay: Bool
    public var isCancelled: Bool
    /// The user's own response; nil = user is organizer / not an invite.
    public var selfStatus: ParticipationStatus?
    public var organizer: Person?
    public var attendees: [Person]

    public init(
        calendarName: String, calendarSource: String? = nil, externalId: String, isRecurring: Bool = false,
        occurrenceDate: Date? = nil, title: String?, start: Date, end: Date, isAllDay: Bool = false, isCancelled: Bool = false,
        selfStatus: ParticipationStatus? = nil, organizer: Person? = nil, attendees: [Person] = []
    ) {
        self.calendarName = calendarName
        self.calendarSource = calendarSource
        self.externalId = externalId
        self.isRecurring = isRecurring
        self.occurrenceDate = occurrenceDate ?? start
        self.title = title
        self.start = start
        self.end = end
        self.isAllDay = isAllDay
        self.isCancelled = isCancelled
        self.selfStatus = selfStatus
        self.organizer = organizer
        self.attendees = attendees
    }

    /// Per occurrence: recurring events share `externalId`, so the original occurrence start is appended.
    public var eventId: String { isRecurring ? "\(externalId)@\(isoTimestamp(occurrenceDate))" : externalId }
    public var seriesId: String? { isRecurring ? externalId : nil }
}

/// `workCalendars` entries match a calendar name or `Source/Name` (case-insensitive, trimmed).
/// Names alone are ambiguous: Exchange and iCloud both default to "Calendar".
public func isWorkCalendar(name: String, source: String?, workCalendars: [String]) -> Bool {
    let norm = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    let n = norm(name)
    let full = source.map { "\(norm($0))/\(n)" }
    return workCalendars.contains { w in norm(w) == n || norm(w) == full }
}

/// Events that can drive/label a recording: work calendar, timed, not cancelled, not declined.
public func eligibleEvents(_ events: [CalendarEvent], workCalendars: [String]) -> [CalendarEvent] {
    events.filter {
        !$0.isAllDay && !$0.isCancelled && $0.selfStatus != .declined && $0.end > $0.start
            && isWorkCalendar(name: $0.calendarName, source: $0.calendarSource, workCalendars: workCalendars)
    }
}

/// EKParticipant.url → email: `mailto:` only (Exchange may give X.500 paths / other schemes → nil).
public func emailFromParticipantURL(_ s: String) -> String? {
    guard s.lowercased().hasPrefix("mailto:") else { return nil }
    let rest = String(s.dropFirst("mailto:".count))
    let addr = (rest.removingPercentEncoding ?? rest).split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
    let t = addr.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.contains("@") ? t : nil
}

public func meetingMeta(_ e: CalendarEvent) -> MeetingMeta {
    MeetingMeta(
        calendarName: e.calendarName, eventId: e.eventId, seriesId: e.seriesId, title: e.title,
        start: isoTimestamp(e.start), end: isoTimestamp(e.end), organizer: e.organizer, attendees: e.attendees)
}
