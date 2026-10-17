import SwiftUI

struct TranscriptRow: View {
    let message: Message
    @State private var expanded = false
    @State private var userToggled = false
    var body: some View {
        Group {
            switch message.kind {
            case "user_message", "assistant_message", "code_review": messageBody
            case "reasoning":
                DisclosureGroup(isExpanded: Binding(get: { userToggled ? expanded : message.streaming }, set: { userToggled = true; expanded = $0 })) {
                    NativeMarkdown(text: message.text).padding(.leading, 12).overlay(alignment: .leading) { Rectangle().fill(FD.line).frame(width: 2) }
                } label: { Label(message.streaming ? "Thinking…" : "Thinking", systemImage: "brain").font(.footnote).foregroundStyle(FD.secondary) }
            case "tool_call": tool
            case "plan":
                DisclosureGroup {
                    ForEach(message.raw["plan"]["steps"].array, id: \.self) { step in
                        Label(step["step"].string, systemImage: step["status"].string == "completed" ? "checkmark.circle.fill" : "circle").font(.subheadline).foregroundStyle(step["status"].string == "completed" ? FD.accent : FD.secondary)
                    }
                } label: { Label("Plan", systemImage: "checklist").font(.footnote).foregroundStyle(FD.secondary) }
            case "diff":
                DisclosureGroup { NativeCodeBlock(content: message.text, language: "diff") } label: { Label("Changes", systemImage: "plus.forwardslash.minus").font(.footnote).foregroundStyle(FD.secondary) }
            case "file_change":
                DisclosureGroup {
                    ForEach(message.raw["changes"].array, id: \.self) { change in Text(change["path"].string).font(.caption.monospaced()).foregroundStyle(FD.secondary) }
                } label: { Label("\(message.raw["changes"].array.count) changed files", systemImage: "doc.badge.gearshape").font(.footnote).foregroundStyle(FD.secondary) }
            case "service": Text(message.text).font(.footnote).foregroundStyle(FD.secondary)
            case "interactive_request":
                if message.raw["resolved"].bool { Label(message.raw["resolution"]["label"].string.nonempty ?? "Request resolved", systemImage: "checkmark.circle").font(.footnote).foregroundStyle(FD.secondary) }
            default: EmptyView()
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var messageBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: message.kind == "user_message" ? "person.crop.circle" : "sparkle")
                Text(message.kind == "user_message" ? "You" : "Assistant").fontWeight(.medium)
                Spacer()
                if message.raw["pending"].bool { Text("Sending…").foregroundStyle(FD.muted) }
            }.font(.caption).foregroundStyle(message.kind == "user_message" ? FD.secondary : FD.accent)
            if message.kind == "user_message" { Text(message.text).font(.body).lineSpacing(4).textSelection(.enabled) }
            else { NativeMarkdown(text: message.text) }
        }
        .padding(message.kind == "user_message" ? 16 : 2)
        .background(message.kind == "user_message" ? FD.raised : .clear, in: .rect(cornerRadius: 16))
        .contextMenu {
            Button { UIPasteboard.general.string = message.text } label: { Label("Copy message", systemImage: "doc.on.doc") }
            ShareLink(item: message.text) { Label("Share message", systemImage: "square.and.arrow.up") }
        }
    }
    private var tool: some View {
        let bordered = ["execute", "edit", "terminal", "command"].contains(message.raw["tool_kind"].string)
        return DisclosureGroup(isExpanded: $expanded) {
            if !message.text.isEmpty { NativeCodeBlock(content: String(message.text.prefix(16000)), language: "Output") }
            else { Text("No output recorded.").font(.footnote).foregroundStyle(FD.secondary) }
        } label: {
            HStack(spacing: 8) {
                if message.raw["status"].string == "running" { ActivityDiamond() }
                else { Image(systemName: message.raw["status"].string == "failed" ? "exclamationmark.circle" : "checkmark").foregroundStyle(FD.secondary) }
                Text(message.raw["title"].string.nonempty ?? "Tool activity").lineLimit(2)
            }.font(.footnote).foregroundStyle(FD.secondary)
        }
        .padding(bordered ? 12 : 2).background(bordered ? FD.surface : .clear, in: .rect(cornerRadius: 12))
        .overlay { if bordered { RoundedRectangle(cornerRadius: 12).strokeBorder(FD.line) } }
    }
}
