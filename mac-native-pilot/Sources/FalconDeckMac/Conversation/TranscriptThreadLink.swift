import Foundation
import SwiftUI

enum TranscriptThreadLink {
    static func parse(_ value: String) -> String? {
        let prefix = "falcondeck://thread/"
        guard value.lowercased().hasPrefix(prefix),
              let id = String(value.dropFirst(prefix.count)).removingPercentEncoding,
              !id.isEmpty, id != ".", id != "..",
              id.range(of: #"[^a-zA-Z0-9._:-]"#, options: .regularExpression) == nil else { return nil }
        return id
    }

    static func targetID(_ id: String, sourceID: String?) -> String {
        guard let host = sourceID.flatMap({ NativeHostManager.split($0).hostID }) else { return id }
        return NativeHostManager.namespace(hostID: host, id: id)
    }
}

@MainActor extension AppStore {
    func openTaskLink(_ id: String) async {
        let target = TranscriptThreadLink.targetID(id, sourceID: selectedTaskID)
        guard tasks.contains(where: { $0.id == target }) else {
            errorMessage = "This task is no longer available on this computer."
            return
        }
        await selectTask(target, preservePinScope: false)
    }
}

private struct TranscriptOpenThreadKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}

extension EnvironmentValues {
    var transcriptOpenThread: ((String) -> Void)? {
        get { self[TranscriptOpenThreadKey.self] }
        set { self[TranscriptOpenThreadKey.self] = newValue }
    }
}
