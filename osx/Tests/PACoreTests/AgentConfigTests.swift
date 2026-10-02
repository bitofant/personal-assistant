import Foundation
import Testing
@testable import PACore

@Suite struct AgentConfigTests {
    @Test func roundTrip() throws {
        let c = AgentConfig(micDeviceUID: "BuiltInMicrophoneDevice", serverURL: "https://pa.example.com", account: "alice", deviceId: "d1")
        #expect(try parseAgentConfig(encodeAgentConfig(c)) == c)
    }

    @Test func blankUIDIsDefault() throws {
        #expect(try parseAgentConfig(Data(#"{"micDeviceUID":"  "}"#.utf8)).micDeviceUID == nil)
        #expect(try parseAgentConfig(Data("{}".utf8)).micDeviceUID == nil)
    }

    @Test func recordingSettings() throws {
        let c = try parseAgentConfig(Data(#"{"ignoreMicApps":[" com.apple.siri ",""],"keepAudioDays":7}"#.utf8))
        #expect(c.ignoreMicApps == ["com.apple.siri"])
        #expect(c.keepAudioDays == 7)
        #expect(c.liveEnabled) // default on
        #expect(try !parseAgentConfig(Data(#"{"liveTranscription":false}"#.utf8)).liveEnabled)
        let d = try parseAgentConfig(Data(#"{"ignoreMicApps":[" "],"keepAudioDays":0}"#.utf8))
        #expect(d.ignoreMicApps == nil)
        #expect(d.keepAudioDays == nil)
        #expect(try parseAgentConfig(encodeAgentConfig(c)) == c)
    }

    @Test func ignoresUnknownKeys() throws {
        #expect(try parseAgentConfig(Data(#"{"micDeviceUID":"x","future":1}"#.utf8)).micDeviceUID == "x")
    }

    @Test func rejectsGarbage() {
        #expect(throws: (any Error).self) { try parseAgentConfig(Data("nope".utf8)) }
    }

    @Test func micLine() {
        let d = MicDevice(objectID: 1, uid: "uid-1", name: "Mic\twith tab")
        #expect(formatMicLine(d, isDefault: true, isSelected: true) == "uid-1\tMic with tab\tdefault,selected")
        #expect(formatMicLine(d, isDefault: false, isSelected: false) == "uid-1\tMic with tab\t")
    }
}
