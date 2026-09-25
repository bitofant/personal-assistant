import CoreAudio
import Foundation
import PACore

func agentConfigURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
        .appending(path: "Library/Application Support/\(bundleID)/config.json")
}

/// Missing file = defaults; unreadable/invalid = error (never silently overwrite the user's file).
func loadAgentConfig() throws -> AgentConfig {
    let url = agentConfigURL()
    guard FileManager.default.fileExists(atPath: url.path) else { return AgentConfig() }
    do { return try parseAgentConfig(Data(contentsOf: url)) } catch {
        throw SpikeError(description: "\(url.path): \(error)")
    }
}

func saveAgentConfig(_ c: AgentConfig) throws {
    let url = agentConfigURL()
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try encodeAgentConfig(c).write(to: url, options: .atomic)
}

/// No TCC needed: device enumeration doesn't open the mic, so the bare binary works.
func listMics() throws {
    let selected = try loadAgentConfig().micDeviceUID
    let def = try? defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
    for d in try listInputDevices() {
        print(formatMicLine(d, isDefault: d.objectID == def, isSelected: d.uid == selected))
    }
}

func setMic(_ uid: String?) throws {
    var c = try loadAgentConfig()
    if let uid {
        guard let d = try listInputDevices().first(where: { $0.uid == uid }) else {
            throw SpikeError(description: "no input device with UID \(uid) (see `pa mics`)")
        }
        print("mic: \(d.name)")
    } else {
        print("mic: system default input")
    }
    c.micDeviceUID = uid
    try saveAgentConfig(c)
    print("saved \(agentConfigURL().path)")
}
