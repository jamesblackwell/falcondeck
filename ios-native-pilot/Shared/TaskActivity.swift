import ActivityKit
import Foundation

/// Small display metadata only. Credentials, prompts and replies never enter
/// the widget process. The pairing fingerprint is checked again on every tap.
struct NativeTaskAttributes: ActivityAttributes, Equatable {
    enum Phase: String, Codable, Hashable {
        case working, needsInput, completed, failed
        var label: String {
            switch self {
            case .working: "Working"
            case .needsInput: "Needs you"
            case .completed: "Completed"
            case .failed: "Needs attention"
            }
        }
        var symbol: String {
            switch self {
            case .working: "diamond.fill"
            case .needsInput: "hand.raised.fill"
            case .completed: "checkmark.circle.fill"
            case .failed: "exclamationmark.circle.fill"
            }
        }
        var terminal: Bool { self == .completed || self == .failed }
    }
    struct ContentState: Codable, Hashable {
        var title: String
        var project: String
        var phase: Phase
        var startedAt: Date
        var updatedAt: Date
        var connected: Bool
    }
    var pairing: String
    var workspaceID: String
    var threadID: String

    var url: URL? {
        var parts = URLComponents()
        parts.scheme = "falcondeck-native"; parts.host = "task"
        parts.queryItems = [URLQueryItem(name: "pairing", value: pairing), URLQueryItem(name: "workspace", value: workspaceID), URLQueryItem(name: "thread", value: threadID)]
        return parts.url
    }
    init(pairing: String, workspaceID: String, threadID: String) {
        self.pairing = pairing; self.workspaceID = workspaceID; self.threadID = threadID
    }
    init?(url: URL) {
        guard url.scheme == "falcondeck-native", url.host == "task",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              items.count == 3 else { return nil }
        func value(_ key: String) -> String? {
            let matches = items.filter { $0.name == key }
            guard matches.count == 1, let value = matches.first?.value, !value.isEmpty, value.utf8.count <= 512 else { return nil }
            return value
        }
        guard let pairing = value("pairing"), pairing.count == 64, pairing.allSatisfy({ $0.isHexDigit }),
              let workspace = value("workspace"), let thread = value("thread") else { return nil }
        self.init(pairing: pairing, workspaceID: workspace, threadID: thread)
    }
}
