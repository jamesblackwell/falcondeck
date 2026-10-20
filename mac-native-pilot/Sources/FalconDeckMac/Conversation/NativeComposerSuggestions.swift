import CryptoKit
import Foundation
import SwiftUI

struct NativeComposerSuggestion: Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let prompt: String
    let description: String?
}

struct NativeComposerSuggestionOffer: Hashable, Sendable {
    let extensionID: String
    let primary: NativeComposerSuggestion
    let actions: [NativeComposerSuggestion]
    let key: String
}

/// Mirrors the shared composer-suggestions projection. Extension identifiers
/// and thread scopes are opaque: only a declared view owned by an active,
/// enabled extension can contribute to this host-owned surface.
enum NativeComposerSuggestionProjection {
    static func derive(
        extensions: JSON, threadID: String?, threadStatus: String?, draft: String = "",
        hasPendingRequests: Bool = false, hasPendingSubmission: Bool = false
    ) -> NativeComposerSuggestionOffer? {
        guard let threadID, !threadID.isEmpty, threadStatus == "idle", draft.isEmpty,
              !hasPendingRequests, !hasPendingSubmission else { return nil }

        let catalog = extensions["catalog"].array.prefix(256).filter {
            $0["enabled"].bool && $0["status"].string == "active" && identifier($0["id"], limit: 256) != nil
        }.sorted { $0["id"].string < $1["id"].string }
        let views = extensions["views"].array.prefix(4096).filter {
            $0["scope"]["kind"].string == "thread" && $0["scope"]["id"].string == threadID &&
            identifier($0["extension_id"], limit: 256) != nil && identifier($0["view_id"], limit: 256) != nil
        }.sorted {
            let left = $0["view_id"].string, right = $1["view_id"].string
            return left == right ? $0["updated_at"].string.prefix(128) > $1["updated_at"].string.prefix(128) : left < right
        }

        for item in catalog {
            let extensionID = item["id"].string
            let declared = Set(item["contributes"]["composerSuggestions"].array.prefix(128).compactMap {
                identifier($0["view"], limit: 256)
            })
            guard !declared.isEmpty else { continue }
            for view in views where view["extension_id"].string == extensionID && declared.contains(view["view_id"].string) {
                var seen = Set<String>()
                var actions: [NativeComposerSuggestion] = []
                for raw in view["value"]["actions"].array.prefix(128) {
                    guard let action = normalize(raw), seen.insert(action.id).inserted else { continue }
                    actions.append(action)
                    if actions.count == 5 { break }
                }
                guard !actions.isEmpty else { continue }
                if let preferred = identifier(view["value"]["preferredActionId"], limit: 64),
                   let index = actions.firstIndex(where: { $0.id == preferred }), index > 0 {
                    actions.insert(actions.remove(at: index), at: 0)
                }
                let key = offerKey(extensionID: extensionID, threadID: threadID, view: view, actions: actions)
                return NativeComposerSuggestionOffer(extensionID: extensionID, primary: actions[0], actions: actions, key: key)
            }
        }
        return nil
    }

    private static func normalize(_ raw: JSON) -> NativeComposerSuggestion? {
        guard let id = identifier(raw["id"], limit: 64),
              let label = boundedText(raw["label"], limit: 30, marker: true),
              let prompt = boundedText(raw["prompt"], limit: 512, marker: false) else { return nil }
        let description = boundedText(raw["description"], limit: 120, marker: true, collapseWhitespace: true)
        return NativeComposerSuggestion(id: id, label: label, prompt: prompt, description: description)
    }

    private static func identifier(_ raw: JSON, limit: Int) -> String? {
        guard case .string(let value) = raw, value.utf8.prefix(4097).count <= 4096 else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.unicodeScalars.prefix(limit + 1).count <= limit,
              !trimmed.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
        return trimmed
    }

    private static func boundedText(_ raw: JSON, limit: Int, marker: Bool, collapseWhitespace: Bool = false) -> String? {
        guard case .string(let value) = raw, value.utf8.prefix(16385).count <= 16384 else { return nil }
        var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if collapseWhitespace { text = text.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        guard !text.isEmpty else { return nil }
        let scalars = text.unicodeScalars
        guard scalars.prefix(limit + 1).count > limit else { return text }
        return String(String.UnicodeScalarView(scalars.prefix(marker ? limit - 1 : limit))) + (marker ? "…" : "")
    }

    private static func offerKey(extensionID: String, threadID: String, view: JSON, actions: [NativeComposerSuggestion]) -> String {
        // Include content as well as daemon timestamps. A changed offer must
        // replace a dismissal even if an older peer reuses its timestamp.
        let content = JSON.array([
            .string(extensionID), .string(threadID), view["view_id"],
            .string(String(view["updated_at"].string.prefix(128))),
            .array(actions.map { .array([.string($0.id), .string($0.label), .string($0.prompt), $0.description.map(JSON.string) ?? .null]) })
        ])
        let digest = SHA256.hash(data: (try? content.data()) ?? Data())
        return extensionID + ":" + digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// A selected offer is its own turn. The captured target and offer are checked
/// again immediately before sending, leaving current composer input intact.
struct NativeComposerSuggestionsView: View {
    let store: AppStore
    var settings: [String: JSON] = [:]
    @State private var dismissed: [String: String] = [:]

    private var offer: NativeComposerSuggestionOffer? {
        NativeComposerSuggestionProjection.derive(
            extensions: store.extensions, threadID: store.selectedTaskID, threadStatus: store.selectedTask?.status,
            draft: store.draft, hasPendingRequests: !store.pendingRequests.isEmpty || store.selectedTask?.awaitingInput == true,
            hasPendingSubmission: store.pendingSubmission != nil || store.isSending
        )
    }
    private var context: String {
        [store.selectedProjectID ?? "", store.composerKey, store.selectedTask?.provider ?? "", store.selectedTask?.latestTurnID ?? ""].joined(separator: "\u{1F}")
    }
    private var connected: Bool {
        guard let hostID = store.selectedHostID else { return store.isConnected }
        return NativeHostManager.shared.hosts.first { $0.id == hostID }?.status == .connected
    }

    var body: some View {
        if let offer, let taskID = store.selectedTaskID, dismissed[taskID] != offer.key {
            let currentContext = context
            HStack(spacing: 0) {
                Button { choose(offer.primary, offer: offer, context: currentContext) } label: {
                    Label(offer.primary.label, systemImage: "sparkles")
                        .lineLimit(1).padding(.horizontal, 13).padding(.vertical, 9).contentShape(.rect)
                }.help(offer.primary.description ?? offer.primary.prompt)
                    .accessibilityLabel("Send suggestion: " + offer.primary.label)
                    .accessibilityIdentifier("composer-primary-suggestion")
                if offer.actions.count > 1 {
                    FDTheme.line.frame(width: 1)
                    Menu {
                        ForEach(offer.actions.dropFirst()) { action in
                            Button { choose(action, offer: offer, context: currentContext) } label: {
                                Text(action.label)
                                if let description = action.description { Text(description) }
                            }
                        }
                    } label: {
                        Image(systemName: "chevron.up").padding(.horizontal, 10).padding(.vertical, 9)
                    }.menuStyle(.borderlessButton).fixedSize().help("More suggested actions")
                        .accessibilityLabel("More suggested actions")
                }
                FDTheme.line.frame(width: 1)
                Button {
                    guard context == currentContext, self.offer?.key == offer.key else { return }
                    if dismissed.count >= 256 { dismissed.removeAll(keepingCapacity: true) }
                    dismissed[taskID] = offer.key
                } label: {
                    Image(systemName: "xmark").padding(.horizontal, 10).padding(.vertical, 9)
                }.foregroundStyle(FDTheme.muted).help("Dismiss suggestions").accessibilityLabel("Dismiss suggestions")
            }.buttonStyle(.plain).font(NativePreferences.shared.font(size: 13, weight: .medium))
                .foregroundStyle(FDTheme.secondary).fixedSize(horizontal: false, vertical: true)
                .background(FDTheme.raised, in: Capsule()).overlay { Capsule().strokeBorder(FDTheme.line) }
                .disabled(!connected).padding(.horizontal, 28).padding(.top, 10)
                .frame(maxWidth: 900).frame(maxWidth: .infinity)
                .accessibilityElement(children: .contain).accessibilityLabel("Suggested next steps")
        }
    }

    private func choose(_ action: NativeComposerSuggestion, offer: NativeComposerSuggestionOffer, context expected: String) {
        guard context == expected, connected, let current = self.offer, current.key == offer.key,
              current.actions.contains(action), let taskID = store.selectedTaskID else { return }
        let capturedSettings = settings
        Task { @MainActor in
            guard context == expected, connected, store.selectedTaskID == taskID, self.offer?.key == offer.key else { return }
            await store.sendInputs([.object(["type": .string("text"), "text": .string(action.prompt)])],
                                   settings: capturedSettings, preserveComposer: true)
        }
    }
}
