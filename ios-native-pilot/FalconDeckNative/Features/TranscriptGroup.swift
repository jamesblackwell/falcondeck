import SwiftUI

struct TranscriptGroup: View {
    let block: TranscriptBlock
    let task: AgentTask
    var expansion: TranscriptExpansion?
    @State private var expanded = false
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(block.items) { TranscriptRow(message: $0, task: task, expansion: expansion) }
            }.padding(.top, 10)
        } label: {
            HStack(spacing: 9) {
                if block.running { ActivityDiamond() } else { Image(systemName: "checkmark") }
                let count = block.items.filter { $0.kind == "tool_call" }.count
                VStack(alignment: .leading, spacing: 4) {
                    Text(block.running ? "Working · \(count) activities" : "Worked · \(count) activities").font(.footnote.weight(.medium))
                    Text(block.items.last(where: { $0.kind == "tool_call" })?.raw["title"].string ?? "").font(.caption).lineLimit(1)
                }
            }.foregroundStyle(FD.secondary)
        }.padding(12).background(FD.surface, in: .rect(cornerRadius: 12))
            .onChange(of: expansion) { _, value in if let value { expanded = value.expanded } }
    }
}
