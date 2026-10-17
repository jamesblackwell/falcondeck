import SwiftUI

struct TranscriptRow: View {
    @Environment(AppModel.self) private var model
    let message: Message
    var task: AgentTask? = nil
    @State private var expanded = false
    @State private var userToggled = false
    @State private var fullOutput: String?
    @State private var loadingOutput = false
    @State private var showOutput = false
    var body: some View {
        Group {
            switch message.kind {
            case "user_message", "assistant_message", "code_review": messageBody
            case "image": MediaImageView(reference: message.raw["image"], itemID: message.id, task: task, lifecycle: message.raw["lifecycle"].string)
            case "web_search": webSearch
            case "artifact": artifact
            case "context_compaction": Label("Context compacted", systemImage: "arrow.down.right.and.arrow.up.left").font(.footnote).foregroundStyle(FD.secondary)
            case "realtime":
                DisclosureGroup { NativeCodeBlock(content: (try? message.raw["payload"].wireText()) ?? "", language: "Details") } label: { Label(message.raw["title"].string.nonempty ?? "Realtime activity", systemImage: "waveform").font(.footnote).foregroundStyle(FD.secondary) }
            case "unsupported": unsupported
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
                    ForEach(message.raw["changes"].array, id: \.self) { change in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(change["path"].string).font(.caption.monospaced()).foregroundStyle(FD.secondary)
                            if !change["diff"].string.isEmpty { NativeCodeBlock(content: change["diff"].string, language: "diff") }
                        }
                    }
                } label: { Label("\(message.raw["changes"].array.count) changed files", systemImage: "doc.badge.gearshape").font(.footnote).foregroundStyle(FD.secondary) }
            case "service": Text(message.text).font(.footnote).foregroundStyle(FD.secondary)
            case "interactive_request":
                if message.raw["resolved"].bool { Label(message.raw["resolution"]["label"].string.nonempty ?? "Request resolved", systemImage: "checkmark.circle").font(.footnote).foregroundStyle(FD.secondary) }
            default: unsupported
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: $showOutput) { if let fullOutput { TextDocumentView(title: message.raw["title"].string.nonempty ?? "Tool output", text: fullOutput) } }
    }
    private var messageBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: message.kind == "user_message" ? "person.crop.circle" : "sparkle")
                Text(message.kind == "user_message" ? "You" : "Assistant").fontWeight(.medium)
                Spacer()
                if message.raw["pending"].bool { Text("Sending…").foregroundStyle(FD.muted) }
            }.font(.caption).foregroundStyle(message.kind == "user_message" ? FD.secondary : FD.accent)
            ForEach(message.raw["attachments"].array, id: \.self) { reference in MediaImageView(reference: reference, itemID: message.id, task: task) }
            if message.kind == "user_message" { Text(message.text).font(.body).lineSpacing(4).textSelection(.enabled) }
            else { NativeMarkdown(text: message.text) }
            if message.kind != "user_message", !message.text.isEmpty {
                HStack(spacing: 18) {
                    Button { UIPasteboard.general.string = message.text } label: { Image(systemName: "doc.on.doc") }.accessibilityLabel("Copy response")
                    Button {
                        Task { await model.readAloud.play(message.text, id: message.id, model: model) }
                    } label: {
                        if model.readAloud.messageID == message.id, model.readAloud.loading { ActivityDiamond() }
                        else { Image(systemName: model.readAloud.messageID == message.id ? "stop.fill" : "speaker.wave.2") }
                    }.accessibilityLabel(model.readAloud.messageID == message.id ? "Stop read aloud" : "Read aloud").disabled(model.voice.recording || model.voice.transcribing)
                    if model.readAloud.messageID == message.id, !model.readAloud.loading {
                        Button { model.readAloud.togglePause() } label: { Image(systemName: model.readAloud.paused ? "play.fill" : "pause.fill") }.accessibilityLabel(model.readAloud.paused ? "Resume read aloud" : "Pause read aloud")
                    }
                }.font(.caption).foregroundStyle(FD.secondary).buttonStyle(.plain).padding(.top, 4)
                if let error = model.readAloud.error { Text(error).font(.caption).foregroundStyle(.orange) }
            }
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
            if message.raw["display"]["output_total_bytes"] != .null || message.text.count > 16000 {
                if let task {
                    Button(loadingOutput ? "Loading output…" : "Open full output") {
                        loadingOutput = true
                        Task {
                            defer { loadingOutput = false }
                            do { let full = try await model.fullItem(task, itemID: message.id); fullOutput = full["output"].string; showOutput = true }
                            catch { model.chat(for: task).error = error.localizedDescription }
                        }
                    }.font(.caption).disabled(loadingOutput)
                }
            }
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

extension TranscriptRow {
    private var webSearch: some View {
        DisclosureGroup {
            ForEach(message.raw["search"]["queries"].array, id: \.self) { Text($0.string).font(.footnote) }
            if let url = MediaURL.external(message.raw["search"]["url"].string) { Link(url.absoluteString, destination: url).font(.footnote) }
        } label: { Label(message.raw["search"]["query"].string.nonempty ?? "Web search", systemImage: "globe").font(.footnote).foregroundStyle(FD.secondary) }
    }
    private var artifact: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(message.raw["artifact"]["title"].string.nonempty ?? "Artifact", systemImage: "doc.richtext").font(.subheadline.weight(.medium))
            let content = message.raw["artifact"]["content"].string
            if !content.isEmpty {
                if message.raw["artifact"]["mime_type"].string.contains("markdown") { NativeMarkdown(text: content) }
                else { NativeCodeBlock(content: content, language: message.raw["artifact"]["mime_type"].string) }
                ShareLink(item: content) { Label("Share artifact", systemImage: "square.and.arrow.up").font(.caption) }
            }
            if let url = MediaURL.external(message.raw["artifact"]["url"].string) { Link("Open artifact", destination: url).font(.footnote) }
        }.padding(14).background(FD.surface, in: .rect(cornerRadius: 14))
    }
    private var unsupported: some View {
        DisclosureGroup {
            Text(message.raw["reason"].string.nonempty ?? "This provider returned an item that this client cannot display yet.").font(.footnote).foregroundStyle(FD.secondary)
            NativeCodeBlock(content: (try? message.raw.wireText()) ?? "", language: "Details")
        } label: { Label(message.raw["output_kind"].string.nonempty ?? message.kind, systemImage: "doc.questionmark").font(.footnote).foregroundStyle(FD.secondary) }
    }
}
