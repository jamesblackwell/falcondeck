import SwiftUI

struct TranscriptGroup: View {
    let block: TranscriptBlock
    let task: AgentTask
    var preferences = ConversationPreferences(raw: .null)
    var expansion: TranscriptExpansion?
    var onInteraction: () -> Void = {}
    @State private var expanded = false
    var body: some View {
        let count = block.items.filter { $0.kind == "tool_call" }.count
        let failures = block.items.filter { $0.raw["status"].string == "failed" || $0.raw["display"]["is_error"].bool }.count
        TranscriptDisclosure(expanded: Binding(get: { expanded }, set: { onInteraction(); expanded = $0 }), minHeight: 36) {
            HStack(spacing: 8) {
                if block.running { ActivityDiamond(size: 7) }
                NativeActivityText(text: block.running ? "Working…" : "Worked · \(count) \(count == 1 ? "activity" : "activities")", active: block.running)
                    .foregroundStyle(FD.secondary)
                if failures > 0, !block.running {
                    Label("\(failures) failed", systemImage: "exclamationmark.circle").labelStyle(.titleAndIcon).foregroundStyle(FD.danger)
                }
            }.font(.footnote)
        } content: {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(block.items) { TranscriptRow(message: $0, task: task, preferences: preferences, grouped: true, expansion: expansion, onInteraction: onInteraction) }
            }
            .padding(.leading, 10).padding(.top, 4)
            .overlay(alignment: .leading) { FD.hairline.frame(width: 1).padding(.leading, 4) }
        }
        .onChange(of: expansion, initial: true) { _, value in if let value { expanded = value.expanded } }
    }
}
