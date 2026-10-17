import ActivityKit
import AppIntents
import Foundation

struct NativeSpeechAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var phase: String
        var startedAt: Date
        var pausedAt: Date?
    }
    var startedAt: Date
}

enum NativeSpeechCommand: String, AppEnum {
    case finish, cancel, toggle, stop
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Speech control" }
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] { [.finish: "Finish recording", .cancel: "Cancel recording", .toggle: "Pause or resume", .stop: "Stop playback"] }
}

@MainActor enum NativeSpeechBridge {
    static var handler: (@MainActor @Sendable (NativeSpeechCommand) async -> Void)?
    static func perform(_ action: NativeSpeechCommand) async {
        if let handler { await handler(action) }
        else { for activity in Activity<NativeSpeechAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) } }
    }
}

struct NativeSpeechIntent: LiveActivityIntent {
    static var title: LocalizedStringResource { "Control FalconDeck speech" }
    @Parameter(title: "Action") var action: NativeSpeechCommand
    init() { }
    init(_ action: NativeSpeechCommand) { self.action = action }
    func perform() async throws -> some IntentResult { await NativeSpeechBridge.perform(action); return .result() }
}
