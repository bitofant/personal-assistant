import Foundation
import PACore
import Security

/// Device bearer token: Keychain only, never config.json. Generic password, service = bundle id.
enum Keychain {
    // Computed: a static `let` of [String: Any] isn't Sendable (Swift 6 error).
    private static var base: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: bundleID,
        kSecAttrAccount as String: "device-token",
    ] }

    static func readToken() throws -> String? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        if st == errSecItemNotFound { return nil }
        guard st == errSecSuccess, let data = out as? Data else { throw keychainError("read", st) }
        return String(decoding: data, as: UTF8.self)
    }

    static func saveToken(_ token: String) throws {
        let value: [String: Any] = [kSecValueData as String: Data(token.utf8)]
        var st = SecItemUpdate(base as CFDictionary, value as CFDictionary)
        if st == errSecItemNotFound {
            st = SecItemAdd(base.merging(value) { $1 } as CFDictionary, nil)
        }
        guard st == errSecSuccess else { throw keychainError("save", st) }
    }

    private static func keychainError(_ op: String, _ st: OSStatus) -> SpikeError {
        let msg = SecCopyErrorMessageString(st, nil) as String? ?? "OSStatus \(st)"
        return SpikeError(description: "Keychain \(op) failed: \(msg)")
    }
}
