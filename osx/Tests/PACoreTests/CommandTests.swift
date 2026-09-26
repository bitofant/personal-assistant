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
        want.outDir = "/tmp/x"
        let got = try parseCommand(["test-capture", "--seconds", "10", "--out", "/tmp/x"])
        #expect(got == .testCapture(want))
    }

    @Test func streamSwitches() throws {
        var want = TestCaptureOptions()
        want.mic = false
        #expect(try parseCommand(["test-capture", "--no-mic"]) == .testCapture(want))
        want = TestCaptureOptions()
        want.system = false
        #expect(try parseCommand(["test-capture", "--no-system"]) == .testCapture(want))
    }

    @Test func micCommands() throws {
        #expect(try parseCommand(["mics"]) == .mics)
        #expect(try parseCommand(["set-mic", "BuiltInMicrophoneDevice"]) == .setMic("BuiltInMicrophoneDevice"))
        #expect(try parseCommand(["set-mic", "--default"]) == .setMic(nil))
        #expect(throws: UsageError.self) { try parseCommand(["set-mic"]) }
        #expect(throws: UsageError.self) { try parseCommand(["set-mic", "a", "b"]) }
        #expect(throws: UsageError.self) { try parseCommand(["mics", "x"]) }
    }

    @Test func rejectsBadInput() {
        #expect(throws: UsageError.self) { try parseCommand(["test-capture", "--no-mic", "--no-system"]) }
        #expect(throws: UsageError.self) { try parseCommand(["test-capture", "--seconds", "0"]) }
        #expect(throws: UsageError.self) { try parseCommand(["test-capture", "--seconds"]) }
        #expect(throws: UsageError.self) { try parseCommand(["test-capture", "--app", "x"]) }
        #expect(throws: UsageError.self) { try parseCommand(["test-capture", "--bogus"]) }
        #expect(throws: UsageError.self) { try parseCommand(["nope"]) }
    }
}
