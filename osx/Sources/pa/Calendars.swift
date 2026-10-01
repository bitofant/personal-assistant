import EventKit
import Foundation
import PACore

// EventKit → PACore CalendarEvent. Filtering (work calendars, declined, all-day) + wire mapping are in PACore.
// Non-Sendable on purpose: owned by one task (`pa run` recording loop / `pa calendars`).

final class CalendarReader {
    private let store = EKEventStore()
    /// nil = not asked yet.
    private var granted: Bool?

    /// Asks once (TCC prompt on first run; needs PA.app via `open`/launchd for the grant to stick).
    func requestAccess() async -> Bool {
        if let granted { return granted }
        let ok = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            store.requestFullAccessToEvents { ok, _ in c.resume(returning: ok) }
        }
        granted = ok
        return ok
    }

    /// `Source/Name` of every event calendar, sorted.
    func calendars() -> [(name: String, source: String?)] {
        store.calendars(for: .event)
            .map { (name: $0.title, source: $0.source?.title) }
            .sorted { ($0.source ?? "", $0.name) < ($1.source ?? "", $1.name) }
    }

    /// Eligible events overlapping [now - 12h, now + 1h]: covers the detector's pre-roll and a long-running meeting.
    func events(now: Date, workCalendars: [String]) -> [CalendarEvent] {
        let cals = store.calendars(for: .event).filter {
            isWorkCalendar(name: $0.title, source: $0.source?.title, workCalendars: workCalendars)
        }
        guard !cals.isEmpty else { return [] }
        let pred = store.predicateForEvents(
            withStart: now.addingTimeInterval(-12 * 3600), end: now.addingTimeInterval(3600), calendars: cals)
        return eligibleEvents(store.events(matching: pred).compactMap(calendarEvent), workCalendars: workCalendars)
    }
}

private func calendarEvent(_ e: EKEvent) -> CalendarEvent? {
    guard let cal = e.calendar, let start = e.startDate, let end = e.endDate else { return nil }
    let (me, attendees) = mapParticipants((e.attendees ?? []).map(participantInfo))
    let organizer = e.organizer.map(participantInfo)
    return CalendarEvent(
        calendarName: cal.title, calendarSource: cal.source?.title,
        // External id is shared across devices/occurrences; local id only as a fallback (unsynced local events).
        externalId: e.calendarItemExternalIdentifier ?? e.calendarItemIdentifier,
        // Detached = one moved/edited occurrence of a series: still part of it.
        isRecurring: e.hasRecurrenceRules || e.isDetached,
        occurrenceDate: e.occurrenceDate, title: e.title, start: start, end: end, isAllDay: e.isAllDay,
        isCancelled: e.status == .canceled,
        // Organizer has no attendee response of their own.
        selfStatus: organizer?.isCurrentUser == true ? nil : me,
        organizer: organizer.flatMap(participantPerson), attendees: attendees)
}

private func participantInfo(_ p: EKParticipant) -> ParticipantInfo {
    let status: ParticipationStatus = switch p.participantStatus {
    case .accepted: .accepted
    case .declined: .declined
    case .tentative: .tentative
    case .pending: .pending
    default: .unknown
    }
    let kind: ParticipantInfo.Kind = switch p.participantType {
    case .person: .person
    case .room: .room
    case .resource: .resource
    case .group: .group
    default: .unknown
    }
    return ParticipantInfo(name: p.name, url: p.url.absoluteString, status: status, kind: kind, isCurrentUser: p.isCurrentUser)
}

/// `pa calendars`: lists names to put in `workCalendars`. Needs Calendar access → run via `osx/pa` (PA.app).
func listCalendars() async throws {
    let reader = CalendarReader()
    guard await reader.requestAccess() else {
        throw SpikeError(description: "calendar access denied (System Settings → Privacy & Security → Calendars → PA)")
    }
    let work = try loadAgentConfig().workCalendars ?? []
    for c in reader.calendars() { print(formatCalendarLine(name: c.name, source: c.source, workCalendars: work)) }
    if work.isEmpty {
        print("# no workCalendars in \(agentConfigURL().path): every recording is ad-hoc. Add e.g. \"workCalendars\": [\"Exchange/Calendar\"]")
    }
}
