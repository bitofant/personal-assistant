import Foundation
import Testing
@testable import PACore

// shared/fixtures/ = contract with the server (api.e2e.test.ts checks real responses against the same files).
func fixture(_ name: String) throws -> Data {
    let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try Data(contentsOf: repo.appendingPathComponent("shared/fixtures/\(name)"))
}

@Suite struct WireTests {
    @Test func decodesServerFixtures() throws {
        let d = JSONDecoder()
        #expect(try d.decode(HealthResponse.self, from: fixture("health.json")).ok)
        let pair = try d.decode(PairResponse.self, from: fixture("pair-response.json"))
        #expect(pair.status == .pending && pair.pairingCode == "042917")
        let me = try d.decode(DeviceMeResponse.self, from: fixture("device-me.json"))
        #expect(me.status == .active && me.account == "alice")
        #expect(try d.decode(TranscriptUploadResponse.self, from: fixture("transcript-upload-response.json")).created)
        #expect(try d.decode(ErrorResponse.self, from: fixture("error.json")).message == "Unknown account.")
    }

    @Test func uploadFixtureRoundTrips() throws {
        let u = try JSONDecoder().decode(TranscriptUpload.self, from: fixture("transcript-upload.json"))
        #expect(u.segments.count == 3 && u.segments[2].speaker == nil)
        #expect(u.meeting?.attendees.count == 2 && u.meeting?.organizer?.name == "Alice Example")
        #expect(try JSONDecoder().decode(TranscriptUpload.self, from: JSONEncoder().encode(u)) == u)
    }

    @Test func adHocUploadDecodes() throws {
        let json = #"{"id":"x","startedAt":"a","endedAt":"b","meeting":null,"segments":[],"asrModel":"m","diarizationModel":null}"#
        let u = try JSONDecoder().decode(TranscriptUpload.self, from: Data(json.utf8))
        #expect(u.meeting == nil && u.diarizationModel == nil)
    }

    @Test func pendingPairWithNulls() throws {
        let p = try JSONDecoder().decode(PairResponse.self, from: Data(#"{"deviceId":"d","status":"active","pairingCode":null,"expiresAt":null}"#.utf8))
        #expect(p.pairingCode == nil && p.status == .active)
    }
}

@Suite struct ApiClientTests {
    let server = URL(string: "https://pa.example.com")!

    @Test func serverURL() throws {
        #expect(try parseServerURL(" https://pa.example.com/ ").absoluteString == "https://pa.example.com")
        #expect(try parseServerURL("https://x.com/pa//").absoluteString == "https://x.com/pa")
        #expect(try parseServerURL("http://localhost:4200").absoluteString == "http://localhost:4200")
        #expect(try parseServerURL("http://127.0.0.1:4200").absoluteString == "http://127.0.0.1:4200")
        #expect(throws: UsageError.self) { try parseServerURL("http://pa.example.com") }
        #expect(throws: UsageError.self) { try parseServerURL("pa.example.com") }
        #expect(throws: UsageError.self) { try parseServerURL("ftp://pa.example.com") }
        #expect(throws: UsageError.self) { try parseServerURL("https://x.com/?a=1") }
    }

    @Test func tokenMeetsServerMinimum() {
        let a = newDeviceToken(), b = newDeviceToken()
        #expect(a.count >= 32 && a != b)
        #expect(a.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
    }

    @Test func pairRequestShape() throws {
        let r = try pairRequest(server: server, token: "tok", account: "alice", deviceName: "Mac")
        #expect(r.method == "POST" && r.url.absoluteString == "https://pa.example.com/api/devices/pair")
        #expect(r.headers["Authorization"] == "Bearer tok" && r.headers["Content-Type"] == "application/json")
        #expect(try JSONDecoder().decode(PairRequest.self, from: r.body!) == PairRequest(account: "alice", deviceName: "Mac"))
    }

    @Test func getHasNoBodyOrContentType() {
        let r = deviceMeRequest(server: URL(string: "https://x.com/pa")!, token: "tok")
        #expect(r.method == "GET" && r.url.absoluteString == "https://x.com/pa/api/device/me")
        #expect(r.body == nil && r.headers["Content-Type"] == nil)
    }

    @Test func uploadRequestShape() throws {
        let u = try JSONDecoder().decode(TranscriptUpload.self, from: fixture("transcript-upload.json"))
        let r = try uploadRequest(server: server, token: "tok", upload: u)
        #expect(r.url.path == "/api/device/transcripts" && r.headers["Content-Type"] == "application/json")
        #expect(try JSONDecoder().decode(TranscriptUpload.self, from: r.body!) == u)
    }

    @Test func decodeErrors() throws {
        let ok = try decodeResponse(DeviceMeResponse.self, status: 200, body: fixture("device-me.json"))
        #expect(ok.deviceName == "MacBook Pro")
        #expect(throws: ApiError(status: 404, "Unknown account.")) {
            try decodeResponse(DeviceMeResponse.self, status: 404, body: fixture("error.json"))
        }
        #expect(throws: ApiError(status: 502, "<html>Bad Gateway</html>")) {
            try decodeResponse(DeviceMeResponse.self, status: 502, body: Data(" <html>Bad Gateway</html>\n".utf8))
        }
        #expect(throws: ApiError(status: 401, "no response body")) {
            try decodeResponse(DeviceMeResponse.self, status: 401, body: Data())
        }
        #expect(throws: ApiError.self) { try decodeResponse(DeviceMeResponse.self, status: 200, body: Data("{}".utf8)) }
    }

    @Test func pairingPrompt() throws {
        let p = try JSONDecoder().decode(PairResponse.self, from: fixture("pair-response.json"))
        let s = formatPairingPrompt(p, account: "alice", server: server)
        #expect(s.contains("Pairing code: 042 917") && s.contains("https://pa.example.com/#/devices"))
        var active = p
        active.status = .active
        active.pairingCode = nil
        #expect(formatPairingPrompt(active, account: "alice", server: server) == "Already paired and active.")
    }
}
