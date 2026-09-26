import Foundation
import Testing
@testable import PACore

/// 2026-09-28 10:00:00Z; times in tests = minutes from here.
private let t0 = Date(timeIntervalSince1970: 1_790_589_600)
private func at(_ min: Double) -> Date { t0.addingTimeInterval(min * 60) }

private let alice = Person(name: "Alice", email: "alice@corp.com")

private func event(_ id: String, _ from: Double, _ to: Double, attendees: [Person] = [alice]) -> CalendarEvent {
    CalendarEvent(calendarName: "Calendar", calendarSource: "Exchange", externalId: id, title: id, start: at(from), end: at(to), attendees: attendees)
}

/// Steps the detector; `step` returns that step's actions.
private struct Sim {
    var state = DetectorState()
    var events: [CalendarEvent]

    mutating func step(_ min: Double, mic: Bool = false, app: Bool = false) -> [RecorderAction] {
        let (s, a) = detectStep(state, DetectorInput(now: at(min), events: events, micInUse: mic, meetingAppRunning: app))
        state = s
        return a
    }

    /// Every 30s over [from, to): collects (minute, action).
    mutating func run(_ from: Double, _ to: Double, mic: Bool = false, app: Bool = false) -> [(Double, RecorderAction)] {
        var out: [(Double, RecorderAction)] = []
        var m = from
        while m < to {
            out += step(m, mic: mic, app: app).map { (m, $0) }
            m += 0.5
        }
        return out
    }
}

private func starts(_ a: [(Double, RecorderAction)]) -> [(Double, String?)] {
    a.compactMap { if case let .start(e) = $0.1 { ($0.0, e?.externalId) } else { nil } }
}

private func stops(_ a: [(Double, RecorderAction)]) -> [(Double, String?, StopReason?)] {
    a.compactMap {
        switch $0.1 {
        case let .stop(s, r): ($0.0, s.event?.externalId, r)
        case let .discard(s): ($0.0, s.event?.externalId, nil)
        default: nil
        }
    }
}

@Suite struct CalendarTests {
    @Test func workCalendarMatching() {
        #expect(isWorkCalendar(name: "Calendar", source: "Exchange", workCalendars: [" calendar "]))
        #expect(isWorkCalendar(name: "Calendar", source: "Exchange", workCalendars: ["exchange/Calendar"]))
        // Source-qualified entry doesn't match the same-named iCloud calendar.
        #expect(!isWorkCalendar(name: "Calendar", source: "iCloud", workCalendars: ["Exchange/Calendar"]))
        #expect(!isWorkCalendar(name: "Family", source: "iCloud", workCalendars: []))
    }

    @Test func eligibility() {
        var declined = event("declined", 0, 30)
        declined.selfStatus = .declined
        var tentative = event("tentative", 0, 30)
        tentative.selfStatus = .tentative
        var allDay = event("allday", 0, 30)
        allDay.isAllDay = true
        var cancelled = event("cancelled", 0, 30)
        cancelled.isCancelled = true
        var personal = event("personal", 0, 30)
        personal.calendarSource = "iCloud"
        let zero = event("zero", 0, 0)
        let got = eligibleEvents([event("ok", 0, 30), declined, tentative, allDay, cancelled, personal, zero], workCalendars: ["Exchange/Calendar"])
        #expect(got.map(\.externalId) == ["ok", "tentative"])
    }

    @Test func meetingMetaIds() {
        let single = meetingMeta(event("abc", 0, 30))
        #expect(single.eventId == "abc" && single.seriesId == nil)
        #expect(single.start == "2026-09-28T10:00:00Z" && single.end == "2026-09-28T10:30:00Z")
        #expect(single.calendarName == "Calendar" && single.title == "abc" && single.attendees == [alice])

        // Recurring: series id shared, occurrence id stable even if this occurrence is moved.
        var occ = event("series-1", 60, 90)
        occ.isRecurring = true
        occ.occurrenceDate = at(0)
        let m = meetingMeta(occ)
        #expect(m.seriesId == "series-1" && m.eventId == "series-1@2026-09-28T10:00:00Z")
        #expect(m.start == "2026-09-28T11:00:00Z")
    }

    @Test func participantEmails() {
        #expect(emailFromParticipantURL("mailto:Bob@Corp.com") == "Bob@Corp.com")
        #expect(emailFromParticipantURL("MAILTO:bob%2Bx@corp.com") == "bob+x@corp.com")
        #expect(emailFromParticipantURL("mailto:bob@corp.com?subject=x") == "bob@corp.com")
        #expect(emailFromParticipantURL("/o=ExchangeLabs/ou=Exchange/cn=Recipients/cn=bob") == nil)
        #expect(emailFromParticipantURL("mailto:") == nil)
    }

    @Test func configWorkCalendars() throws {
        let c = try parseAgentConfig(Data(#"{"workCalendars":[" Exchange/Calendar ","", "  "]}"#.utf8))
        #expect(c.workCalendars == ["Exchange/Calendar"])
        #expect(try parseAgentConfig(Data(#"{"workCalendars":[" "]}"#.utf8)).workCalendars == nil)
        #expect(try parseAgentConfig(Data("{}".utf8)).workCalendars == nil)
        let full = AgentConfig(workCalendars: ["Work"])
        #expect(try parseAgentConfig(encodeAgentConfig(full)) == full)
    }
}

@Suite struct MeetingDetectorTests {
    @Test func appStartsAtPreRollNotBefore() {
        var sim = Sim(events: [event("A", 0, 30)])
        #expect(sim.step(-5.5, app: true) == [])
        #expect(sim.step(-5, app: true) == [.start(event: event("A", 0, 30))])
    }

    @Test func nothingWithoutSignals() {
        var sim = Sim(events: [event("A", 0, 30)])
        #expect(sim.run(-10, 60).isEmpty)
    }

    @Test func appAloneNeedsInvitees() {
        // "Focus time" block + Zoom open all day: no recording…
        var sim = Sim(events: [event("focus", 0, 120, attendees: [])])
        #expect(sim.run(-10, 130, app: true).isEmpty)
        // …but a call during it is recorded and labelled with it.
        #expect(starts(sim.run(30, 31, mic: true)).map(\.1) == ["focus"])
    }

    @Test func adHocCallStopsAfterGrace() {
        var sim = Sim(events: [])
        let a = sim.run(0, 10, mic: true) + sim.run(10, 20)
        #expect(starts(a).map(\.0) == [0])
        #expect(starts(a).map(\.1) == [nil])
        // Mic off at 10:00 → stop exactly 2 min later, not earlier (last active 9.5).
        #expect(stops(a).map(\.0) == [11.5])
        #expect(stops(a).map(\.2) == [.inactive])
    }

    @Test func shortBlipDiscarded() {
        var sim = Sim(events: [])
        let a = sim.run(0, 0.5, mic: true) + sim.run(0.5, 5)
        #expect(a.map(\.1).count == 2)
        guard case .discard = a[1].1 else { Issue.record("\(a)"); return }
    }

    @Test func dropoutWithinGraceDoesNotSplit() {
        var sim = Sim(events: [event("A", 0, 60)])
        let a = sim.run(0, 20, mic: true) + sim.run(20, 21.5, app: true) + sim.run(21.5, 60, mic: true) + sim.run(60, 70)
        #expect(starts(a).count == 1)
        #expect(stops(a).map(\.0) == [61.5])
    }

    @Test func appAfterCallDoesNotKeepRecording() {
        // Left the call at 20 but Zoom stays open: stops after grace, not at window end.
        var sim = Sim(events: [event("A", 0, 60)])
        let a = sim.run(0, 20, mic: true, app: true) + sim.run(20, 80, app: true)
        #expect(stops(a).map(\.0) == [21.5])
        // …and the app alone doesn't restart the finished meeting.
        #expect(starts(a).count == 1)
    }

    @Test func rejoinByMicRelinks() {
        var sim = Sim(events: [event("A", 0, 60)])
        let a = sim.run(0, 20, mic: true) + sim.run(20, 30, app: true) + sim.run(30, 50, mic: true)
        #expect(starts(a).map(\.1) == ["A", "A"])
    }

    @Test func overrunKeepsRecording() {
        var sim = Sim(events: [event("A", 0, 30)])
        // Past end + post-roll (40) while still talking: keep going.
        let a = sim.run(0, 55, mic: true) + sim.run(55, 60)
        #expect(stops(a).map(\.0) == [56.5])
        #expect(stops(a).map(\.1) == ["A"])
    }

    @Test func backToBackSplitsAtNextStart() {
        let a0 = event("A", 0, 60), b0 = event("B", 60, 120)
        var sim = Sim(events: [a0, b0])
        let a = sim.run(0, 120, mic: true)
        // B's pre-roll (55–60) doesn't steal A's recording; split exactly at 60.
        #expect(starts(a).map(\.0) == [0, 60])
        #expect(starts(a).map(\.1) == ["A", "B"])
        #expect(stops(a).map(\.0) == [60])
        #expect(stops(a).map(\.2) == [.nextMeeting])
        // A's recording ends before B's starts (same step, stop first).
        let at60 = a.filter { $0.0 == 60 }.map(\.1)
        guard at60.count == 2, case .stop = at60[0], case .start = at60[1] else { Issue.record("\(at60)"); return }
    }

    @Test func earlyAdHocCallAttachesInsteadOfSplitting() {
        var sim = Sim(events: [event("A", 30, 60)])
        let a = sim.run(15, 60, mic: true) + sim.run(60, 65)
        #expect(starts(a).map(\.1) == [nil])
        let attaches = a.compactMap { if case let .attach(e) = $0.1 { ($0.0, e.externalId) } else { nil } }
        #expect(attaches.map(\.0) == [25] && attaches.map(\.1) == ["A"])
        #expect(stops(a).map(\.1) == ["A"])
    }

    @Test func callRightAfterMeetingIsAdHoc() {
        var sim = Sim(events: [event("A", 0, 30)])
        let a = sim.run(0, 25, mic: true) + sim.run(25, 33) + sim.run(33, 45, mic: true)
        #expect(starts(a).map(\.1) == ["A", nil])
    }

    @Test func movedEventRefreshedInSession() {
        var sim = Sim(events: [event("A", 0, 30)])
        _ = sim.run(0, 10, mic: true)
        sim.events = [event("A", 0, 45)]
        let a = sim.run(10, 45, mic: true) + sim.run(45, 50)
        guard case let .stop(s, _) = stops(a).isEmpty ? nil : a.last(where: { if case .stop = $0.1 { true } else { false } })?.1 else {
            Issue.record("\(a)"); return
        }
        #expect(s.event?.end == at(45))
    }

    @Test func overlappingMeetingsPreferLatestStarted() {
        var sim = Sim(events: [event("A", 0, 60), event("B", 30, 45)])
        #expect(starts(sim.run(35, 36, mic: true)).map(\.1) == ["B"])
        // While recording A, an overlapping meeting starting doesn't split A (A still running).
        var sim2 = Sim(events: [event("A", 0, 60), event("B", 30, 45)])
        let a = sim2.run(0, 60, mic: true)
        #expect(starts(a).map(\.1) == ["A"])
    }
}
