import Testing
@testable import PACore

@Suite struct ParseCommandTests {
    @Test func noArgsIsHelp() throws {
        #expect(try parseCommand([]) == .help)
    }

    @Test func testCaptureDefaults() throws {
        #expect(try parseCommand(["test-capture"]) == .testCapture(TestCaptureOptions()))
    }

    @Test func testCaptureFlags() throws {
        var want = TestCaptureOptions()
        want.seconds = 10
        want.apps = ["com.google.Chrome", "us.zoom"]
        want.outDir = "/tmp/x"
        let got = try parseCommand(["test-capture", "--seconds", "10", "--app", "com.google.Chrome", "--app", "us.zoom", "--out", "/tmp/x"])
        #expect(got == .testCapture(want))
    }

    @Test func globalReplacesApps() throws {
        guard case .testCapture(let o) = try parseCommand(["test-capture", "--global"]) else {
            Issue.record("wrong command"); return
        }
        #expect(o.global)
    }

    @Test func rejectsBadInput() {
        #expect(throws: UsageError.self) { try parseCommand(["test-capture", "--seconds", "0"]) }
        #expect(throws: UsageError.self) { try parseCommand(["test-capture", "--seconds"]) }
        #expect(throws: UsageError.self) { try parseCommand(["test-capture", "--global", "--app", "x"]) }
        #expect(throws: UsageError.self) { try parseCommand(["test-capture", "--bogus"]) }
        #expect(throws: UsageError.self) { try parseCommand(["nope"]) }
    }
}
