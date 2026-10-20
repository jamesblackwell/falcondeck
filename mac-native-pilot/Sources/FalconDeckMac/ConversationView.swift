import SwiftUI

struct ConversationView: View {
    @Bindable var store: AppStore
    @FocusState private var composerFocused: Bool
    @State private var followsLatest = true

    private var canSend: Bool {
        store.isConnected && store.selectedProject != nil && !store.isSending &&
        !store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            conversationHeader

            if let error = store.errorMessage {
                errorBanner(error)
            }

            Group {
                if store.isLoading && store.messages.isEmpty && store.selectedTaskID != nil {
                    VStack(spacing: 12) {
                        MacActivityDiamond(size: 11)
                        Text("Loading conversation…")
                            .font(.system(size: 12))
                            .foregroundStyle(FDTheme.muted)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("conversation-loading")
                } else if store.messages.isEmpty {
                    emptyConversation
                } else {
                    transcript
                }
            }

            InteractiveRequestsView(store: store)
                .padding(.horizontal, 28)

            composer
        }
        .background(FDTheme.background)
        .onChange(of: store.selectedTaskID) { _, _ in
            followsLatest = true
            composerFocused = true
        }
    }

    private var conversationHeader: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(store.selectedTask?.title ?? "New task")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(FDTheme.foreground)
                    .lineLimit(1)
                    .accessibilityIdentifier("conversation-title")
                HStack(spacing: 5) {
                    Image(systemName: "folder")
                    Text(store.selectedProject?.path ?? "Select a project to get started")
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(FDTheme.subtle)
                .help(store.selectedProject?.path ?? "")
            }
            Spacer(minLength: 12)
            if let task = store.selectedTask {
                HStack(spacing: 6) {
                    TaskStatusMark(status: task.status)
                    Text(FDTheme.statusLabel(task.status))
                        .font(.system(size: 11))
                        .foregroundStyle(task.status == "running" ? FDTheme.accent : FDTheme.muted)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(FDTheme.surface, in: .capsule)
                .overlay { Capsule().strokeBorder(FDTheme.hairline) }
            }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 17)
        .frame(minHeight: 72)
        .overlay(alignment: .bottom) { FDTheme.hairline.frame(height: 1) }
    }

    private var emptyConversation: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 23, weight: .light))
                    .foregroundStyle(FDTheme.accent)
                    .frame(width: 52, height: 52)
                    .background(FDTheme.accentDim, in: .rect(cornerRadius: 14))
                    .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(FDTheme.accentMuted) }
                VStack(alignment: .leading, spacing: 9) {
                    Text(store.selectedTaskID == nil ? "What are we working on?" : "The conversation starts here.")
                        .font(.system(size: 25, weight: .semibold))
                        .tracking(-0.7)
                        .foregroundStyle(FDTheme.foreground)
                    Text(store.selectedProject.map { "Your agent is ready in \($0.name). Describe a change, ask a question, or explore the project." } ?? "Choose a project from the sidebar, then start a task.")
                        .font(.system(size: 14))
                        .lineSpacing(5)
                        .foregroundStyle(FDTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if store.selectedProject != nil && store.selectedTaskID == nil {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.turn.down.right")
                        Text("Start with a message below")
                    }
                    .font(.system(size: 11))
                    .foregroundStyle(FDTheme.subtle)
                    .padding(.top, 4)
                }
            }
            .frame(maxWidth: 480, alignment: .leading)
            .padding(.horizontal, 36)
            Spacer()
            Spacer().frame(height: 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var transcript: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 24) {
                        if store.hasOlder {
                            Button {
                                let firstID = store.messages.first?.id
                                followsLatest = false
                                Task {
                                    await store.loadOlder()
                                    if let firstID { proxy.scrollTo(firstID, anchor: .top) }
                                }
                            } label: {
                                HStack(spacing: 8) {
                                    if store.isLoadingOlder { MacActivityDiamond(size: 6) }
                                    else { Image(systemName: "arrow.up") }
                                    Text(store.isLoadingOlder ? "Loading earlier messages…" : "Load earlier messages")
                                }
                                .font(.system(size: 11))
                                .foregroundStyle(FDTheme.muted)
                                .frame(maxWidth: .infinity)
                                .padding(10)
                            }
                            .buttonStyle(.plain)
                            .disabled(store.isLoadingOlder)
                            .accessibilityIdentifier("load-earlier-messages")
                        }
                        ForEach(store.messages) { message in
                            MacTranscriptRow(message: message, provider: store.selectedTask?.provider ?? store.provider)
                                .equatable()
                                .id(message.id)
                        }
                        if store.isRunning {
                            HStack(spacing: 8) {
                                MacActivityDiamond(size: 7)
                                Text("\(FDTheme.providerName(store.selectedTask?.provider ?? store.provider)) is working")
                                    .font(.system(size: 11))
                                    .foregroundStyle(FDTheme.muted)
                            }
                            .padding(.leading, 35)
                            .accessibilityIdentifier("agent-working")
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("transcript-bottom")
                            .background {
                                GeometryReader { geometry in
                                    Color.clear.preference(
                                        key: TranscriptBottomPosition.self,
                                        value: geometry.frame(in: .named("transcript-scroll")).maxY
                                    )
                                }
                            }
                    }
                    .frame(maxWidth: 840, alignment: .leading)
                    .padding(.horizontal, 32)
                    .padding(.top, 28)
                    .padding(.bottom, 20)
                    .frame(maxWidth: .infinity)
                }
                .coordinateSpace(name: "transcript-scroll")
                .onPreferenceChange(TranscriptBottomPosition.self) { bottom in
                    followsLatest = bottom <= viewport.size.height + 100
                }
                .onAppear { proxy.scrollTo("transcript-bottom", anchor: .bottom) }
                .onChange(of: store.messages.last?.text) { _, _ in
                    if followsLatest { proxy.scrollTo("transcript-bottom", anchor: .bottom) }
                }
                .onChange(of: store.messages.count) { _, _ in
                    if followsLatest { proxy.scrollTo("transcript-bottom", anchor: .bottom) }
                }
                .overlay(alignment: .bottom) {
                    if !followsLatest {
                        Button {
                            followsLatest = true
                            proxy.scrollTo("transcript-bottom", anchor: .bottom)
                        } label: {
                            Label("Jump to latest", systemImage: "arrow.down")
                                .font(.system(size: 11, weight: .medium))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(FDTheme.secondary)
                        .background(FDTheme.raised, in: .capsule)
                        .overlay { Capsule().strokeBorder(FDTheme.line) }
                        .padding(.bottom, 10)
                    }
                }
                .accessibilityIdentifier("conversation-transcript")
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 0) {
                ZStack(alignment: .topLeading) {
                    if store.draft.isEmpty {
                        Text(store.isRunning ? "Send a follow-up…" : "Message your agent…")
                            .foregroundStyle(FDTheme.subtle)
                            .padding(.top, 14)
                            .padding(.leading, 16)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text: $store.draft)
                        .font(.system(size: 14))
                        .foregroundStyle(FDTheme.foreground)
                        .scrollContentBackground(.hidden)
                        .padding(.horizontal, 11)
                        .padding(.top, 8)
                        .frame(minHeight: 76, maxHeight: 120)
                        .focused($composerFocused)
                        .accessibilityLabel("Message your agent")
                        .accessibilityIdentifier("message-composer")
                }
                HStack(spacing: 10) {
                    if store.selectedTaskID == nil {
                        Picker("Agent", selection: $store.provider) {
                            ForEach(store.availableProviders, id: \.self) { provider in
                                Text(FDTheme.providerName(provider)).tag(provider)
                            }
                        }
                        .pickerStyle(.menu)
                        .controlSize(.small)
                        .fixedSize()
                        .accessibilityIdentifier("agent-picker")
                    } else {
                        HStack(spacing: 6) {
                            Image(systemName: "terminal")
                            Text(FDTheme.providerName(store.selectedTask?.provider ?? store.provider))
                        }
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(FDTheme.muted)
                    }
                    Spacer()
                    if store.isRunning {
                        Button {
                            Task { await store.interrupt() }
                        } label: {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 10))
                                .frame(width: 28, height: 28)
                                .background(FDTheme.hover, in: .rect(cornerRadius: 7))
                        }
                        .buttonStyle(.plain)
                        .help("Stop the current turn")
                        .accessibilityLabel("Stop agent")
                        .accessibilityIdentifier("stop-agent")
                    }
                    Button {
                        send()
                    } label: {
                        Group {
                            if store.isSending { ProgressView().controlSize(.small).tint(FDTheme.background) }
                            else { Image(systemName: "arrow.up").font(.system(size: 14, weight: .semibold)) }
                        }
                        .frame(width: 30, height: 28)
                        .foregroundStyle(canSend ? FDTheme.background : FDTheme.subtle)
                        .background(canSend ? FDTheme.accent : FDTheme.hover, in: .rect(cornerRadius: 7))
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSend)
                    .help("Send message (⌘Return)")
                    .accessibilityLabel("Send message")
                    .accessibilityIdentifier("send-message")
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
                .padding(.top, 4)
            }
            .background(FDTheme.raised, in: .rect(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(composerFocused ? FDTheme.accent.opacity(0.45) : FDTheme.line) }

            HStack(spacing: 4) {
                if !store.isConnected {
                    Image(systemName: "wifi.slash")
                    Text("Reconnect to send a message")
                } else {
                    Text("⌘ Return to send")
                    Text("·").padding(.horizontal, 2)
                    Text("Return for a new line")
                }
            }
            .font(.system(size: 10))
            .foregroundStyle(FDTheme.subtle)
        }
        .frame(maxWidth: 840)
        .padding(.horizontal, 28)
        .padding(.top, 12)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity)
    }

    private func send() {
        guard canSend else { return }
        followsLatest = true
        Task { await store.send() }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(FDTheme.warning)
            Text(message)
                .font(.system(size: 12))
                .foregroundStyle(FDTheme.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Retry") { Task { await store.reconnect() } }
                .buttonStyle(.borderless)
                .font(.system(size: 11, weight: .medium))
            Button { store.errorMessage = nil } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain)
                .font(.system(size: 10))
                .foregroundStyle(FDTheme.muted)
                .accessibilityLabel("Dismiss error")
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 12)
        .background(FDTheme.warning.opacity(0.07))
        .overlay(alignment: .bottom) { FDTheme.hairline.frame(height: 1) }
    }
}

private struct TranscriptBottomPosition: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct MacTranscriptRow: View, Equatable {
    let message: Message
    let provider: String
    @State private var expanded = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.message == rhs.message && lhs.provider == rhs.provider
    }

    var body: some View {
        Group {
            switch message.kind {
            case "user_message": userMessage
            case "assistant_message", "code_review": assistantMessage
            case "tool_call": toolActivity
            case "reasoning": reasoning
            case "diff": detailCard("Changes", symbol: "plus.forwardslash.minus") { MacCodeBlock(text: message.text, language: "diff") }
            case "file_change": fileChanges
            case "plan": plan
            case "interactive_request":
                if message.raw["resolved"].bool {
                    Label("Request resolved", systemImage: "checkmark.circle")
                        .font(.system(size: 11))
                        .foregroundStyle(FDTheme.muted)
                        .padding(.leading, 35)
                }
            case "context_compaction":
                Label("Context compacted", systemImage: "arrow.down.right.and.arrow.up.left")
                    .font(.system(size: 11))
                    .foregroundStyle(FDTheme.subtle)
                    .padding(.leading, 35)
            case "service":
                Text(message.text)
                    .font(.system(size: 12))
                    .foregroundStyle(FDTheme.muted)
                    .textSelection(.enabled)
                    .padding(.leading, 35)
            default: fallback
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var userMessage: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .leading, spacing: 9) {
                Text("YOU")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .tracking(1)
                    .foregroundStyle(FDTheme.subtle)
                Text(message.text)
                    .font(.system(size: 14))
                    .lineSpacing(5)
                    .foregroundStyle(FDTheme.foreground)
                    .textSelection(.enabled)
            }
            .padding(16)
            .frame(maxWidth: 640, alignment: .leading)
            .background(FDTheme.raised, in: .rect(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(FDTheme.hairline) }
        }
        .contextMenu { Button("Copy message") { FDTheme.copy(message.text) } }
    }

    private var assistantMessage: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "terminal")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(FDTheme.accent)
                .frame(width: 23, height: 23)
                .background(FDTheme.accentDim, in: .rect(cornerRadius: 6))
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(FDTheme.providerName(provider))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(FDTheme.secondary)
                    if message.streaming { MacActivityDiamond(size: 6) }
                }
                MacMarkdown(text: message.text)
                if !message.streaming && !message.text.isEmpty {
                    Button { FDTheme.copy(message.text) } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 11))
                            .foregroundStyle(FDTheme.subtle)
                            .frame(width: 24, height: 23)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .help("Copy response")
                    .accessibilityLabel("Copy response")
                    .padding(.leading, -5)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contextMenu { Button("Copy response") { FDTheme.copy(message.text) } }
    }

    private var toolActivity: some View {
        let failed = ["failed", "error"].contains(message.raw["status"].string)
        return DisclosureGroup(isExpanded: $expanded) {
            if !message.text.isEmpty {
                MacCodeBlock(text: message.text, language: "output")
                    .padding(.top, 10)
            } else {
                Text(message.running ? "Waiting for output…" : "No output recorded.")
                    .font(.system(size: 11))
                    .foregroundStyle(FDTheme.subtle)
                    .padding(.top, 8)
            }
        } label: {
            HStack(spacing: 8) {
                if message.running { MacActivityDiamond(size: 7) }
                else {
                    Image(systemName: failed ? "exclamationmark.circle" : "checkmark")
                        .font(.system(size: 10))
                        .foregroundStyle(failed ? FDTheme.danger : FDTheme.subtle)
                }
                Text(message.raw["title"].string.isEmpty ? "Tool activity" : message.raw["title"].string)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(FDTheme.muted)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
        }
        .padding(12)
        .background(FDTheme.surface, in: .rect(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(FDTheme.hairline) }
        .padding(.leading, 35)
    }

    private var reasoning: some View {
        detailCard(message.streaming ? "Thinking…" : "Thought process", symbol: "brain") {
            MacMarkdown(text: message.text)
                .padding(.top, 8)
                .foregroundStyle(FDTheme.muted)
        }
    }

    private var fileChanges: some View {
        detailCard("Changed files", symbol: "doc.badge.gearshape") {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(message.raw["changes"].array.enumerated()), id: \.offset) { _, change in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(change["path"].string)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(FDTheme.secondary)
                            .textSelection(.enabled)
                        if !change["diff"].string.isEmpty { MacCodeBlock(text: change["diff"].string, language: "diff") }
                    }
                }
            }
            .padding(.top, 8)
        }
    }

    private var plan: some View {
        detailCard("Plan", symbol: "checklist") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(message.raw["plan"]["steps"].array.enumerated()), id: \.offset) { _, step in
                    Label(step["step"].string, systemImage: step["status"].string == "completed" ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 12))
                        .foregroundStyle(step["status"].string == "completed" ? FDTheme.accent : FDTheme.secondary)
                }
            }
            .padding(.top, 10)
        }
    }

    private var fallback: some View {
        detailCard(message.raw["title"].string.isEmpty ? message.kind.replacingOccurrences(of: "_", with: " ").capitalized : message.raw["title"].string, symbol: "doc.text") {
            if !message.text.isEmpty { MacMarkdown(text: message.text).padding(.top, 8) }
            else {
                Text("This activity has no text preview.")
                    .font(.system(size: 11))
                    .foregroundStyle(FDTheme.subtle)
                    .padding(.top, 8)
            }
        }
    }

    private func detailCard<Content: View>(_ title: String, symbol: String, @ViewBuilder content: @escaping () -> Content) -> some View {
        DisclosureGroup(isExpanded: $expanded) {
            content()
        } label: {
            Label(title, systemImage: symbol)
                .font(.system(size: 11))
                .foregroundStyle(FDTheme.muted)
        }
        .padding(.leading, 35)
    }
}

/// Native SwiftUI text for prose; fenced code remains horizontally scrollable.
private struct MacMarkdown: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let language, let source):
                    MacCodeBlock(text: source, language: language)
                case .prose(let prose):
                    proseView(prose)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder private func proseView(_ prose: String) -> some View {
        let lines = prose.components(separatedBy: "\n")
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("### ") {
                    inline(String(trimmed.dropFirst(4))).font(.system(size: 15, weight: .semibold)).padding(.top, 5)
                } else if trimmed.hasPrefix("## ") {
                    inline(String(trimmed.dropFirst(3))).font(.system(size: 17, weight: .semibold)).padding(.top, 7)
                } else if trimmed.hasPrefix("# ") {
                    inline(String(trimmed.dropFirst(2))).font(.system(size: 20, weight: .semibold)).padding(.top, 8)
                } else if trimmed == "---" || trimmed == "***" {
                    Rectangle().fill(FDTheme.line).frame(height: 1).padding(.vertical, 5)
                } else if trimmed.hasPrefix("> ") {
                    inline(String(trimmed.dropFirst(2)))
                        .foregroundStyle(FDTheme.muted)
                        .padding(.leading, 12)
                        .overlay(alignment: .leading) { Rectangle().fill(FDTheme.line).frame(width: 2) }
                } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("•").foregroundStyle(FDTheme.muted)
                        inline(String(trimmed.dropFirst(2))).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.leading, 4)
                } else if trimmed.isEmpty {
                    Color.clear.frame(height: 2)
                } else {
                    inline(line)
                }
            }
        }
        .font(.system(size: 14))
        .foregroundStyle(FDTheme.foreground)
        .lineSpacing(5)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func inline(_ source: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return Text((try? AttributedString(markdown: source, options: options)) ?? AttributedString(source))
    }
}

private enum MarkdownBlock {
    case prose(String)
    case code(String, String)

    static func parse(_ text: String) -> [MarkdownBlock] {
        var result: [MarkdownBlock] = []
        var prose: [String] = []
        var code: [String] = []
        var fence: String?
        var language = ""
        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let marker = fence {
                if trimmed.hasPrefix(marker) {
                    result.append(.code(language, code.joined(separator: "\n")))
                    code = []
                    fence = nil
                } else { code.append(line) }
            } else if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                if !prose.isEmpty { result.append(.prose(prose.joined(separator: "\n"))); prose = [] }
                fence = String(trimmed.prefix(3))
                language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else { prose.append(line) }
        }
        if fence != nil { result.append(.code(language, code.joined(separator: "\n"))) }
        if !prose.isEmpty { result.append(.prose(prose.joined(separator: "\n"))) }
        return result
    }
}

private struct MacCodeBlock: View {
    let text: String
    let language: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(FDTheme.subtle)
                Spacer()
                Button { FDTheme.copy(text) } label: {
                    Image(systemName: "doc.on.doc").font(.system(size: 10))
                }
                .buttonStyle(.plain)
                .foregroundStyle(FDTheme.muted)
                .help("Copy code")
                .accessibilityLabel("Copy code")
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 9)
            .overlay(alignment: .bottom) { FDTheme.hairline.frame(height: 1) }
            ScrollView(.horizontal) {
                Text(text)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(FDTheme.secondary)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(13)
            }
        }
        .background(FDTheme.surface, in: .rect(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(FDTheme.line) }
    }
}
