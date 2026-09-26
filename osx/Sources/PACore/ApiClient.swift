import Foundation

// Pure request building + response decoding; the `pa` target only moves bytes (URLSession).

public struct ApiError: Error, Equatable, CustomStringConvertible {
    /// nil = no HTTP response (network) or undecodable body.
    public let status: Int?
    public let message: String

    public init(status: Int?, _ message: String) {
        self.status = status
        self.message = message
    }

    public var description: String { status.map { "HTTP \($0): \(message)" } ?? message }
}

public struct ApiRequest: Equatable, Sendable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?
}

/// Server base URL: https required except loopback (token would travel in clear); trailing `/` stripped.
public func parseServerURL(_ s: String) throws(UsageError) -> URL {
    var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    while t.hasSuffix("/") { t.removeLast() }
    guard let c = URLComponents(string: t), let scheme = c.scheme?.lowercased(), let host = c.host, !host.isEmpty,
          c.query == nil, c.fragment == nil, let url = c.url
    else { throw UsageError("invalid server URL: \(s)") }
    let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())
    guard scheme == "https" || (scheme == "http" && loopback) else {
        throw UsageError("server URL must be https:// (http only for localhost): \(s)")
    }
    return url
}

/// Server requires ≥32 chars; 32 random bytes → 43 base64url chars.
public func newDeviceToken() -> String {
    var g = SystemRandomNumberGenerator()
    let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &g) }
    return Data(bytes).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

private func request(_ method: String, _ server: URL, _ path: String, token: String, json: Data? = nil) -> ApiRequest {
    var h = ["Authorization": "Bearer \(token)", "Accept": "application/json"]
    // Server rejects bodies without this (CSRF guard): 415.
    if json != nil { h["Content-Type"] = "application/json" }
    return ApiRequest(method: method, url: URL(string: server.absoluteString + path)!, headers: h, body: json)
}

public func pairRequest(server: URL, token: String, account: String, deviceName: String) throws -> ApiRequest {
    let body = try JSONEncoder().encode(PairRequest(account: account, deviceName: deviceName))
    return request("POST", server, "/api/devices/pair", token: token, json: body)
}

public func deviceMeRequest(server: URL, token: String) -> ApiRequest {
    request("GET", server, "/api/device/me", token: token)
}

public func uploadRequest(server: URL, token: String, upload: TranscriptUpload) throws -> ApiRequest {
    request("POST", server, "/api/device/transcripts", token: token, json: try JSONEncoder().encode(upload))
}

/// 2xx → decoded body; else `ErrorResponse.message` (or a snippet of the raw body, e.g. a proxy's HTML page).
public func decodeResponse<T: Decodable>(_: T.Type, status: Int, body: Data) throws(ApiError) -> T {
    guard (200..<300).contains(status) else {
        if let e = try? JSONDecoder().decode(ErrorResponse.self, from: body) { throw ApiError(status: status, e.message) }
        let raw = String(decoding: body.prefix(200), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        throw ApiError(status: status, raw.isEmpty ? "no response body" : raw)
    }
    do { return try JSONDecoder().decode(T.self, from: body) } catch {
        throw ApiError(status: nil, "unexpected response from server (HTTP \(status)): \(error)")
    }
}

/// `pa status` / pair-poll line.
public func formatDeviceStatus(_ me: DeviceMeResponse, server: URL) -> String {
    let state = me.status == .active ? "active" : "pending approval (enter the pairing code in the web UI)"
    return "\(me.deviceName) → \(me.account) @ \(server.absoluteString): \(state)"
}

/// Shown on the Mac only; the web UI never displays it (the user types it there).
public func formatPairingPrompt(_ p: PairResponse, account: String, server: URL) -> String {
    guard p.status == .pending, let code = p.pairingCode else { return "Already paired and active." }
    let spaced = code.count == 6 ? "\(code.prefix(3)) \(code.suffix(3))" : code
    return """
        Pairing code: \(spaced)
        Sign in as \(account) at \(server.absoluteString)/#/devices and enter this code.
        Expires: \(p.expiresAt ?? "—")
        """
}
