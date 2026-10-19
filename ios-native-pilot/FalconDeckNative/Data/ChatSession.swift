import Foundation
import Observation

@MainActor @Observable
final class ChatSession {
    var transcript = Transcript() { didSet { presentationCache = nil } }
    var transcriptExpansion: TranscriptExpansion?
    var draft = "" { didSet { changed?() } }
    var modelID = "" { didSet { changed?() } }
    var effort = "" { didSet { changed?() } }
    var provider = "" { didSet { changed?() } }
    var overrides: [String: JSON] = [:] { didSet { changed?() } }
    var attachments: [NativeAttachment] = [] { didSet { changed?() } }
    var submission: SavedSubmission? { didSet { changed?() } }
    var outgoingMessage: OutgoingMessage?
    var composerFocused = false
    var recoveredSubmission = false
    @ObservationIgnored var restoringSelection = false
    @ObservationIgnored var changed: (() -> Void)?
    var pendingQueue: [QueuedDraft] = []
    var queuedEdit: QueuedMessageEdit?
    var preparingAttachments = false
    var voiceInputOpen = false
    var voiceInsertion: VoiceDraftInsertion?
    var loading = false
    var loaded = false
    var needsRefresh = false
    var sending = false
    var stopping = false
    var hasOlder = false
    var oldestID: String?
    var error: String?
    var historyError: String?
    var olderHistoryError: String?
    var notice: String?
    var bufferedEvents: [JSON] = []
    var loadID = UUID()
    var bufferOverflowed = false
    @ObservationIgnored private var presentationCache: (revision: Int, preferences: JSON, running: Bool, value: TranscriptPresentation, pendingTail: Message?)?

    func presentation(preferences: ConversationPreferences, running: Bool) -> TranscriptPresentation {
        let revision = transcript.revision
        if let cache = presentationCache, cache.revision == revision, cache.preferences == preferences.raw, cache.running == running {
            if let tail = cache.pendingTail {
                if let value = cache.value.updatingAssistantTail(tail) {
                    presentationCache = (revision, preferences.raw, running, value, nil)
                    return value
                }
            } else { return cache.value }
        }
        let value = TranscriptPresentation(transcript.items, preferences: preferences, running: running)
        presentationCache = (revision, preferences.raw, running, value, nil)
        return value
    }

    func apply(_ event: JSON) {
        // Metadata, audio and token-usage updates do not mutate the transcript.
        // Even a no-op mutating call would notify its SwiftUI observers.
        switch event["type"].string {
        case "realtime-item-added", "conversation-item-added", "conversation-item-updated", "text", "tool-call-start", "tool-call-end", "turn-end": break
        default: return
        }
        let cached = presentationCache
        transcript.apply(event)
        guard let cached else { return }
        if transcript.revision == cached.revision {
            presentationCache = cached // Replayed text or an ignored plan delta.
        } else if event["type"].string == "text", event["target"].string == "assistant_message",
                  let tail = transcript.items.last, tail.kind == "assistant_message", tail.id == event["item_id"].string {
            // Defer the row-array update until a view actually requests it.
            // Hidden chats and multiple tokens in one frame only retain a tail.
            presentationCache = (transcript.revision, cached.preferences, cached.running, cached.value, tail)
        }
    }

    @discardableResult func insertVoiceTranscript(_ text: String) -> String.Index {
        let insertion = (voiceInsertion ?? VoiceDraftInsertion(original: draft, selection: nil)).inserting(text, into: draft)
        draft = insertion.text
        voiceInsertion = nil; voiceInputOpen = false
        return insertion.caret
    }
}

