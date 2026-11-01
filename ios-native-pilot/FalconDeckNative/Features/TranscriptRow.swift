import SwiftUI

/// Transcript activity rows own their disclosure rather than using SwiftUI's.
/// The whole header is one target with a leading chevron, matching the Mac
/// client, and collapsed content is never built.
struct TranscriptDisclosure<Label: View, Content: View>: View {
    @Environment(\.nativeMotion) private var motion
    @Binding var expanded: Bool
    var minHeight: CGFloat = 32
    @ViewBuilder var label: Label
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(motion.interactionAnimation) { expanded.toggle() }
            } label: {
                HStack(alignment: .center, spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(FD.muted)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .frame(width: 10)
                    label
                    Spacer(minLength: 0)
                }
                .frame(minHeight: minHeight)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint(expanded ? "Collapses this activity" : "Expands this activity")
            if expanded { content.transition(.opacity) }
        }
    }
}

struct TranscriptRow: View {
    @Environment(AppModel.self) private var model
    let message: Message
    var task: AgentTask? = nil
    var preferences = ConversationPreferences(raw: .null)
    var firstDiff = false
    var showsActions = true
    var grouped = false
    var expansion: TranscriptExpansion? = nil
    var onInteraction: () -> Void = {}
    @State private var expanded = false
    @State private var longMessageExpanded = false
    @State private var userToggled = false
    @State private var fullOutput: String?
    @State private var loadingOutput = false
    @State private var showOutput = false
    @State private var textSelection: MessageTextSelection?
    private var open: Binding<Bool> { Binding(get: { userToggled ? expanded : preferences.opens(message, firstDiff: firstDiff) }, set: { onInteraction(); userToggled = true; expanded = $0 }) }
    private var failed: Bool { message.raw["status"].string == "failed" || message.raw["display"]["is_error"].bool }
    var body: some View {
        Group {
            switch message.kind {
            case "user_message": userMessage
            case "assistant_message", "code_review":
                if message.raw["phase"].string == "commentary" { progressUpdate } else { assistantMessage }
            case "image": MediaImageView(reference: message.raw["image"], itemID: message.id, task: task, lifecycle: message.raw["lifecycle"].string)
            case "web_search": webSearch
            case "artifact": artifact
            case "context_compaction":
                activityLabel(message.raw["lifecycle"].string == "running" ? "Compacting context…" : "Context compacted", symbol: "arrow.down.right.and.arrow.up.left")
            case "realtime":
                card(message.raw["title"].string.nonempty ?? "Realtime activity", symbol: "waveform") {
                    NativeCodeBlock(content: (try? message.raw["payload"].wireText()) ?? "", language: "json")
                }
            case "unsupported": unsupported
            case "reasoning": reasoning
            case "tool_call": tool
            case "plan": plan
            case "diff":
                card("Changes", symbol: "plus.forwardslash.minus") { NativeCodeBlock(content: message.text, language: "diff") }
            case "file_change": fileChanges
            case "service": service
            case "interactive_request":
                if message.raw["resolved"].bool {
                    activityLabel(message.raw["resolution"]["label"].string.nonempty ?? "Request resolved", symbol: "checkmark.circle")
                }
            default: unsupported
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
        .simultaneousGesture(TapGesture().onEnded { onInteraction() })
        // A native List creates rows lazily and recreates them after navigation.
        .onChange(of: expansion, initial: true) { _, directive in if let directive { userToggled = true; expanded = directive.expanded } }
        .sheet(item: $textSelection) { selection in MessageTextSheet(text: selection.text) }
        .fullScreenCover(isPresented: $showOutput) { if let fullOutput { TextDocumentView(title: message.raw["title"].string.nonempty ?? "Tool output", text: fullOutput) } }
    }

    // MARK: Messages

    private var userMessage: some View {
        let long = preferences.flag("collapse_long_user_messages") && Self.isLong(message.text)
        return VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 0) {
                Spacer(minLength: 36)
                VStack(alignment: .leading, spacing: 8) {
                    if message.raw["automated"].bool {
                        Label("Scheduled task", systemImage: "calendar").font(.caption.weight(.medium)).foregroundStyle(FD.secondary)
                    }
                    ForEach(message.raw["attachments"].array, id: \.self) { reference in MediaImageView(reference: reference, itemID: message.id, task: task) }
                    if !message.text.isEmpty {
                        Text(message.text).font(.body).foregroundStyle(FD.foreground).lineSpacing(3)
                            .lineLimit(long && !longMessageExpanded ? 12 : nil).textSelection(.enabled)
                    }
                    if long {
                        Button(longMessageExpanded ? "Show less" : "Show more") { onInteraction(); longMessageExpanded.toggle() }
                            .font(.footnote.weight(.medium)).foregroundStyle(FD.accent)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(FD.raised, in: .rect(cornerRadius: 18, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(FD.hairline) }
                .contextMenu { MessageMenu(message: message, task: task) { textSelection = MessageTextSelection(text: message.text) } }
            }
            if message.raw["pending"].bool {
                Text("Sending…").font(.caption2).foregroundStyle(FD.muted)
            } else if let date = ConversationActivity.date(message.raw["created_at"].string) {
                Text(date, style: .time).font(.caption2).foregroundStyle(FD.muted).padding(.trailing, 4)
            }
        }
    }

    /// No avatar and no repeated provider name: text outside a bubble is the agent's.
    private var assistantMessage: some View {
        VStack(alignment: .leading, spacing: 8) {
            if message.kind == "code_review" {
                Label("Code review", systemImage: "checkmark.shield").font(.footnote.weight(.semibold)).foregroundStyle(FD.secondary)
            }
            if !message.raw["subject"].string.isEmpty {
                Text(message.raw["subject"].string).font(.footnote.weight(.medium)).foregroundStyle(FD.muted)
            }
            ForEach(message.raw["attachments"].array, id: \.self) { reference in MediaImageView(reference: reference, itemID: message.id, task: task) }
            NativeMarkdown(text: message.text, streaming: message.streaming)
            AssistantSources(message: message)
            if message.raw["lifecycle"].string == "interrupted" {
                Label("Response interrupted", systemImage: "stop.circle").font(.footnote).foregroundStyle(FD.muted)
            }
            if showsActions, !message.streaming, !message.text.isEmpty { ResponseActions(message: message) }
        }
        .padding(.vertical, 2)
        .contextMenu { MessageMenu(message: message, task: task) { textSelection = MessageTextSelection(text: message.text) } }
    }

    private var progressUpdate: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Text("Progress update").font(.caption.weight(.medium))
                if message.streaming { ActivityDiamond(size: 6) }
            }.foregroundStyle(FD.muted)
            NativeMarkdown(text: message.text, streaming: message.streaming, font: .subheadline, foreground: FD.secondary)
            AssistantSources(message: message)
        }
        .padding(.leading, 12)
        .overlay(alignment: .leading) { FD.line.frame(width: 2).clipShape(.capsule) }
        .contextMenu { MessageMenu(message: message, task: task) { textSelection = MessageTextSelection(text: message.text) } }
    }

    private static func isLong(_ text: String) -> Bool {
        guard text.utf8.count > 600 else { return false }
        if text.count > 900 { return true }
        var lines = 0
        for byte in text.utf8 where byte == 10 { lines += 1; if lines > 12 { return true } }
        return false
    }

    // MARK: Activity

    private var reasoning: some View {
        let body = ConversationActivity.reasoningBody(message)
        return Group {
            if body.isEmpty { reasoningLabel.frame(minHeight: 32) }
            else {
                TranscriptDisclosure(expanded: open) { reasoningLabel } content: {
                    NativeMarkdown(text: body, streaming: message.streaming, font: .subheadline, foreground: FD.secondary)
                        .padding(.leading, 12).padding(.vertical, 6)
                        .overlay(alignment: .leading) { FD.line.frame(width: 2).clipShape(.capsule) }
                        .padding(.leading, 4)
                }
                if preferences.thinking == "preview", !open.wrappedValue {
                    Text(body).font(.caption).foregroundStyle(FD.secondary).lineLimit(2).padding(.leading, 18)
                }
            }
        }
    }

    private var reasoningLabel: some View {
        HStack(spacing: 7) {
            if message.streaming { ActivityDiamond(size: 7) }
            else if message.raw["lifecycle"].string == "error" { Image(systemName: "exclamationmark.circle").foregroundStyle(FD.danger) }
            else if message.raw["lifecycle"].string == "interrupted" { Image(systemName: "pause.circle") }
            NativeActivityText(text: ConversationActivity.reasoningLabel(message), active: message.streaming).lineLimit(2)
            // Live elapsed time is system-driven; settled thoughts show when they ran.
            if let date = ConversationActivity.date(message.raw["created_at"].string) {
                if message.streaming {
                    Text(date, style: .timer).monospacedDigit().foregroundStyle(FD.muted)
                } else if ConversationActivity.notableDuration(message.raw["duration_ms"]) == nil {
                    Text(date, style: .time).foregroundStyle(FD.muted)
                }
            }
        }.font(.footnote).foregroundStyle(FD.secondary)
    }

    private var tool: some View {
        TranscriptDisclosure(expanded: open, minHeight: grouped ? 30 : 24) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if message.running { ActivityDiamond(size: 7) }
                else { Image(systemName: failed ? "exclamationmark.circle" : "checkmark").font(.caption2.weight(.semibold)).foregroundStyle(failed ? FD.danger : FD.muted) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(message.raw["title"].string.nonempty ?? message.raw["detail"]["tool"].string.nonempty ?? "Tool activity")
                        .font(.footnote.monospaced()).foregroundStyle(FD.secondary).lineLimit(2)
                    if !message.raw["display"]["summary_hint"].string.isEmpty {
                        Text(message.raw["display"]["summary_hint"].string).font(.caption).foregroundStyle(FD.muted).lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                if let duration = ConversationActivity.notableDuration(message.raw["detail"]["duration_ms"]) {
                    Text(duration).font(.caption.monospaced()).foregroundStyle(FD.muted)
                }
                if case .number(let exit) = message.raw["exit_code"], exit != 0 {
                    Text("exit \(Int(exit))").font(.caption.monospaced()).foregroundStyle(FD.danger)
                }
            }
        } content: {
            VStack(alignment: .leading, spacing: 10) {
                if !message.text.isEmpty { NativeCodeBlock(content: String(message.text.prefix(16000)), language: "output") }
                else { Text(message.running ? "Waiting for output…" : "No output recorded.").font(.footnote).foregroundStyle(FD.secondary) }
                testSummary
                if let task, message.raw["display"]["output_total_bytes"] != .null || message.text.utf8.count > 16000 {
                    Button(loadingOutput ? "Loading output…" : "Open full output") {
                        loadingOutput = true
                        Task {
                            defer { loadingOutput = false }
                            do { let full = try await model.fullItem(task, itemID: message.id); fullOutput = full["output"].string; showOutput = true }
                            catch { model.chat(for: task).error = error.localizedDescription }
                        }
                    }.font(.footnote.weight(.medium)).foregroundStyle(FD.accent).disabled(loadingOutput)
                }
            }.padding(.top, 8)
        }
        .padding(.horizontal, grouped ? 0 : 12).padding(.vertical, grouped ? 0 : 8)
        .background(grouped ? Color.clear : failed ? FD.danger.opacity(0.05) : FD.surface, in: .rect(cornerRadius: 12, style: .continuous))
        .overlay { if !grouped { RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(failed ? FD.danger.opacity(0.3) : FD.hairline) } }
    }

    @ViewBuilder private var testSummary: some View {
        let tests = message.raw["display"]["test_summary"]
        if tests != .null {
            HStack(spacing: 12) {
                if tests["passed"] != .null { Label("\(tests["passed"].int) passed", systemImage: "checkmark.circle").foregroundStyle(FD.success) }
                if tests["failed"] != .null { Label("\(tests["failed"].int) failed", systemImage: "xmark.circle").foregroundStyle(tests["failed"].int > 0 ? FD.danger : FD.muted) }
                if tests["skipped"] != .null { Text("\(tests["skipped"].int) skipped").foregroundStyle(FD.muted) }
            }.font(.footnote)
        }
    }

    private var plan: some View {
        let steps = message.raw["plan"]["steps"].array
        let done = steps.filter { $0["status"].string == "completed" }.count
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "checklist").foregroundStyle(FD.accent)
                Text("Plan").font(.subheadline.weight(.semibold)).foregroundStyle(FD.foreground)
                Spacer()
                if !steps.isEmpty { Text("\(done) of \(steps.count)").font(.caption.monospacedDigit()).foregroundStyle(FD.muted) }
            }
            if !message.raw["plan"]["explanation"].string.isEmpty {
                NativeMarkdown(text: message.raw["plan"]["explanation"].string, font: .subheadline, foreground: FD.secondary)
            }
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                let status = step["status"].string
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: status == "completed" ? "checkmark.circle.fill" : status == "in_progress" ? "circle.dotted.circle" : "circle")
                        .foregroundStyle(status == "completed" ? FD.accent : status == "in_progress" ? FD.foreground : FD.muted)
                    Text(step["step"].string)
                        .foregroundStyle(status == "completed" ? FD.muted : FD.foreground)
                        .strikethrough(status == "completed", color: FD.muted)
                        .fontWeight(status == "in_progress" ? .medium : .regular)
                        .textSelection(.enabled)
                }.font(.subheadline)
            }
        }
        .padding(14)
        .background(FD.surface, in: .rect(cornerRadius: 14, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(FD.hairline) }
    }

    private var fileChanges: some View {
        let changes = message.raw["changes"].array
        return card("\(changes.count) changed \(changes.count == 1 ? "file" : "files")", symbol: "doc.badge.gearshape") {
            ForEach(Array(changes.enumerated()), id: \.offset) { _, change in
                let kind = change["change_kind"].string
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: kind == "delete" ? "minus.circle" : kind == "add" ? "plus.circle" : "pencil.circle")
                            .foregroundStyle(kind == "delete" ? FD.danger : FD.accent)
                        Text(change["path"].string).foregroundStyle(FD.secondary).textSelection(.enabled).lineLimit(2).truncationMode(.middle)
                    }.font(.footnote.monospaced())
                    if !change["diff"].string.isEmpty { NativeCodeBlock(content: change["diff"].string, language: "diff") }
                }
            }
        }
    }

    private var service: some View {
        let level = message.raw["level"].string
        let color = ["error", "fatal"].contains(level) ? FD.danger : ["warning", "warn"].contains(level) ? FD.warning : FD.secondary
        return Label(message.text, systemImage: ["error", "fatal"].contains(level) ? "exclamationmark.circle" : "info.circle")
            .font(.footnote).foregroundStyle(color).textSelection(.enabled)
    }

    private func activityLabel(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol).font(.footnote).foregroundStyle(FD.secondary).frame(minHeight: 28)
    }

    private func card<Content: View>(_ title: String, symbol: String, @ViewBuilder content: @escaping () -> Content) -> some View {
        TranscriptDisclosure(expanded: open) {
            Label(title, systemImage: symbol).font(.footnote).foregroundStyle(FD.secondary).lineLimit(2)
        } content: {
            VStack(alignment: .leading, spacing: 10, content: content).padding(.top, 8)
        }
    }
}

extension TranscriptRow {
    private var webSearch: some View {
        card(message.raw["search"]["query"].string.nonempty ?? "Web search", symbol: "globe") {
            ForEach(message.raw["search"]["queries"].array, id: \.self) {
                Label($0.string, systemImage: "magnifyingglass").font(.footnote).foregroundStyle(FD.secondary).textSelection(.enabled)
            }
            if let url = MediaURL.external(message.raw["search"]["url"].string) { Link(url.absoluteString, destination: url).font(.footnote) }
        }
    }
    private var artifact: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(message.raw["artifact"]["title"].string.nonempty ?? "Artifact", systemImage: "doc.richtext").font(.subheadline.weight(.medium)).foregroundStyle(FD.secondary)
            let content = message.raw["artifact"]["content"].string
            if !content.isEmpty {
                if message.raw["artifact"]["mime_type"].string.contains("markdown") { NativeMarkdown(text: content, streaming: message.streaming) }
                else { NativeCodeBlock(content: content, language: message.raw["artifact"]["mime_type"].string) }
                ShareLink(item: content) { Label("Share artifact", systemImage: "square.and.arrow.up").font(.footnote) }
            }
            if let url = MediaURL.external(message.raw["artifact"]["url"].string) { Link("Open artifact", destination: url).font(.footnote) }
        }.padding(14).background(FD.surface, in: .rect(cornerRadius: 14, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(FD.hairline) }
    }
    private var unsupported: some View {
        card(message.raw["output_kind"].string.nonempty ?? message.kind.replacingOccurrences(of: "_", with: " ").capitalized, symbol: "doc.questionmark") {
            Text(message.raw["reason"].string.nonempty ?? "This provider returned an item that this client cannot display yet.").font(.footnote).foregroundStyle(FD.secondary)
            NativeCodeBlock(content: (try? message.raw.wireText()) ?? "", language: "json")
        }
    }
}

/// Read-aloud and voice state change often. Only the reply's own controls
/// observe them, so dictation does not re-render the whole transcript.
private struct ResponseActions: View {
    @Environment(AppModel.self) private var model
    let message: Message
    @State private var copied = false
    var body: some View {
        let reading = model.readAloud.messageID == message.id
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 0) {
                button(copied ? "Copied" : "Copy response", symbol: copied ? "checkmark" : "doc.on.doc") {
                    UIPasteboard.general.string = message.text; copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                }
                .sensoryFeedback(.success, trigger: copied) { _, now in now }
                Button {
                    Task { await model.readAloud.play(message.text, id: message.id, model: model) }
                } label: {
                    Group {
                        if reading, model.readAloud.loading { ActivityDiamond(size: 7) }
                        else { Image(systemName: reading ? "stop.fill" : "speaker.wave.2") }
                    }.frame(width: 40, height: 40).contentShape(.rect)
                }
                .accessibilityLabel(reading ? "Stop read aloud" : "Read aloud")
                .disabled(model.voice.starting || model.voice.recording || model.voice.transcribing)
                if reading, !model.readAloud.loading {
                    button(model.readAloud.paused ? "Resume read aloud" : "Pause read aloud", symbol: model.readAloud.paused ? "play.fill" : "pause.fill") { model.readAloud.togglePause() }
                }
                Spacer(minLength: 8)
                if let date = ConversationActivity.date(message.raw["created_at"].string) {
                    Text(date, style: .time).font(.caption2).foregroundStyle(FD.muted)
                }
            }
            .font(.footnote).foregroundStyle(FD.muted).buttonStyle(.plain).padding(.leading, -11)
            if model.readAloud.errorMessageID == message.id, let error = model.readAloud.error {
                Text(error).font(.caption).foregroundStyle(FD.danger).accessibilityIdentifier("read-aloud-error-\(message.id)")
            }
        }
    }
    private func button(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).frame(width: 40, height: 40).contentShape(.rect) }.accessibilityLabel(title)
    }
}

private struct MessageMenu: View {
    @Environment(AppModel.self) private var model
    let message: Message
    let task: AgentTask?
    let selectText: () -> Void
    var body: some View {
        if message.kind == "user_message", !message.raw["pending"].bool, let task, !task.archived {
            let blocked = model.chat(for: task).sending || (!model.demo && !model.connected)
            Button("Edit in a new branch", systemImage: "pencil") { branch(task, retry: false) }.disabled(blocked)
            Button("Retry in a new branch", systemImage: "arrow.clockwise") { branch(task, retry: true) }.disabled(blocked)
        }
        Button { UIPasteboard.general.string = message.text } label: { Label("Copy message", systemImage: "doc.on.doc") }
        if !message.text.isEmpty {
            Button("Select Text", systemImage: "text.cursor", action: selectText)
        }
        if message.kind != "user_message", !message.text.isEmpty {
            Button("Read aloud", systemImage: "speaker.wave.2") { Task { await model.readAloud.play(message.text, id: message.id, model: model) } }
                .disabled(model.voice.starting || model.voice.recording || model.voice.transcribing)
        }
        ShareLink(item: message.text) { Label("Share message", systemImage: "square.and.arrow.up") }
    }
    private func branch(_ task: AgentTask, retry: Bool) {
        Task { do { try await model.branch(task, message: message, retry: retry) } catch { model.chat(for: task).error = error.localizedDescription } }
    }
}
