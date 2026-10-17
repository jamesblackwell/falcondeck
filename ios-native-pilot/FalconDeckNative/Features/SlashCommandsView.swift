import SwiftUI

struct SlashCommandsView: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    @Bindable var chat: ChatSession
    var openGoal: () -> Void
    @State private var showAll = false
    private var query: String? {
        let text = chat.draft
        guard let start = text.range(of: #"(?:^|\s)/[A-Za-z0-9_-]*$"#, options: .regularExpression) else { return nil }
        return String(text[start].trimmingCharacters(in: .whitespacesAndNewlines).dropFirst()).lowercased()
    }
    var body: some View {
        let catalog = model.catalog(task)
        if let query {
            ScrollView { VStack(alignment: .leading, spacing: 0) {
                if catalog.loading { ProgressView().padding(8) }
                if let error = catalog.error { Button("Retry loading shortcuts") { Task { await model.loadCatalog(task, force: true) } }.font(.caption).help(error) }
                if !task.isDraft, "goal".hasPrefix(query) { command("Goal", detail: "Set an objective", icon: "target") { openGoal() } }
                if !task.isDraft, "compact".hasPrefix(query) { command("Compact context", detail: "/compact", icon: "arrow.down.right.and.arrow.up.left") { replace("/compact ") } }
                ForEach(Array(catalog.prompts.filter { matches($0, query) }.prefix(showAll ? 100 : 5)), id: \.self) { prompt in
                    command(prompt["label"].string, detail: prompt["alias"].string, icon: "text.append") { replace(prompt["body"].string.replacingOccurrences(of: "$ARGUMENTS", with: "")) }
                }
                ForEach(Array(catalog.skills.filter { matches($0, query) }.prefix(showAll ? 100 : 5)), id: \.self) { skill in
                    command(skill["label"].string, detail: skill["alias"].string, icon: "sparkles") { replace(ComposerCatalog.alias(skill["alias"].string) + " ") }
                }
                if catalog.skills.count + catalog.prompts.count > 10 && !showAll { Button("Show all shortcuts") { showAll = true }.font(.caption).padding(8) }
            } }.frame(maxHeight: 200)
        }
    }
    private func matches(_ row: JSON, _ query: String) -> Bool { query.isEmpty || ComposerCatalog.alias(row["alias"].string).dropFirst().hasPrefix(query) || row["label"].string.localizedCaseInsensitiveContains(query) }
    private func command(_ title: String, detail: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) { Image(systemName: icon); Text(title).lineLimit(1); Spacer(); Text(detail).font(.caption).foregroundStyle(FD.secondary).lineLimit(1) }.font(.subheadline).padding(.vertical, 8)
        }.buttonStyle(.plain)
    }
    private func replace(_ value: String) {
        guard let range = chat.draft.range(of: #"/[A-Za-z0-9_-]*$"#, options: .regularExpression) else { return }
        chat.draft.replaceSubrange(range, with: value)
    }
}
