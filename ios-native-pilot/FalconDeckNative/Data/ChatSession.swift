import Foundation
import Observation

@MainActor @Observable
final class ChatSession {
    var transcript = Transcript()
    var transcriptExpansion: TranscriptExpansion?
    var draft = "" { didSet { changed?() } }
    var modelID = "" { didSet { changed?() } }
    var effort = "" { didSet { changed?() } }
    var provider = "" { didSet { changed?() } }
    var overrides: [String: JSON] = [:] { didSet { changed?() } }
    var attachments: [NativeAttachment] = [] { didSet { changed?() } }
    var submission: SavedSubmission? { didSet { changed?() } }
    var recoveredSubmission = false
    @ObservationIgnored var changed: (() -> Void)?
    var pendingQueue: [QueuedDraft] = []
    var preparingAttachments = false
    var loading = false
    var loaded = false
    var sending = false
    var stopping = false
    var hasOlder = false
    var oldestID: String?
    var error: String?
    var notice: String?
    var bufferedEvents: [JSON] = []
    var loadID = UUID()
    var bufferOverflowed = false
}

