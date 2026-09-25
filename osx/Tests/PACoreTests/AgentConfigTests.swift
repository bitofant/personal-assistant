import Foundation
import Testing
@testable import PACore

@Suite struct AgentConfigTests {
    @Test func roundTrip() throws {
        let c = AgentConfig(micDeviceUID: "BuiltInMicrophoneDevice")
        #expect(try parseAgentConfig(encodeAgentConfig(c)) == c)
    }

    @Test func blankUIDIsDefault() throws {
        #expect(try parseAgentConfig(Data(#"{"micDeviceUID":"  "}"#.utf8)).micDeviceUID == nil)
        #expect(try parseAgentConfig(Data("{}".utf8)).micDeviceUID == nil)
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
