import SwiftUI

/// A wire item, rendered with native text and controls. Actions belong to the
/// selected task's owner; rows never mutate transcript history themselves.
struct ConversationTranscriptRow: View {
    @MainActor private static let timestampParser = ISO8601DateFormatter()
    let message: Message
    let provider: String
    var preferences: JSON = .null
    var firstDiff = false
    var activityInset: CGFloat = 35
    /// Positive values expand; negative values collapse. Increment the absolute
    /// value for each command so repeated clicks still override a manual toggle.
    var expansionDirective: Int = 0
    var onQuote: ((String) -> Void)? = nil
    var onEdit: (() -> Void)? = nil
    var onRetry: (() -> Void)? = nil
    var onReadAloud: ((String) -> Void)? = nil
    var onLoadFullOutput: (() async throws -> JSON)? = nil
    var mediaURL: ((JSON) -> URL?)? = nil
    var onOpenFile: ((String, Int?) -> Void)? = nil
    @State private var expansionOverride: Bool?
    @State private var longMessageExpanded = false
    @State private var fullOutput: JSON?
    @State private var loadingOutput = false
    @State private var outputError: String?
    @State private var outputGeneration = 0
    @State private var readOnlyDetailsVisible = false

    private var displayPreferences: JSON {
        TranscriptPresentation.conversationPreferences(preferences)
            .setting("thinking_display", .string(NativePreferences.shared.thinkingDisplay))
    }
    private var open: Binding<Bool> {
        Binding(get: { expansionOverride ?? TranscriptPresentation.defaultExpanded(message, preferences: displayPreferences, firstDiff: firstDiff) },
                set: { expansionOverride = $0 })
    }
    private var raw: JSON { fullOutput ?? message.raw }
    private var failed: Bool { TranscriptPresentation.failure(raw) }
    private var itemText: String { Message(raw).text }

    var body: some View {
        Group {
            switch message.kind {
            case "user_message": userMessage
            case "assistant_message", "code_review":
                if TranscriptPresentation.isProgressUpdate(message) { progressUpdate }
                else { assistantMessage }
            case "reasoning": reasoning
            case "tool_call": toolActivity
            case "plan": plan
            case "diff":
                card("Changes", symbol: "plus.forwardslash.minus") { TranscriptCodeBlock(text: itemText, language: "diff") }
            case "file_change": fileChanges
            case "image":
                TranscriptMediaView(reference: raw["image"], resolvedURL: mediaURL?(raw["image"]), loadReference: imageLoader)
                    .padding(.leading, activityInset)
            case "web_search": webSearch
            case "artifact": artifact
            case "context_compaction":
                activityLabel(raw["lifecycle"].string == "running" ? "Compacting context…" : "Context compacted", symbol: "arrow.down.right.and.arrow.up.left")
            case "interactive_request": requestHistory
            case "service": service
            case "realtime": realtime
            default: unknown
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("transcript-item-\(message.id)")
        .environment(\.transcriptOpenFile, onOpenFile)
        .onChange(of: expansionDirective, initial: true) { _, directive in
            if directive != 0 {
                expansionOverride = directive > 0
                readOnlyDetailsVisible = directive > 0
            }
        }
        .onChange(of: displayPreferences) { _, _ in
            expansionOverride = nil
            readOnlyDetailsVisible = false
        }
        .onChange(of: message.raw) { _, _ in
            // Full output is a disposable preview. An authoritative live update
            // invalidates it, including any older item fetch still in flight.
            outputGeneration += 1
            fullOutput = nil
            loadingOutput = false
            outputError = nil
        }
    }

    private var imageLoader: (() async throws -> JSON)? {
        guard let onLoadFullOutput else { return nil }
        return { TranscriptPresentation.reference(try await onLoadFullOutput(), original: raw["image"]) }
    }

    private var userMessage: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 7) {
                    Text(raw["automated"].bool ? "SCHEDULED TASK" : "YOU")
                        .font(NativePreferences.shared.font(size: 13, surface: "code", weight: .medium)).tracking(1)
                    if raw["pending"].bool { Text("Sending…").font(NativePreferences.shared.font(size: 12, surface: "chat")) }
                    Spacer()
                    timestamp
                }.foregroundStyle(FDTheme.muted)
                attachments
                Text(itemText)
                    .font(NativePreferences.shared.font(size: 16, surface: "chat")).lineSpacing(6).textSelection(.enabled)
                    .lineLimit(collapseLongMessage && !longMessageExpanded ? 12 : nil)
                if collapseLongMessage {
                    Button(longMessageExpanded ? "Show less" : "Show more") { longMessageExpanded.toggle() }
                        .buttonStyle(.plain).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.accent)
                }
            }
            .foregroundStyle(FDTheme.foreground)
            .padding(16)
            .frame(maxWidth: 640, alignment: .leading)
            .background(FDTheme.raised, in: .rect(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(FDTheme.hairline) }
        }
        .contextMenu { messageActions }
    }

    private var collapseLongMessage: Bool {
        TranscriptPresentation.flag("collapse_long_user_messages", preferences: displayPreferences)
            && (itemText.count > 900 || itemText.filter { $0 == "\n" }.count > 12)
    }

    private var assistantMessage: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: message.kind == "code_review" ? "checkmark.shield" : "terminal")
                .font(.system(size: 11, weight: .medium)).foregroundStyle(FDTheme.accent)
                .frame(width: 23, height: 23).background(FDTheme.accentDim, in: .rect(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(message.kind == "code_review" ? "Code review" : FDTheme.providerName(provider))
                        .font(NativePreferences.shared.font(size: 12, surface: "chat", weight: .semibold)).foregroundStyle(FDTheme.secondary)
                    if message.streaming { MacActivityDiamond(size: 6) }
                    Spacer()
                    timestamp
                }
                if !raw["subject"].string.isEmpty {
                    Text(raw["subject"].string).font(NativePreferences.shared.font(size: 12, surface: "chat", weight: .medium)).foregroundStyle(FDTheme.muted)
                }
                NativeMarkdownView(text: itemText)
                attachments
                citations
                if !raw["error"].string.isEmpty {
                    Label(raw["error"].string, systemImage: "exclamationmark.circle")
                        .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.danger).textSelection(.enabled)
                }
                if raw["lifecycle"].string == "interrupted" {
                    Label("Response interrupted", systemImage: "stop.circle").font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
                }
                if !message.streaming && !itemText.isEmpty { actionBar }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .contextMenu { messageActions }
    }

    private var progressUpdate: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                Text("Progress update").font(NativePreferences.shared.font(size: 11, surface: "chat", weight: .medium))
                if message.streaming { MacActivityDiamond(size: 6) }
            }.foregroundStyle(FDTheme.muted)
            NativeMarkdownView(text: itemText, fontSize: 15, foreground: FDTheme.secondary)
            attachments
            citations
            if !raw["error"].string.isEmpty {
                Text(raw["error"].string).font(NativePreferences.shared.font(size: 12, surface: "chat"))
                    .foregroundStyle(FDTheme.danger).textSelection(.enabled)
            }
            if raw["lifecycle"].string == "interrupted" {
                Text("Response interrupted").font(NativePreferences.shared.font(size: 12, surface: "chat"))
                    .foregroundStyle(FDTheme.muted)
            }
        }
        .padding(.leading, 12)
        .overlay(alignment: .leading) { FDTheme.line.frame(width: 2) }
        .padding(.leading, activityInset)
        .accessibilityLabel("Assistant progress update")
        .contextMenu { messageActions }
    }

    @ViewBuilder private var attachments: some View {
        ForEach(Array(raw["attachments"].array.enumerated()), id: \.offset) { index, reference in
            TranscriptMediaView(reference: reference, resolvedURL: mediaURL?(reference), loadReference: attachmentLoader(reference, index: index))
        }
    }

    private func attachmentLoader(_ reference: JSON, index: Int) -> (() async throws -> JSON)? {
        guard let onLoadFullOutput else { return nil }
        return { TranscriptPresentation.reference(try await onLoadFullOutput(), original: reference, attachmentIndex: index) }
    }

    @ViewBuilder private var timestamp: some View {
        if let date = Self.timestampParser.date(from: raw["created_at"].string) {
            Text(date, style: .time).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
                .help(date.formatted(date: .long, time: .shortened))
        }
    }

    private var actionBar: some View {
        HStack(spacing: 2) {
            actionButton("Copy response", symbol: "doc.on.doc") { FDTheme.copy(itemText) }
            if let onQuote { actionButton("Quote response", symbol: "quote.bubble") { onQuote(itemText) } }
            if let onRetry { actionButton("Retry in a new branch", symbol: "arrow.clockwise", action: onRetry) }
            if let onReadAloud { actionButton("Read aloud", symbol: "speaker.wave.2") { onReadAloud(itemText) } }
        }.padding(.leading, -5)
    }

    @ViewBuilder private var messageActions: some View {
        Button("Copy message", systemImage: "doc.on.doc") { FDTheme.copy(itemText) }
        if let onQuote { Button("Quote message", systemImage: "quote.bubble") { onQuote(itemText) } }
        if message.kind == "user_message", !raw["pending"].bool {
            if let onEdit { Button("Edit in a new branch", systemImage: "pencil", action: onEdit) }
        }
        if !raw["pending"].bool, let onRetry { Button("Retry in a new branch", systemImage: "arrow.clockwise", action: onRetry) }
        if message.kind != "user_message", let onReadAloud {
            Button("Read aloud", systemImage: "speaker.wave.2") { onReadAloud(itemText) }
        }
    }

    private func actionButton(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).font(.system(size: 11)).frame(width: 28, height: 24).contentShape(.rect) }
            .buttonStyle(.plain).foregroundStyle(FDTheme.muted).help(title).accessibilityLabel(title)
    }

    private var reasoning: some View {
        let content = TranscriptPresentation.reasoningBody(raw)
        return VStack(alignment: .leading, spacing: 6) {
            if TranscriptPresentation.hasReasoningBody(raw) {
                DisclosureGroup(isExpanded: open) {
                    NativeMarkdownView(text: content, fontSize: 14, foreground: FDTheme.muted)
                        .padding(.leading, 12).padding(.top, 5)
                        .overlay(alignment: .leading) { FDTheme.line.frame(width: 2) }
                } label: { reasoningLabel }
            } else {
                reasoningLabel
            }
            if TranscriptPresentation.hasReasoningBody(raw), displayPreferences["thinking_display"].string == "preview", !open.wrappedValue {
                NativeMarkdownView(text: content, fontSize: 14, foreground: FDTheme.muted)
                    .frame(maxHeight: 88, alignment: .top).clipped()
                    .overlay(alignment: .bottom) {
                        Button("Show the full thought") { open.wrappedValue = true }
                            .buttonStyle(.plain).font(NativePreferences.shared.font(size: 11, surface: "chat"))
                            .foregroundStyle(FDTheme.accent).padding(.horizontal, 8).padding(.vertical, 3)
                            .background(FDTheme.background, in: .capsule)
                    }
                    .padding(.leading, 12)
            }
        }.padding(.leading, activityInset)
    }

    private var reasoningLabel: some View {
        HStack(spacing: 7) {
            if message.streaming { MacActivityDiamond(size: 7) }
            else if failed { Image(systemName: "exclamationmark.circle").foregroundStyle(FDTheme.danger) }
            else if raw["lifecycle"].string == "interrupted" { Image(systemName: "pause.circle") }
            Text(TranscriptPresentation.reasoningTitle(message))
                .lineLimit(2).multilineTextAlignment(.leading)
        }.font(NativePreferences.shared.font(size: 13, surface: "chat"))
            .foregroundStyle(FDTheme.muted)
    }

    private var toolActivity: some View {
        DisclosureGroup(isExpanded: open) {
            VStack(alignment: .leading, spacing: 12) {
                if TranscriptPresentation.suppressReadOnlyDetails(raw, preferences: displayPreferences), !readOnlyDetailsVisible {
                    Text("Read-only output is hidden by your conversation preferences.").font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
                    Button("Show details") { readOnlyDetailsVisible = true }.font(NativePreferences.shared.font(size: 12, surface: "chat")).buttonStyle(.plain).foregroundStyle(FDTheme.accent)
                } else {
                    TranscriptToolDetail(detail: raw["detail"], mediaURL: mediaURL)
                    toolOutput
                }
                if let outputError { Text(outputError).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.danger) }
            }.padding(.top, 10)
        } label: {
            HStack(spacing: 8) {
                if message.running { MacActivityDiamond(size: 7) }
                else { Image(systemName: failed ? "exclamationmark.circle" : "checkmark").font(.system(size: 11)).foregroundStyle(failed ? FDTheme.danger : FDTheme.muted) }
                VStack(alignment: .leading, spacing: 4) {
                    Text(TranscriptPresentation.nonempty(raw["title"].string, raw["detail"]["tool"].string, "Tool activity"))
                        .font(NativePreferences.shared.font(size: 13, surface: "code")).foregroundStyle(FDTheme.secondary).lineLimit(2)
                    if !raw["display"]["summary_hint"].string.isEmpty {
                        Text(raw["display"]["summary_hint"].string).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                if let duration = TranscriptPresentation.notableDuration(raw["detail"]["duration_ms"]) {
                    Text(duration).font(NativePreferences.shared.font(size: 13, surface: "code")).foregroundStyle(FDTheme.muted)
                }
                if case .number(let exit) = raw["exit_code"], exit != 0 {
                    Text("exit \(String(format: "%.0f", exit))").font(NativePreferences.shared.font(size: 13, surface: "code")).foregroundStyle(FDTheme.danger)
                }
            }
        }
        .padding(12)
        .background(failed ? FDTheme.danger.opacity(0.04) : FDTheme.surface, in: .rect(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(failed ? FDTheme.danger.opacity(0.3) : FDTheme.hairline) }
        .padding(.leading, activityInset)
    }

    @ViewBuilder private var toolOutput: some View {
        let output = raw["output"].string
        let limit = fullOutput == nil ? 16000 : Int.max
        if !output.isEmpty {
            if !raw["detail"]["result"]["content"].array.isEmpty || !raw["detail"]["content_items"].array.isEmpty {
                DisclosureGroup("Raw output") { TranscriptCodeBlock(text: String(output.prefix(limit)), language: "output") }
                    .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
            } else {
                TranscriptCodeBlock(text: String(output.prefix(limit)), language: "output")
            }
        } else if raw["detail"]["result"] == .null && raw["detail"]["content_items"].array.isEmpty {
            Text(message.running ? "Waiting for output…" : "No output recorded.")
                .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
        }
        let tests = raw["display"]["test_summary"]
        if tests != .null {
            HStack(spacing: 12) {
                if tests["passed"] != .null { Label("\(tests["passed"].int) passed", systemImage: "checkmark.circle").foregroundStyle(FDTheme.accent) }
                if tests["failed"] != .null { Label("\(tests["failed"].int) failed", systemImage: "xmark.circle").foregroundStyle(tests["failed"].int > 0 ? FDTheme.danger : FDTheme.muted) }
                if tests["skipped"] != .null { Text("\(tests["skipped"].int) skipped").foregroundStyle(FDTheme.muted) }
            }.font(NativePreferences.shared.font(size: 12, surface: "chat"))
        }
        if fullOutput == nil, raw["display"]["output_total_bytes"] != .null || output.count > limit {
            if let onLoadFullOutput {
                Button(loadingOutput ? "Loading full output…" : "Load full output") {
                    loadingOutput = true
                    let generation = outputGeneration
                    Task {
                        defer { if generation == outputGeneration { loadingOutput = false } }
                        do {
                            let output = try await onLoadFullOutput()
                            guard generation == outputGeneration else { return }
                            fullOutput = output; outputError = nil
                        } catch {
                            if generation == outputGeneration { outputError = error.localizedDescription }
                        }
                    }
                }.font(NativePreferences.shared.font(size: 12, surface: "chat")).disabled(loadingOutput)
            } else {
                Text("Output preview · \(raw["display"]["output_total_bytes"].int.formatted()) bytes total")
                    .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
            }
        }
    }

    private var plan: some View {
        card("Plan", symbol: "checklist") {
            VStack(alignment: .leading, spacing: 10) {
                if !raw["plan"]["explanation"].string.isEmpty { NativeMarkdownView(text: raw["plan"]["explanation"].string) }
                ForEach(Array(raw["plan"]["steps"].array.enumerated()), id: \.offset) { _, step in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: step["status"].string == "completed" ? "checkmark.circle.fill" : step["status"].string == "in_progress" ? "circle.dotted" : "circle")
                            .foregroundStyle(step["status"].string == "completed" ? FDTheme.accent : FDTheme.muted)
                        Text(step["step"].string).textSelection(.enabled)
                    }.font(NativePreferences.shared.font(size: 14, surface: "chat")).foregroundStyle(FDTheme.secondary)
                }
            }
        }
    }

    private var fileChanges: some View {
        card("\(raw["changes"].array.count) changed files", symbol: "doc.badge.gearshape") {
            ForEach(Array(raw["changes"].array.enumerated()), id: \.offset) { _, change in
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Image(systemName: change["change_kind"].string == "delete" ? "minus.circle" : change["change_kind"].string == "add" ? "plus.circle" : "pencil.circle")
                            .foregroundStyle(change["change_kind"].string == "delete" ? FDTheme.danger : FDTheme.accent)
                        if let onOpenFile {
                            Button(change["path"].string) { onOpenFile(change["path"].string, nil) }.buttonStyle(.plain)
                        } else { Text(change["path"].string).textSelection(.enabled) }
                        if !change["move_path"].string.isEmpty { Text("→ \(change["move_path"].string)").foregroundStyle(FDTheme.muted) }
                    }.font(NativePreferences.shared.font(size: 13, surface: "code")).foregroundStyle(FDTheme.secondary)
                    if !change["diff"].string.isEmpty { TranscriptCodeBlock(text: change["diff"].string, language: "diff") }
                }.padding(.vertical, 4)
            }
        }
    }

    private var webSearch: some View {
        let search = raw["search"]
        return card(TranscriptPresentation.nonempty(search["query"].string, "Web search"), symbol: "globe") {
            ForEach(Array(search["queries"].array.enumerated()), id: \.offset) { _, query in
                Label(query.string, systemImage: "magnifyingglass").font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.secondary).textSelection(.enabled)
            }
            if !search["pattern"].string.isEmpty { Text("Find: \(search["pattern"].string)").font(NativePreferences.shared.font(size: 12, surface: "chat")).textSelection(.enabled) }
            if let url = TranscriptPresentation.externalURL(search["url"].string) { Link(url.absoluteString, destination: url).font(NativePreferences.shared.font(size: 12, surface: "chat")) }
        }
    }

    private var artifact: some View {
        let artifact = raw["artifact"]
        return VStack(alignment: .leading, spacing: 12) {
            Label(TranscriptPresentation.nonempty(artifact["title"].string, "Artifact"), systemImage: "doc.richtext")
                .font(NativePreferences.shared.font(size: 13, surface: "chat", weight: .medium)).foregroundStyle(FDTheme.secondary)
            let content = artifact["content"].string
            if !content.isEmpty {
                if artifact["mime_type"].string.contains("markdown") { NativeMarkdownView(text: content) }
                else { TranscriptCodeBlock(text: content, language: artifact["mime_type"].string) }
            }
            if artifact["mime_type"].string.hasPrefix("image/") || artifact["mime_type"].string.hasPrefix("audio/") {
                TranscriptMediaView(reference: artifact, resolvedURL: mediaURL?(artifact))
            }
            if let url = TranscriptPresentation.externalURL(artifact["url"].string) {
                Link("Open artifact", destination: url).font(NativePreferences.shared.font(size: 12, surface: "chat"))
            }
            if artifact["payload"] != .null {
                DisclosureGroup("Details") { TranscriptCodeBlock(text: TranscriptPresentation.pretty(artifact["payload"]), language: "json") }
                    .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
            }
        }.padding(14).background(FDTheme.surface, in: .rect(cornerRadius: 10))
            .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(FDTheme.line) }.padding(.leading, activityInset)
    }

    @ViewBuilder private var citations: some View {
        let entries = raw["memory_citation"]["entries"].array
        let citations = raw["citations"].array
        if !entries.isEmpty || !citations.isEmpty {
            DisclosureGroup("Sources · \(entries.count + citations.count)") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(citations.enumerated()), id: \.offset) { _, citation in
                        let title = TranscriptPresentation.nonempty(citation["title"].string, citation["source"].string, citation["url"].string, "Source")
                        VStack(alignment: .leading, spacing: 4) {
                            if let url = TranscriptPresentation.externalURL(citation["url"].string) { Link(title, destination: url) }
                            else { Text(title).foregroundStyle(FDTheme.secondary) }
                            if !citation["cited_text"].string.isEmpty { Text(citation["cited_text"].string).foregroundStyle(FDTheme.muted).textSelection(.enabled) }
                        }
                    }
                    ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                        VStack(alignment: .leading, spacing: 3) {
                            if let onOpenFile {
                                Button("\(entry["path"].string):\(entry["line_start"].int)–\(entry["line_end"].int)") {
                                    onOpenFile(entry["path"].string, entry["line_start"].optionalInt)
                                }.buttonStyle(.plain).font(NativePreferences.shared.font(size: 13, surface: "code"))
                            } else {
                                Text("\(entry["path"].string):\(entry["line_start"].int)–\(entry["line_end"].int)").font(NativePreferences.shared.font(size: 13, surface: "code")).textSelection(.enabled)
                            }
                            if !entry["note"].string.isEmpty { Text(entry["note"].string).foregroundStyle(FDTheme.muted) }
                        }
                    }
                }.padding(.top, 6).font(NativePreferences.shared.font(size: 12, surface: "chat"))
            }.font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
        }
    }

    private var requestHistory: some View {
        let request = raw["request"]
        let resolved = raw["resolved"].bool
        let title = resolved ? TranscriptPresentation.nonempty(raw["resolution"]["label"].string, raw["resolution"]["outcome"].string.replacingOccurrences(of: "_", with: " ").capitalized, "Request resolved") : TranscriptPresentation.nonempty(request["title"].string, "Waiting for input")
        return card(title, symbol: resolved ? "checkmark.circle" : "questionmark.circle") {
            if resolved, !request["title"].string.isEmpty { Text(request["title"].string).font(NativePreferences.shared.font(size: 12, surface: "chat", weight: .medium)).foregroundStyle(FDTheme.secondary) }
            if !request["detail"].string.isEmpty { NativeMarkdownView(text: request["detail"].string) }
            if !request["command"].string.isEmpty { TranscriptCodeBlock(text: request["command"].string, language: "shell") }
            if !request["path"].string.isEmpty {
                if let onOpenFile { Button(request["path"].string) { onOpenFile(request["path"].string, nil) }.buttonStyle(.plain).font(NativePreferences.shared.font(size: 13, surface: "code")) }
                else { Text(request["path"].string).font(NativePreferences.shared.font(size: 13, surface: "code")).textSelection(.enabled) }
            }
            ForEach(request["questions"].array, id: \.self) { question in
                Text(question["question"].string).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.secondary)
            }
        }
    }

    private var service: some View {
        let level = raw["level"].string
        let color = ["error", "fatal"].contains(level) ? FDTheme.danger : ["warning", "warn"].contains(level) ? FDTheme.warning : FDTheme.muted
        return Label(itemText, systemImage: level == "error" ? "exclamationmark.circle" : "info.circle")
            .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(color).textSelection(.enabled).padding(.leading, activityInset)
    }

    private var realtime: some View {
        card(TranscriptPresentation.nonempty(raw["title"].string, "Realtime activity"), symbol: "waveform") {
            if !raw["summary"].string.isEmpty { NativeMarkdownView(text: raw["summary"].string) }
            TranscriptProviderContent(value: raw["payload"], mediaURL: mediaURL)
        }
    }

    private var unknown: some View {
        card(TranscriptPresentation.nonempty(raw["title"].string, raw["output_kind"].string, message.kind.replacingOccurrences(of: "_", with: " ").capitalized), symbol: "doc.questionmark") {
            let reason = TranscriptPresentation.nonempty(raw["reason"].string, itemText)
            if !reason.isEmpty { NativeMarkdownView(text: reason) }
            TranscriptCodeBlock(text: TranscriptPresentation.pretty(raw["payload"] == .null ? raw : raw["payload"]), language: "Details")
        }
    }

    private func activityLabel(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted).padding(.leading, activityInset)
    }

    private func card<Content: View>(_ title: String, symbol: String, @ViewBuilder content: @escaping () -> Content) -> some View {
        DisclosureGroup(isExpanded: open) {
            VStack(alignment: .leading, spacing: 12, content: content).padding(.top, 10)
        } label: {
            Label(title, systemImage: symbol).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
        }.padding(.leading, activityInset)
    }
}
