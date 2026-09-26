import Foundation
import PACore

// Thin I/O for `pa pair` / `pa status` / `pa upload`; request building + decoding live in PACore (tested).

func send<T: Decodable>(_ r: ApiRequest, as: T.Type) async throws(ApiError) -> T {
    var req = URLRequest(url: r.url, timeoutInterval: 30)
    req.httpMethod = r.method
    req.httpBody = r.body
    for (k, v) in r.headers { req.setValue(v, forHTTPHeaderField: k) }
    let (data, res): (Data, URLResponse)
    do { (data, res) = try await URLSession.shared.data(for: req) } catch {
        throw ApiError(status: nil, "\(r.url.host() ?? "server") unreachable: \(error.localizedDescription)")
    }
    guard let http = res as? HTTPURLResponse else { throw ApiError(status: nil, "not an HTTP response") }
    return try decodeResponse(T.self, status: http.statusCode, body: data)
}

/// Paired server + token, or a hint to run `pa pair`.
func pairedServer() throws -> (server: URL, token: String, config: AgentConfig) {
    let c = try loadAgentConfig()
    guard let s = c.serverURL, let token = try Keychain.readToken() else {
        throw SpikeError(description: "not paired; run `pa pair <server-url> <account>`")
    }
    return (try parseServerURL(s), token, c)
}

func pair(server: URL, account: String, deviceName: String?) async throws {
    var c = try loadAgentConfig()
    // Same server+account → reuse token: server treats it as idempotent and re-shows the pending code.
    let reuse = c.serverURL == server.absoluteString && c.account == account ? try Keychain.readToken() : nil
    let token = reuse ?? newDeviceToken()
    let name = deviceName ?? Host.current().localizedName ?? ProcessInfo.processInfo.hostName

    let p = try await send(try pairRequest(server: server, token: token, account: account, deviceName: name), as: PairResponse.self)
    try Keychain.saveToken(token)
    c.serverURL = server.absoluteString
    c.account = account
    c.deviceId = p.deviceId
    try saveAgentConfig(c)

    print(formatPairingPrompt(p, account: account, server: server))
    guard p.status == .pending else { return }
    print("Waiting for approval… (Ctrl-C to stop; re-run `pa pair` to see the code again)")
    // stdout is block-buffered when not a TTY (log file, pipe) → code would only appear after exit (verified live).
    fflush(nil)
    var reported = false
    while true {
        try await Task.sleep(for: .seconds(3))
        do {
            let me = try await send(deviceMeRequest(server: server, token: token), as: DeviceMeResponse.self)
            if me.status == .active {
                print("Paired: \(formatDeviceStatus(me, server: server))")
                return
            }
        } catch where error.status == 401 {
            // Wrong code deletes the pending pairing; unapproved ones lapse after 15 min.
            throw SpikeError(description: "pairing rejected or expired; run `pa pair` again")
        } catch {
            if !reported { eprint("still waiting (\(error))"); reported = true }
        }
    }
}

func status() async throws {
    let (server, token, _) = try pairedServer()
    do {
        print(formatDeviceStatus(try await send(deviceMeRequest(server: server, token: token), as: DeviceMeResponse.self), server: server))
    } catch where error.status == 401 {
        throw SpikeError(description: "server doesn't know this device (revoked, expired, or account disabled); run `pa pair` again")
    }
}

func upload(_ path: String) async throws {
    let (server, token, _) = try pairedServer()
    let u: TranscriptUpload
    do { u = try JSONDecoder().decode(TranscriptUpload.self, from: Data(contentsOf: URL(fileURLWithPath: path))) } catch {
        throw SpikeError(description: "\(path): not a TranscriptUpload JSON: \(error)")
    }
    let r = try await send(try uploadRequest(server: server, token: token, upload: u), as: TranscriptUploadResponse.self)
    print("\(r.created ? "uploaded" : "replaced") \(r.id) (\(u.segments.count) segments) → \(server.absoluteString)")
}
