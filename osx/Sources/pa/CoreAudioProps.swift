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

func propAddress(
    _ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
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

/// Devices with ≥1 input stream (mics, interfaces, virtual inputs).
func listInputDevices() throws -> [MicDevice] {
    try readArray(systemObject, kAudioHardwarePropertyDevices, zero: AudioObjectID(0)).compactMap { id in
        var addr = propAddress(kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0,
              let uid = try? deviceUID(id) else { return nil }
        return MicDevice(objectID: id, uid: uid, name: deviceName(id))
    }
}

func describe(_ f: AVAudioFormat) -> String {
    "\(Int(f.sampleRate)) Hz, \(f.channelCount) ch, \(f.isInterleaved ? "interleaved" : "non-interleaved")"
}
