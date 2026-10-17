import SwiftUI

struct ConversationStatus: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    @State private var dismissed: Set<String> = []
    private var notices: [JSON] {
        (model.operationalConditions + model.serviceNotices).filter { item in
            item["workspace_id"].string == task.projectID && (item["thread_id"] == .null || item["thread_id"].string == task.id) && item["level"].string != "info" && !dismissed.contains(item["id"].string)
        }
    }
    var body: some View {
        ForEach(Array(notices.suffix(3)), id: \.self) { notice in
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.circle")
                Text(notice["message"].string).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                Button { dismissed.insert(notice["id"].string) } label: { Image(systemName: "xmark") }.accessibilityLabel("Dismiss notice")
            }.font(.footnote).foregroundStyle(.orange).padding(12).background(FD.surface, in: .rect(cornerRadius: 12))
        }
        if model.realtimeAudio.active.contains(task.id) {
            HStack { Label("Playing realtime audio", systemImage: "waveform"); Spacer(); Button("Stop audio") { model.realtimeAudio.stop(task.id) } }.font(.caption).padding(10)
        }
        if let error = model.realtimeAudio.error {
            HStack { Text(error); Spacer(); Button { model.realtimeAudio.error = nil } label: { Image(systemName: "xmark") }.accessibilityLabel("Dismiss audio error") }.font(.footnote).foregroundStyle(.orange)
        }
    }
}

struct AssistantSources: View {
    let message: Message
    var body: some View {
        let citations = message.raw["citations"].array
        if !citations.isEmpty {
            DisclosureGroup("\(citations.count) sources") {
                ForEach(Array(citations.enumerated()), id: \.offset) { index, citation in
                    VStack(alignment: .leading, spacing: 5) {
                        let title = citation["title"].string.nonempty ?? citation["source"].string.nonempty ?? "Source \(index + 1)"
                        if let url = MediaURL.external(citation["url"].string) { Link(title, destination: url).font(.footnote.weight(.medium)) }
                        else { Text(title).font(.footnote.weight(.medium)) }
                        if !citation["cited_text"].string.isEmpty { Text(citation["cited_text"].string).font(.caption).foregroundStyle(FD.secondary).textSelection(.enabled) }
                        if citation["locator"]["kind"].string == "page" { Text("Page \(citation["locator"]["start_page_number"].int)").font(.caption2).foregroundStyle(FD.muted) }
                    }.padding(.vertical, 6)
                }
            }.font(.caption).foregroundStyle(FD.secondary)
        }
        if message.raw["memory_citation"] != .null {
            DisclosureGroup("Memory sources") { NativeCodeBlock(content: (try? message.raw["memory_citation"].wireText()) ?? "", language: "Citations") }.font(.caption).foregroundStyle(FD.secondary)
        }
        if let error = message.raw["error"].string.nonempty { Label(error, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.orange) }
    }
}

struct TaskUsageView: View {
    let usage: JSON
    var body: some View {
        if usage != .null {
            Section("Token usage") {
                LabeledContent("Total", value: usage["total"]["total_tokens"].int.formatted())
                LabeledContent("Input", value: usage["total"]["input_tokens"].int.formatted())
                LabeledContent("Cached input", value: usage["total"]["cached_input_tokens"].int.formatted())
                LabeledContent("Output", value: usage["total"]["output_tokens"].int.formatted())
                if usage["model_context_window"] != .null { LabeledContent("Model context window", value: usage["model_context_window"].int.formatted()) }
            }.listRowBackground(FD.surface)
        }
    }
}
