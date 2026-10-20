import Foundation

struct NativeVoiceConfiguration: Codable, Equatable {
    var enabled = false
    var hotkey = "right_command"
    var repasteShortcutEnabled = true
    var activationMode = "hold"
    var microphoneID: String?
    var provider = "system"
    var transcriptionModel = "openai/gpt-4o-mini-transcribe"
    var fallbackModel = "mistralai/voxtral-mini-transcribe"
    var cleanupEnabled = false
    var rewriteEnabled = false
    var rewriteHotkey = "right_option"
    var rewriteModel = "openai/gpt-5.6-luna"
    var rewriteReasoning = ""
    var rewritePrompt = ""
    var historyRetentionHours = 6
    var parakeetIdleMinutes = 15

    init() {}

    private enum CodingKeys: String, CodingKey {
        case enabled, hotkey, repasteShortcutEnabled, activationMode, microphoneID, provider, transcriptionModel, fallbackModel
        case cleanupEnabled, rewriteEnabled, rewriteHotkey, rewriteModel, rewriteReasoning, rewritePrompt, historyRetentionHours, parakeetIdleMinutes
    }

    init(from decoder: Decoder) throws {
        self.init()
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? enabled
        hotkey = try values.decodeIfPresent(String.self, forKey: .hotkey) ?? hotkey
        repasteShortcutEnabled = try values.decodeIfPresent(Bool.self, forKey: .repasteShortcutEnabled) ?? repasteShortcutEnabled
        activationMode = try values.decodeIfPresent(String.self, forKey: .activationMode) ?? activationMode
        microphoneID = try values.decodeIfPresent(String.self, forKey: .microphoneID)
        provider = try values.decodeIfPresent(String.self, forKey: .provider) ?? provider
        transcriptionModel = try values.decodeIfPresent(String.self, forKey: .transcriptionModel) ?? transcriptionModel
        fallbackModel = try values.decodeIfPresent(String.self, forKey: .fallbackModel) ?? fallbackModel
        cleanupEnabled = try values.decodeIfPresent(Bool.self, forKey: .cleanupEnabled) ?? cleanupEnabled
        rewriteEnabled = try values.decodeIfPresent(Bool.self, forKey: .rewriteEnabled) ?? rewriteEnabled
        rewriteHotkey = try values.decodeIfPresent(String.self, forKey: .rewriteHotkey) ?? rewriteHotkey
        rewriteModel = try values.decodeIfPresent(String.self, forKey: .rewriteModel) ?? rewriteModel
        rewriteReasoning = try values.decodeIfPresent(String.self, forKey: .rewriteReasoning) ?? rewriteReasoning
        rewritePrompt = try values.decodeIfPresent(String.self, forKey: .rewritePrompt) ?? rewritePrompt
        historyRetentionHours = try values.decodeIfPresent(Int.self, forKey: .historyRetentionHours) ?? historyRetentionHours
        parakeetIdleMinutes = try values.decodeIfPresent(Int.self, forKey: .parakeetIdleMinutes) ?? parakeetIdleMinutes
    }
}

struct NativeMicrophone: Codable, Identifiable {
    var id: String
    var name: String
    var isDefault: Bool
}

struct NativeRecording: Codable, Identifiable {
    var id: UUID = UUID()
    var date: Date = Date()
    var provider: String
    var transcript: String?
    var error: String?
    var duration: Double
    var path: String
}

struct NativeDictionaryEntry: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var find: String
    var replacement: String
}

enum NativeCorrectionDictionary {
    /// Match against the original text in one pass. Longest phrases win and a
    /// replacement is never fed back through another rule.
    static func apply(_ entries: [NativeDictionaryEntry], to text: String) -> String {
        let rules = entries.filter { !$0.find.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { $0.find.utf16.count > $1.find.utf16.count }
        guard !rules.isEmpty else { return text }
        func isWord(_ character: Character?) -> Bool {
            guard let character else { return false }
            return character == "_" || character.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) }
        }
        let alternatives = rules.map {
            (isWord($0.find.first) ? "(?<![\\p{L}\\p{N}_])" : "") + NSRegularExpression.escapedPattern(for: $0.find) +
                (isWord($0.find.last) ? "(?![\\p{L}\\p{N}_])" : "")
        }
        let pattern = "(?:" + alternatives.joined(separator: "|") + ")"
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return text }
        let original = text as NSString
        let matches = expression.matches(in: text, range: NSRange(location: 0, length: original.length))
        var output = ""
        var cursor = 0
        for match in matches {
            guard match.range.location >= cursor else { continue }
            output += original.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            let heard = original.substring(with: match.range)
            let replacement = rules.first { $0.find.compare(heard, options: [.caseInsensitive]) == .orderedSame }?.replacement ?? heard
            cursor = NSMaxRange(match.range)
            if replacement.isEmpty {
                if output.isEmpty || output.last.map({ [" ", "\t", "\n", "\r"].contains($0) }) == true {
                    while cursor < original.length && [UInt16(32), UInt16(9)].contains(original.character(at: cursor)) { cursor += 1 }
                }
                if cursor == original.length || [UInt16(10), UInt16(13)].contains(original.character(at: cursor)) {
                    while output.last == " " || output.last == "\t" { output.removeLast() }
                }
            } else { output += replacement }
        }
        output += original.substring(from: cursor)
        return output
    }
}

enum NativeSpeechFiles {
    static let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("FalconDeck Native/Voice", isDirectory: true)
    static let historyURL = directory.appendingPathComponent("history.json")
    static let recoveryURL = directory.appendingPathComponent("transcript-recovery.json")

    /// The native recorder only creates these files in the user's temporary
    /// directory. Resolve symlinks before both reading and deleting any take.
    static func validatedURL(_ path: String) throws -> URL {
        let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        let temp = FileManager.default.temporaryDirectory.standardizedFileURL.resolvingSymlinksInPath()
        guard url.deletingLastPathComponent() == temp,
              url.lastPathComponent.hasPrefix("falcondeck-native-dictation-"),
              ["caf", "m4a"].contains(url.pathExtension.lowercased()) else {
            throw PilotError("The recording is outside FalconDeck’s audio directory.")
        }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw PilotError("The recording is unavailable.")
        }
        return url
    }

    static func save<T: Encodable>(_ value: T, at url: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(value).write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

struct NativeTranscriptRecovery: Codable {
    var text: String
    var date: Date = Date()
}

enum NativeSpeechTextAnchor {
    /// Text typed after the captured caret survives insertion. Edits before
    /// that caret or inside the selection invalidate the captured destination.
    static func replacementRange(original: String, selection: NSRange, current: String) -> NSRange? {
        let before = original as NSString
        let now = current as NSString
        guard selection.location >= 0, selection.length >= 0,
              selection.location <= before.length, selection.length <= before.length - selection.location,
              selection.location <= now.length, selection.length <= now.length - selection.location,
              before.substring(to: selection.location) == now.substring(to: selection.location),
              before.substring(with: selection) == now.substring(with: selection) else { return nil }
        return selection
    }
}
