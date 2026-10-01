import Foundation
import Testing
@testable import PACore

@Suite struct SignalsTests {
    @Test func micUsersExcludeSelfIgnoredAndIdle() {
        let clients = [
            AudioClient(pid: 10, bundleID: "us.zoom.xos", runningInput: true),
            AudioClient(pid: 11, bundleID: "com.bitofant.pa", runningInput: true),
            AudioClient(pid: 12, bundleID: "com.apple.Siri", runningInput: true),
            AudioClient(pid: 13, bundleID: "com.spotify.client", runningInput: false),
            AudioClient(pid: 14, bundleID: nil, runningInput: true),
        ]
        let users = micUsers(clients, ownPID: 11, ignore: ["com.apple.siri"])
        #expect(users.map(\.pid) == [10, 14])
        // Own pid excluded even without an ignore list.
        #expect(micUsers([clients[1]], ownPID: 11, ignore: []).isEmpty)
    }

    @Test func meetingAppByOutermostBundle() {
        #expect(meetingAppName(executablePath: "/Applications/zoom.us.app/Contents/MacOS/zoom.us") == "zoom.us.app")
        #expect(meetingAppName(executablePath:
            "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper")
            == "Google Chrome.app")
        #expect(meetingAppName(executablePath: "/System/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari") == "Safari.app")
        #expect(meetingAppName(executablePath: "/applications/ZOOM.US.APP/Contents/MacOS/zoom.us") == "zoom.us.app")
        // Not a meeting app / not a bundle.
        #expect(meetingAppName(executablePath: "/Applications/Notes.app/Contents/MacOS/Notes") == nil)
        #expect(meetingAppName(executablePath: "/usr/sbin/coreaudiod") == nil)
        // Outermost wins: a "Slack.app" helper inside another bundle isn't Slack.
        #expect(meetingAppName(executablePath: "/Applications/Foo.app/Contents/Slack.app/Contents/MacOS/x") == nil)
        #expect(meetingAppName(executablePath: "/x/Foo.app/y", apps: ["foo.app"]) == "foo.app")
    }

    @Test func participants() {
        let ps = [
            ParticipantInfo(name: "Me", url: "mailto:me@corp.com", status: .tentative, isCurrentUser: true),
            ParticipantInfo(name: " Alice ", url: "mailto:alice@corp.com", status: .accepted),
            ParticipantInfo(name: "Room 4.12", url: "mailto:room412@corp.com", kind: .room),
            ParticipantInfo(name: "Beamer", url: "mailto:beamer@corp.com", kind: .resource),
            ParticipantInfo(name: "Bob", url: "/o=ExchangeLabs/ou=x/cn=bob", status: .declined),
            ParticipantInfo(name: " ", url: "urn:x"),
        ]
        let (me, people) = mapParticipants(ps)
        #expect(me == .tentative)
        #expect(people == [
            Person(name: "Me", email: "me@corp.com"), Person(name: "Alice", email: "alice@corp.com"), Person(name: "Bob", email: nil),
        ])
        #expect(mapParticipants([]).selfStatus == nil)
    }

    @Test func calendarLine() {
        #expect(formatCalendarLine(name: "Calendar", source: "Exchange", workCalendars: ["exchange/calendar"]) == "Exchange/Calendar\twork")
        #expect(formatCalendarLine(name: "Calendar", source: "iCloud", workCalendars: ["exchange/calendar"]) == "iCloud/Calendar\t-")
        #expect(formatCalendarLine(name: "Te\tam", source: nil, workCalendars: []) == "Te am\t-")
    }
}
