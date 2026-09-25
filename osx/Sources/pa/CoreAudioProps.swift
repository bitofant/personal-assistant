import AVFoundation
import CoreAudio
import Foundation
import PACore

struct CoreAudioError: Error, CustomStringConvertible {
    let what: String
    let status: OSStatus
    var description: String { "\(what) failed: OSStatus \(status) \(fourCC(UInt32(bitPattern: status)))" }
}

func check(_ status: OSStatus, _ what: @autoclosure () -> String) throws {
    if status != noErr { throw CoreAudioError(what: what(), status: status) }
}

/// OSStatus/selector as 'abcd' when printable (Core Audio errors usually are).
func fourCC(_ v: UInt32) -> String {
    let bytes = [24, 16, 8, 0].map { UInt8((v >> UInt32($0)) & 0xff) }
    return bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7f }) ? "'\(String(decoding: bytes, as: UTF8.self))'" : ""
}

let systemObject = AudioObjectID(kAudioObjectSystemObject)
/// kAudioObjectUnknown's imported type varies by SDK; pin it.
let unknownObject: AudioObjectID = 0

func propAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func readScalar<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, initial: T) throws -> T {
    var addr = propAddress(sel)
    var size = UInt32(MemoryLayout<T>.size)
    var value = initial
    try check(AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value), "read \(fourCC(sel)) of \(obj)")
    return value
}

func readArray<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, zero: T) throws -> [T] {
    var addr = propAddress(sel)
    var size: UInt32 = 0
    try check(AudioObjectGetPropertyDataSize(obj, &addr, 0, nil, &size), "size of \(fourCC(sel))")
    var items = [T](repeating: zero, count: Int(size) / MemoryLayout<T>.stride)
    try check(AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &items), "read \(fourCC(sel))")
    return Array(items.prefix(Int(size) / MemoryLayout<T>.stride))
}

/// CFString-valued properties follow copy semantics → retained.
func readString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) throws -> String? {
    var addr = propAddress(sel)
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var value: Unmanaged<CFString>? = nil
    try check(AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value), "read \(fourCC(sel)) of \(obj)")
    return value.map { $0.takeRetainedValue() as String }
}

/// Processes registered with the audio system (not all running processes).
func listAudioProcesses() throws -> [AudioProcess] {
    let ids = try readArray(systemObject, kAudioHardwarePropertyProcessObjectList, zero: AudioObjectID(0))
    return ids.map { id in
        let pid = (try? readScalar(id, kAudioProcessPropertyPID, initial: pid_t(-1))) ?? -1
        let bundle: String? = try? readString(id, kAudioProcessPropertyBundleID)
        return AudioProcess(objectID: id, pid: pid, bundleID: bundle?.isEmpty == false ? bundle : nil)
    }
}

/// `sel` = kAudioHardwarePropertyDefault{Output,SystemOutput,Input}Device.
func defaultDevice(_ sel: AudioObjectPropertySelector) throws -> AudioObjectID {
    try readScalar(systemObject, sel, initial: AudioObjectID(0))
}

func deviceUID(_ dev: AudioObjectID) throws -> String {
    guard let uid = try readString(dev, kAudioDevicePropertyDeviceUID) else {
        throw CoreAudioError(what: "UID of device \(dev)", status: -1)
    }
    return uid
}

func deviceName(_ dev: AudioObjectID) -> String {
    (try? readString(dev, kAudioObjectPropertyName)) ?? "device \(dev)"
}

func describe(_ f: AVAudioFormat) -> String {
    "\(Int(f.sampleRate)) Hz, \(f.channelCount) ch, \(f.isInterleaved ? "interleaved" : "non-interleaved")"
}
