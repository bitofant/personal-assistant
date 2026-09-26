import Foundation

// Codable mirrors of shared/api.ts (source of truth). Timestamps stay ISO strings: the server normalizes them.
// Swift's synthesized encoder omits nil keys; the server treats missing = null.

public struct ErrorResponse: Codable, Equatable, Sendable {
    public var message: String
}

public struct HealthResponse: Codable, Equatable, Sendable {
    public var ok: Bool
    public var version: String
}

public struct PairRequest: Codable, Equatable, Sendable {
    public var account: String
    public var deviceName: String
}

public enum DeviceStatus: String, Codable, Equatable, Sendable {
    case pending, active
}

public struct PairResponse: Codable, Equatable, Sendable {
    public var deviceId: String
    public var status: DeviceStatus
    public var pairingCode: String?
    public var expiresAt: String?
}

public struct DeviceMeResponse: Codable, Equatable, Sendable {
    public var deviceId: String
    public var account: String
    public var deviceName: String
    public var status: DeviceStatus
}

public struct Person: Codable, Equatable, Sendable {
    public var name: String?
    public var email: String?

    public init(name: String?, email: String?) {
        self.name = name
        self.email = email
    }
}

public struct MeetingMeta: Codable, Equatable, Sendable {
    public var calendarName: String?
    public var eventId: String?
    public var seriesId: String?
    public var title: String?
    public var start: String
    public var end: String
    public var organizer: Person?
    public var attendees: [Person]

    public init(
        calendarName: String?, eventId: String?, seriesId: String?, title: String?, start: String, end: String,
        organizer: Person?, attendees: [Person]
    ) {
        self.calendarName = calendarName
        self.eventId = eventId
        self.seriesId = seriesId
        self.title = title
        self.start = start
        self.end = end
        self.organizer = organizer
        self.attendees = attendees
    }
}

public struct TranscriptSegment: Codable, Equatable, Sendable {
    /// Seconds since recording start.
    public var start: Double
    public var end: Double
    public var speaker: String?
    public var text: String

    public init(start: Double, end: Double, speaker: String?, text: String) {
        self.start = start
        self.end = end
        self.speaker = speaker
        self.text = text
    }
}

public struct TranscriptUpload: Codable, Equatable, Sendable {
    /// Client-generated UUID; re-upload with the same id replaces.
    public var id: String
    public var startedAt: String
    public var endedAt: String
    public var meeting: MeetingMeta?
    public var segments: [TranscriptSegment]
    public var asrModel: String
    public var diarizationModel: String?

    public init(
        id: String, startedAt: String, endedAt: String, meeting: MeetingMeta?,
        segments: [TranscriptSegment], asrModel: String, diarizationModel: String?
    ) {
        self.id = id
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.meeting = meeting
        self.segments = segments
        self.asrModel = asrModel
        self.diarizationModel = diarizationModel
    }
}

public struct TranscriptUploadResponse: Codable, Equatable, Sendable {
    public var id: String
    public var created: Bool
}
