import SwiftUI

struct TranscriptGroup: View {
    let block: TranscriptBlock
    let task: AgentTask
    var expansion: TranscriptExpansion?
    var onInteraction: () -> Void = {}
    @State private var expanded = false
    var body: some View {
        DisclosureGroup(isExpanded: Binding(get: { expanded }, set: { onInteraction(); expanded = $0 })) {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(block.items) { TranscriptRow(message: $0, task: task, expansion: expansion, onInteraction: onInteraction) }
            }.padding(.top, 10)
        } label: {
            HStack(spacing: 8) {
                if block.running { ActivityDiamond() }
                let count = block.items.filter { $0.kind == "tool_call" }.count
                Text(block.running ? "Working…" : "Worked · \(count) \(count == 1 ? "activity" : "activities")")
                    .font(.caption).foregroundStyle(FD.secondary)
            }.frame(minHeight: 36, alignment: .leading)
        }.tint(FD.secondary)
            .onChange(of: expansion, initial: true) { _, value in if let value { expanded = value.expanded } }
    }
}
