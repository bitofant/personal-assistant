import Testing
@testable import PACore

@Suite struct SelectTapTargetsTests {
    let procs = [
        AudioProcess(objectID: 1, pid: 100, bundleID: "us.zoom.xos"),
        AudioProcess(objectID: 2, pid: 101, bundleID: "com.google.Chrome.helper"),
        AudioProcess(objectID: 3, pid: 102, bundleID: "com.google.Chrome"),
        AudioProcess(objectID: 4, pid: 103, bundleID: "com.google.Chromebook"),
        AudioProcess(objectID: 5, pid: 104, bundleID: nil),
        AudioProcess(objectID: 6, pid: 105, bundleID: "com.bitofant.pa"),
    ]

    @Test func prefixMatchesAppAndHelpers() {
        let ids = selectTapTargets(procs, prefixes: ["com.google.chrome"]).map(\.objectID)
        #expect(ids == [2, 3])
    }

    @Test func prefixNeedsDotBoundary() {
        // "us.zoo" must not match "us.zoom.xos".
        #expect(selectTapTargets(procs, prefixes: ["us.zoo"]).isEmpty)
    }

    @Test func excludesOwnProcess() {
        #expect(selectTapTargets(procs, prefixes: ["com.bitofant.pa"], excludingPID: 105).isEmpty)
    }
}
