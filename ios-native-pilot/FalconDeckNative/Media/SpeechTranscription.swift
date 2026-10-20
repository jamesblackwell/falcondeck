import Foundation

enum NativeSpeechSettings {
    static let defaultProvider = "openrouter"
    static let defaultModel = "openai/gpt-4o-mini-transcribe"
    static func provider(in defaults: UserDefaults) -> String {
        defaults.string(forKey: "native.speech.provider") == "on-device" ? "on-device" : defaultProvider
    }
    static func validateAudio(_ audio: Data) throws {
        guard !audio.isEmpty else { throw PilotError("This recording is empty. Delete it and record a new message.") }
        guard audio.count <= 8 * 1024 * 1024 else { throw PilotError("Record a shorter message (up to 8 MB).") }
    }
    static func parameters(audio: Data, defaults: UserDefaults) throws -> JSON {
        try validateAudio(audio)
        let model = defaults.string(forKey: "native.speech.model")?.trimmingCharacters(in: .whitespacesAndNewlines).nonempty ?? defaultModel
        var params = JSON.object(["audio_base64": .string(audio.base64EncodedString()), "format": .string("m4a"), "model": .string(model)])
        if let language = defaults.string(forKey: "native.speech.language")?.trimmingCharacters(in: .whitespacesAndNewlines).nonempty {
            params = params.setting("language", .string(language))
        }
        return params
    }
}

/// Uses the same daemon RPC, model and bounded retry policy as the Expo client.
@MainActor enum SpeechTranscription {
    static let maxAttempts = 10
    static func retryDelay(_ attempt: Int) -> Duration { .milliseconds(min(4000, 500 * (1 << min(3, max(0, attempt - 1))))) }
    static func retryable(_ error: Error) -> Bool {
        !(error is CancellationError) && error.localizedDescription.range(of: "too large to send securely|shorter clip|shorter message|not configured|API key was rejected|needs credit|unsupported audio format|not valid base64|must be between 1 byte|invalid OpenRouter", options: [.regularExpression, .caseInsensitive]) == nil
    }
    static func transcribe(params: JSON, relay: any RelayServing, isCurrent: () -> Bool, onAttempt: (Int) -> Void, beforeAttempt: () async throws -> Void = {}, wait: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) async throws -> String {
        for attempt in 1...maxAttempts {
            try Task.checkCancellation()
            guard isCurrent() else { throw CancellationError() }
            try await beforeAttempt()
            guard isCurrent(), !Task.isCancelled else { throw CancellationError() }
            onAttempt(attempt)
            do {
                let response = try await relay.call("speech.transcribe", params: params)
                guard isCurrent(), !Task.isCancelled else { throw CancellationError() }
                let text = response["text"].string.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { throw PilotError("No speech was detected. Your recording is safe, so you can retry.") }
                return text
            } catch {
                guard isCurrent(), !Task.isCancelled else { throw CancellationError() }
                guard attempt < maxAttempts, retryable(error), !error.localizedDescription.hasPrefix("No speech was detected") else { throw error }
                try await wait(retryDelay(attempt))
            }
        }
        throw PilotError("Transcription failed. Your recording is safe.")
    }
}

/// Keep a selection only while its draft still matches; never apply stale UTF-16
/// offsets to a draft changed during an asynchronous transcription.
struct VoiceDraftInsertion {
    let original: String
    let selection: NSRange?
    static func capture(_ indices: Range<String.Index>, in draft: String) -> Self {
        // Only positions obtained from this string may become UTF-16 offsets.
        // NSRange(staleIndices, in: draft) traps when SwiftUI retains a selection
        // after the draft is shortened or cleared.
        let utf16 = draft.utf16
        var start: Int?, end: Int?, offset = 0
        for index in utf16.indices {
            if index == indices.lowerBound { start = offset }
            if index == indices.upperBound { end = offset }
            offset += 1
        }
        if indices.lowerBound == utf16.endIndex { start = offset }
        if indices.upperBound == utf16.endIndex { end = offset }
        let range: NSRange?
        if let start, let end, start <= end { range = NSRange(location: start, length: end - start) }
        else { range = nil }
        return Self(original: draft, selection: range)
    }
    func inserting(_ transcript: String, into draft: String) -> (text: String, caret: String.Index) {
        let range = original.utf16.elementsEqual(draft.utf16) ? selection.flatMap { Range($0, in: draft) } : nil
        let target = range ?? (draft.endIndex..<draft.endIndex)
        let before = String(draft[..<target.lowerBound]), after = String(draft[target.upperBound...])
        let cleaned = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return (draft, target.lowerBound) }
        let leading = before.last.map { $0.isWhitespace ? "" : " " } ?? ""
        let trailing = after.first.map { $0.isWhitespace ? "" : " " } ?? ""
        let prefix = before + leading + cleaned
        let text = prefix + trailing + after
        return (text, text.index(text.startIndex, offsetBy: prefix.count))
    }
}
