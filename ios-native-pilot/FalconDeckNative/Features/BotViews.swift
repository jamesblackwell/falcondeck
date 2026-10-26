import SwiftUI
import UniformTypeIdentifiers

private struct BotEditorTarget: Identifiable {
    let id = UUID()
    let bot: NativeBot?
}

struct NativeBotsSection: View {
    @Environment(AppModel.self) private var model
    let search: String
    let openDetail: () -> Void
    @State private var expanded = true
    @State private var editor: BotEditorTarget?
    @State private var opening: String?
    private var bots: [NativeBot] {
        model.bots.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
    }
    var body: some View {
        HStack(spacing: 0) {
            Button { expanded.toggle() } label: {
                HStack {
                    Text("BOTS").font(.system(.caption2, design: .monospaced).weight(.medium)).tracking(0.8)
                    Spacer()
                    NativeDisclosureChevron(expanded: expanded || !search.isEmpty)
                }.foregroundStyle(FD.muted).padding(.leading, 12).contentShape(.rect)
            }.buttonStyle(.plain).disabled(!search.isEmpty)
                .accessibilityLabel("Bots").accessibilityValue(expanded ? "Expanded" : "Collapsed")
            Button { editor = BotEditorTarget(bot: nil) } label: {
                Image(systemName: "plus").font(.caption).foregroundStyle(FD.secondary)
                    .frame(width: 44, height: 44).contentShape(.rect)
            }.buttonStyle(.plain).accessibilityLabel("New bot").accessibilityIdentifier("sidebar-new-bot")
                .disabled(!model.demo && !model.connected)
        }.padding(.top, 8)
        if expanded || !search.isEmpty {
            ForEach(bots) { bot in
                HStack(spacing: 0) {
                    Button {
                        guard opening == nil else { return }; opening = bot.id
                        Task { defer { opening = nil }; if await model.openBot(bot) { openDetail() } }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "person.crop.square").foregroundStyle(FD.muted).frame(width: 18)
                            Text(bot.name).font(.subheadline).lineLimit(1)
                            Spacer(minLength: 4)
                            let related = model.delegatedTasks(for: bot) + [model.task(bot.taskID)].compactMap { $0 }
                            if related.contains(where: \.needsAttention) {
                                Image(systemName: "exclamationmark.circle").foregroundStyle(FD.warning)
                            } else if opening == bot.id || related.contains(where: \.working) { ActivityDiamond() }
                            else if model.task(bot.taskID)?.unread == true { Circle().fill(FD.unread).frame(width: 6, height: 6) }
                        }.padding(.leading, 12).frame(minHeight: 44).contentShape(.rect)
                    }.buttonStyle(.plain).accessibilityIdentifier("sidebar-bot-\(bot.id)")
                        .accessibilityAddTraits(model.selection == .task(bot.taskID) ? .isSelected : [])
                    Button { editor = BotEditorTarget(bot: bot) } label: {
                        Image(systemName: "slider.horizontal.3").font(.caption).foregroundStyle(FD.muted)
                            .frame(width: 44, height: 44).contentShape(.rect)
                    }.buttonStyle(.plain).accessibilityLabel("Settings for \(bot.name)")
                        .accessibilityIdentifier("bot-options-\(bot.id)")
                }.foregroundStyle(model.selection == .task(bot.taskID) ? FD.foreground : FD.secondary)
                    .background(model.selection == .task(bot.taskID) ? FD.raised : .clear, in: .rect(cornerRadius: 8))
            }
            if model.bots.isEmpty && search.isEmpty {
                Text("Create a bot to coordinate work across your projects.")
                    .font(.caption).foregroundStyle(FD.secondary).padding(.horizontal, 12).padding(.bottom, 8)
            }
        }
        Color.clear.frame(height: 0)
            .sheet(item: $editor) { target in NativeBotEditor(bot: target.bot, openDetail: openDetail) }
    }
}

struct NativeBotEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let bot: NativeBot?
    var openDetail: () -> Void = {}
    @State private var draft: NativeBotDraft
    @State private var busy = false
    @State private var error: String?
    @State private var deleting = false
    @State private var stopping = false
    @State private var documents: [String] = []
    @State private var loadingDocuments = false
    @State private var documentsError: String?
    @State private var document: BotDocumentTarget?
    private var canMutate: Bool { model.demo || model.connected }
    init(bot: NativeBot?, openDetail: @escaping () -> Void = {}) {
        self.bot = bot; self.openDetail = openDetail
        _draft = State(initialValue: NativeBotDraft(bot: bot))
    }
    var body: some View {
        NavigationStack {
            Form {
                profile
                if let bot {
                    documentSection(bot)
                    delegatedSection(bot)
                    Section {
                        Button("Stop work", systemImage: "stop.circle") { stopping = true }
                            .accessibilityIdentifier("bot-stop-work")
                        Button("Delete bot", systemImage: "trash", role: .destructive) { deleting = true }
                            .accessibilityIdentifier("bot-delete")
                    }.listRowBackground(FD.surface).disabled(!canMutate)
                }
                if let error { Text(error).foregroundStyle(FD.danger).listRowBackground(FD.surface).accessibilityIdentifier("bot-error") }
            }.disabled(busy).scrollContentBackground(.hidden).background(FD.background)
                .navigationTitle(bot == nil ? "New bot" : "Bot settings").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(busy ? "Saving…" : "Save") { save() }
                            .disabled(busy || !canMutate || draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("save-bot")
                    }
                }
                .task(id: canMutate) { if let bot { await loadDocuments(bot) } }
                .sheet(item: $document, onDismiss: { if let bot { Task { await loadDocuments(bot) } } }) { target in
                    if let bot { NativeBotDocumentEditor(bot: bot, filename: target.name).id(model.connectionID) }
                }
                .confirmationDialog("Stop this bot and its delegated work?", isPresented: $stopping) {
                    Button("Stop work", role: .destructive) { if let bot { run { try await model.stopBot(bot) } } }
                } message: { Text("Queued requests are cleared and active work is interrupted.") }
                .confirmationDialog("Delete this bot?", isPresented: $deleting) {
                    Button("Delete bot", role: .destructive) { if let bot { run { try await model.deleteBot(bot); dismiss() } } }
                } message: { Text("Stop active work first. The conversation will be archived and documents kept on your computer.") }
        }.interactiveDismissDisabled(busy)
    }
    private var profile: some View {
        Section {
            TextField("Name", text: $draft.name).accessibilityIdentifier("bot-name")
            if bot == nil {
                Picker("Home conversation", selection: $draft.existingTaskID) {
                    Text("Start a new conversation").tag("")
                    ForEach(model.tasks.filter { !$0.isDraft && !$0.archived && !model.botTaskIDs.contains($0.id) }) { task in Text(task.title).tag(task.id) }
                }
                if draft.existingTaskID.isEmpty {
                    Picker("Agent", selection: $draft.provider) {
                        ForEach(model.botProviders, id: \.self) { Text($0 == "claude" ? "Claude Code" : $0.capitalized).tag($0) }
                    }
                    TextField("Model (agent default)", text: $draft.modelID).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            }
            TextField("Your instructions", text: $draft.instructions, axis: .vertical).lineLimit(4...12)
                .accessibilityIdentifier("bot-instructions")
            DisclosureGroup("FalconDeck defaults") {
                Text("Coordinate work in the appropriate projects, follow up on delegated tasks and bring back results or decisions. Keep durable knowledge in editable documents and respect your edits and deletions. Existing approval rules apply.")
                    .font(.footnote).foregroundStyle(FD.secondary)
            }
            if bot != nil { Toggle("Allow this bot to start tasks through FalconDeck", isOn: $draft.canStartThreads) }
        }.listRowBackground(FD.surface).disabled(!canMutate)
    }
    private func documentSection(_ bot: NativeBot) -> some View {
        Section {
            if loadingDocuments { HStack { ActivityDiamond(); Text("Loading documents…") }.foregroundStyle(FD.secondary) }
            ForEach(documents, id: \.self) { name in
                Button { document = BotDocumentTarget(name: name) } label: { Label(name, systemImage: "doc.text") }
                    .accessibilityIdentifier("bot-document-\(name)")
            }
            if let documentsError {
                Text(documentsError).font(.footnote).foregroundStyle(FD.danger)
                Button("Retry documents") { Task { await loadDocuments(bot) } }.disabled(!canMutate)
            } else if !loadingDocuments && documents.isEmpty {
                Text("Keep notes and instructions your bot can read.").font(.footnote).foregroundStyle(FD.secondary)
            }
            Button("New document", systemImage: "doc.badge.plus") { document = BotDocumentTarget(name: nil) }
                .disabled(!canMutate).accessibilityIdentifier("bot-new-document")
        } header: { Text("Documents") } footer: {
            Text("Documents live on your computer. Edits are checked against the current file before saving.")
        }.listRowBackground(FD.surface)
    }
    private func delegatedSection(_ bot: NativeBot) -> some View {
        Section("Delegated tasks") {
            let tasks = model.delegatedTasks(for: bot)
            if tasks.isEmpty { Text("Delegated work will appear here.").font(.footnote).foregroundStyle(FD.secondary) }
            ForEach(tasks) { task in
                Button {
                    dismiss()
                    Task { await model.openTask(task.id); openDetail() }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(task.title).lineLimit(2)
                            Text(model.projects.first(where: { $0.id == task.projectID })?.name ?? "Task")
                                .font(.caption).foregroundStyle(FD.secondary)
                        }
                        Spacer()
                        if task.working { ActivityDiamond() }
                        else { Text(task.status.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption).foregroundStyle(FD.secondary) }
                    }
                }.buttonStyle(.plain)
            }
        }.listRowBackground(FD.surface)
    }
    private func loadDocuments(_ bot: NativeBot) async {
        guard canMutate else { documentsError = "Connect to your computer to load documents."; return }
        loadingDocuments = true; documentsError = nil
        defer { loadingDocuments = false }
        do { documents = try await model.botDocuments(bot) }
        catch { if !(error is CancellationError) { documentsError = error.localizedDescription } }
    }
    private func save() {
        run {
            let saved = try await model.saveBot(draft, bot: bot)
            if bot == nil, await model.openBot(saved) { openDetail() }
            dismiss()
        }
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await action() }
            catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
        }
    }
}

private struct BotDocumentTarget: Identifiable {
    let id = UUID()
    let name: String?
}

struct NativeBotDocumentEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let bot: NativeBot
    let filename: String?
    @State private var name = ""
    @State private var content = ""
    @State private var version: String?
    @State private var loading = true
    @State private var loaded = false
    @State private var busy = false
    @State private var error: String?
    @State private var deleting = false
    @State private var importing = false
    private var canMutate: Bool { model.demo || model.connected }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Document name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("bot-document-name")
                    TextEditor(text: $content).font(.system(.body, design: .monospaced)).frame(minHeight: 240)
                        .accessibilityLabel("Document content").accessibilityIdentifier("bot-document-content")
                    if filename == nil { Button("Import text file", systemImage: "square.and.arrow.down") { importing = true } }
                }.listRowBackground(FD.surface).disabled(loading || !loaded || !canMutate)
                if filename != nil {
                    Section { Button("Delete document", systemImage: "trash", role: .destructive) { deleting = true }.disabled(version == nil || !canMutate) }
                        .listRowBackground(FD.surface)
                }
                if loading { HStack { ActivityDiamond(); Text("Loading document…") }.listRowBackground(FD.surface) }
                if let error {
                    Section {
                        Text(error).foregroundStyle(FD.danger).accessibilityIdentifier("bot-document-error")
                        if !loaded { Button("Retry") { Task { await load() } } }
                    }.listRowBackground(FD.surface)
                }
            }.disabled(busy).scrollContentBackground(.hidden).background(FD.background)
                .navigationTitle(filename == nil ? "New document" : "Edit document").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(busy ? "Saving…" : "Save") {
                            run { try await model.writeBotDocument(bot, name: name, content: content, expectedVersion: name == filename ? version : nil); dismiss() }
                        }.disabled(busy || loading || !loaded || !canMutate || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("save-bot-document")
                    }
                }
                .task { await load() }
                .confirmationDialog("Delete this document from your computer?", isPresented: $deleting) {
                    Button("Delete document", role: .destructive) {
                        if let filename, let version { run { try await model.deleteBotDocument(bot, name: filename, expectedVersion: version); dismiss() } }
                    }
                }
                .fileImporter(isPresented: $importing, allowedContentTypes: [.text, .plainText]) { result in
                    do {
                        let url = try result.get(), access = url.startAccessingSecurityScopedResource()
                        defer { if access { url.stopAccessingSecurityScopedResource() } }
                        guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 1_048_576 else { throw PilotError("Document must be at most 1 MB.") }
                        let text = try String(contentsOf: url, encoding: .utf8)
                        name = url.lastPathComponent; content = text
                    } catch { self.error = error.localizedDescription }
                }
        }.interactiveDismissDisabled(busy)
    }
    private func load() async {
        loading = true; error = nil; defer { loading = false }
        guard let filename else { loaded = true; return }
        do {
            let document = try await model.readBotDocument(bot, name: filename)
            name = document.name; content = document.content; version = document.version; loaded = true
        } catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await action() }
            catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
        }
    }
}
