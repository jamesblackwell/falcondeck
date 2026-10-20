import SwiftUI

struct NativeExtensionToolResult: Identifiable, Equatable {
    let itemID: String
    let extensionID: String
    let toolID: String
    let arguments: JSON
    let result: JSON
    let detailTitle: String?
    var id: String { extensionID + ":" + toolID + ":" + itemID }
}

/// Provenance comes only from the bridge's MCP metadata, never tool arguments,
/// visible output, or a result body that an agent could have authored itself.
enum NativeExtensionToolResultMatcher {
    static func matches(messages: [Message], catalog: [JSON], registrations: [JSON]) -> [NativeExtensionToolResult] {
        var seen: Set<String> = []
        var results: [NativeExtensionToolResult] = []
        for message in messages.reversed() {
            let detail = message.raw["detail"]
            let result = detail["result"]
            let identity = result["_meta"]["falcondeck/extensionTool"]
            let extensionID = identity["extensionId"].string
            let toolID = identity["toolId"].string
            let key = extensionID + "\0" + toolID
            guard message.kind == "tool_call", detail["kind"].string == "mcp",
                  detail["server"].string == "falcondeck-extensions",
                  result != .null, result["isError"] != .bool(true),
                  !extensionID.isEmpty, !toolID.isEmpty, !seen.contains(key),
                  let item = catalog.first(where: { $0["id"].string == extensionID }),
                  allowed(item, extensionID: extensionID, toolID: toolID, registrations: registrations),
                  let registration = registrations.first(where: { $0["extensionId"].string == extensionID })?["agentToolResults"].array.first(where: { $0["toolId"].string == toolID }) else { continue }
            seen.insert(key)
            let structured = result["structuredContent"] == .null ? result["structured_content"] : result["structuredContent"]
            results.append(.init(itemID: message.id, extensionID: extensionID, toolID: toolID,
                                 arguments: detail["arguments"], result: structured,
                                 detailTitle: registration["detail"]["title"].string.nonempty))
        }
        return results.reversed()
    }

    static func allowed(_ item: JSON, extensionID: String, toolID: String, registrations: [JSON]) -> Bool {
        item["id"].string == extensionID && item["enabled"].bool && item["bundled"].bool
            && item["status"].string == "active"
            && item["granted_permissions"].array.contains(.string("agent-tools:register"))
            && item["contributes"]["agentTools"].array.contains(where: { $0["id"].string == toolID })
            && registrations.contains(where: {
                $0["extensionId"].string == extensionID && $0["agentToolResults"].array.contains(where: { $0["toolId"].string == toolID })
            })
    }
}

/// Mount once at transcript level, after the normal groups. Ordinary MCP rows
/// remain available when an extension is disabled, unavailable, or fails.
struct NativeExtensionToolResults: View {
    let store: AppStore
    let messages: [Message]
    @State private var repository = NativeExtensionRepository()
    @State private var detail: NativeExtensionToolResult?
    @State private var heights: [String: CGFloat] = [:]
    @Environment(\.colorScheme) private var colorScheme

    private var hostID: String? { store.selectedTaskID.flatMap { NativeHostManager.split($0).hostID } }
    private var matches: [NativeExtensionToolResult] {
        NativeExtensionToolResultMatcher.matches(messages: messages, catalog: store.extensionsForHost(hostID)["catalog"].array,
                                                 registrations: NativeExtensionCompatibilityHost.registrations)
    }

    var body: some View {
        VStack(spacing: 12) {
            if !matches.isEmpty, let error = repository.error {
                Text(error).font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }
            ForEach(matches) { result in
                renderer(result, presentation: "inline")
                    .frame(height: heights[result.id] ?? 180)
                    .accessibilityLabel("Extension result")
            }
        }
        .onAppear { repository.adopt(store.extensionsForHost(hostID)) }
        .onChange(of: store.extensionsForHost(hostID)) { _, snapshot in repository.adopt(snapshot) }
        .onChange(of: hostID) { _, _ in detail = nil; heights = [:]; repository.adopt(store.extensionsForHost(hostID)) }
        .onChange(of: matches) { _, matches in if let detail, !matches.contains(detail) { self.detail = nil } }
        .sheet(item: $detail) { result in
            VStack(spacing: 0) {
                HStack {
                    Text(result.detailTitle ?? "Extension result").font(NativePreferences.shared.font(size: 18, weight: .semibold))
                    Spacer()
                    Button { detail = nil } label: { Image(systemName: "xmark") }.help("Close details").keyboardShortcut(.cancelAction)
                }.padding(20)
                Divider()
                renderer(result, presentation: "detail").frame(maxWidth: .infinity, maxHeight: .infinity)
            }.frame(minWidth: 760, minHeight: 560).background(FDTheme.surface)
        }
    }

    private func renderer(_ result: NativeExtensionToolResult, presentation: String) -> some View {
        NativeExtensionCompatibilityHost(store: store, repository: repository, extensionID: result.extensionID, panelID: "",
                                         appearance: colorScheme == .dark ? "dark" : "light", appearanceSettings: NativePreferences.shared.exportSettings(),
                                         toolResult: result, presentation: presentation, hostID: hostID,
                                         onOpenDetails: presentation == "inline" && result.detailTitle != nil ? { detail = result } : nil,
                                         onContentHeight: presentation == "inline" ? { heights[result.id] = $0 } : nil)
    }
}
