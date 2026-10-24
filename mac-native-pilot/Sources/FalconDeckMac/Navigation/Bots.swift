import AppKit
import SwiftUI

struct NativeBot: Identifiable {
    let raw: JSON
    var id: String { raw["id"].string }
    var name: String { raw["name"].string }
    var taskID: String { raw["thread_id"].string }
}

extension AppStore {
    var bots: [NativeBot] { preferences["bots"].array.map(NativeBot.init) }
    var botProviders: [String] {
        Array(Set(["codex", "claude"] + allProjects.flatMap { $0.raw["agents"].array.map { $0["provider"].string } })).filter { !$0.isEmpty }.sorted()
    }
    var botTaskIDs: Set<String> { Set(bots.map(\.taskID)) }
}

struct NativeBotsSection: View {
    @Bindable var store: AppStore
    @State private var editor: NativeBot?
    @State private var creating = false
    var body: some View {
        Section {
            ForEach(store.bots) { bot in
                HStack {
                    Button { Task { await store.selectTask(bot.taskID, preservePinScope: false) } } label: {
                        HStack {
                            Image(systemName: "person.crop.square").foregroundStyle(FDTheme.muted)
                            Text(bot.name).lineLimit(1); Spacer()
                            let related = store.tasks.filter { $0.id == bot.taskID || ($0.raw["origin"]["kind"].string == "agent_spawn" && $0.raw["origin"]["parent_thread_id"].string == bot.taskID) }
                            if related.contains(where: \.needsAttention) { Image(systemName: "exclamationmark.circle").foregroundStyle(.orange) }
                            else if related.contains(where: \.running) { ProgressView().controlSize(.mini) }
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    Button { editor = bot } label: { Image(systemName: "slider.horizontal.3") }
                        .buttonStyle(.plain).help("Edit \(bot.name)")
                }.tag("task:\(bot.taskID)")
                    .font(NativePreferences.shared.font(size: 14, surface: "sidebar"))
            }
        } header: {
            HStack { Text("Bots"); Spacer(); Button { creating = true } label: { Image(systemName: "plus") }.buttonStyle(.plain).help("New bot") }
        }
        .sheet(isPresented: $creating) { NativeBotEditor(store: store, bot: nil) }
        .sheet(item: $editor) { NativeBotEditor(store: store, bot: $0) }
    }
}

struct NativeBotEditor: View {
    @Bindable var store: AppStore
    let bot: NativeBot?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var instructions = ""
    @State private var provider = "codex"
    @State private var model = ""
    @State private var existingTask = ""
    @State private var canStart = true
    @State private var busy = false
    @State private var error: String?
    @State private var deletingBot = false
    @State private var documents: [String] = []
    @State private var documentName = ""
    @State private var documentContent = ""
    @State private var documentVersion: String?
    @State private var originalDocumentName = ""
    @State private var editingDocument = false
    @State private var deletingDocument = false

    var body: some View {
        VStack(spacing: 0) {
            HStack { Text(bot?.name ?? "New bot").font(.headline); Spacer(); Button("Close") { dismiss() }.disabled(busy) }.padding()
            Divider()
            Form {
                Section {
                    TextField("Name", text: $name)
                    if bot == nil {
                        Picker("Home conversation", selection: $existingTask) {
                            Text("Start a new conversation").tag("")
                            ForEach(store.tasks.filter { !store.botTaskIDs.contains($0.id) && !$0.raw["is_archived"].bool && NativeHostManager.split($0.id).hostID == nil }) { task in Text(task.title).tag(task.id) }
                        }
                        if existingTask.isEmpty {
                            Picker("Harness", selection: $provider) { ForEach(store.botProviders, id: \.self) { Text($0 == "claude" ? "Claude Code" : $0.capitalized).tag($0) } }
                            TextField("Model (harness default)", text: $model)
                        }
                    }
                    VStack(alignment: .leading) { Text("Your instructions"); TextEditor(text: $instructions).frame(minHeight: 100).font(.body) }
                    DisclosureGroup("FalconDeck defaults") {
                        Text("Coordinate work through tasks in the appropriate project. Stay available for direction, follow up on delegated work, and bring back results or decisions. Keep durable knowledge in editable documents. Read relevant documents and respect your edits and deletions. Existing approval rules apply.").font(.callout).foregroundStyle(FDTheme.muted)
                    }
                    if bot != nil { Toggle("Allow this bot to start tasks through FalconDeck", isOn: $canStart) }
                }
                if let bot {
                    Section("Documents") {
                        Text(bot.raw["space_path"].string).font(.caption).textSelection(.enabled)
                        HStack {
                            Button("New document") { documentName = "Untitled.md"; documentContent = ""; documentVersion = nil; originalDocumentName = ""; editingDocument = true }
                            Button("Add document…", action: importDocument)
                            Button("Show in Finder") { NSWorkspace.shared.open(URL(fileURLWithPath: bot.raw["space_path"].string)) }
                        }.disabled(busy)
                        ForEach(documents, id: \.self) { filename in
                            Button(filename) { run {
                                let result = try await store.request(["api", "bots", bot.id, "documents", "content"], query: [URLQueryItem(name: "name", value: filename)])
                                documentName = result["name"].string; documentContent = result["content"].string; documentVersion = result["version"].string; originalDocumentName = documentName; editingDocument = true
                            }}.disabled(busy)
                        }
                        if editingDocument {
                            TextField("Document name", text: $documentName)
                            TextEditor(text: $documentContent).font(.system(.body, design: .monospaced)).frame(minHeight: 150)
                            HStack {
                                Button("Save document") { run {
                                    _ = try await store.request(["api", "bots", bot.id, "documents"], method: "POST", body: .object(["action": .string("write"), "name": .string(documentName), "content": .string(documentContent), "expected_version": originalDocumentName == documentName ? documentVersion.map(JSON.string) ?? .null : .null]))
                                    try await loadDocuments(); editingDocument = false
                                }}
                                Button("Delete document", role: .destructive) { deletingDocument = true }.disabled(documentVersion == nil || originalDocumentName != documentName)
                            }.disabled(busy || documentName.isEmpty)
                        }
                    }
                    Section("Delegated tasks") {
                        let children = store.tasks.filter { $0.raw["origin"]["kind"].string == "agent_spawn" && $0.raw["origin"]["parent_thread_id"].string == bot.taskID }
                        if children.isEmpty { Text("Delegated work will appear here.").foregroundStyle(FDTheme.muted) }
                        ForEach(children) { task in
                            Button { dismiss(); Task { await store.selectTask(task.id, preservePinScope: false) } } label: {
                                HStack { Text(task.title).lineLimit(1); Spacer(); Text(task.raw["status"].string.replacingOccurrences(of: "_", with: " ")).foregroundStyle(FDTheme.muted) }
                            }.buttonStyle(.plain)
                        }
                    }
                }
                if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }.formStyle(.grouped)
            Divider()
            HStack {
                if let bot {
                    Button("Stop work") { run { _ = try await store.request("/api/bots", method: "POST", body: .object(["action": .string("stop"), "id": .string(bot.id)])) } }
                    Button("Delete bot", role: .destructive) { deletingBot = true }
                }
                Spacer()
                Button(busy ? "Saving…" : bot == nil ? "Create bot" : "Save changes", action: save).buttonStyle(.borderedProminent).disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.padding().disabled(busy)
        }.frame(width: 620, height: 720).interactiveDismissDisabled(busy)
        .task {
            name = bot?.name ?? ""; instructions = bot?.raw["instructions"].string ?? ""; canStart = bot?.raw["can_start_threads"].bool ?? true
            if bot != nil { do { try await loadDocuments() } catch { self.error = error.localizedDescription } }
        }
        .confirmationDialog("Remove this bot? Its conversation will be archived and documents kept on disk.", isPresented: $deletingBot) {
            Button("Remove bot", role: .destructive) { guard let bot else { return }; run {
                _ = try await store.request("/api/bots", method: "POST", body: .object(["action": .string("delete"), "id": .string(bot.id)])); await store.refresh(); dismiss()
            }}
        }
        .confirmationDialog("Delete \(documentName) from disk?", isPresented: $deletingDocument) {
            Button("Delete", role: .destructive) { guard let bot else { return }; run {
                _ = try await store.request(["api", "bots", bot.id, "documents"], method: "POST", body: .object(["action": .string("delete"), "name": .string(documentName), "expected_version": .string(documentVersion ?? "")])); try await loadDocuments(); editingDocument = false
            }}
        }
    }

    private func save() {
        run {
            var fields: [String: JSON] = ["action": .string(bot == nil ? "create" : "update"), "name": .string(name), "instructions": .string(instructions)]
            if let bot { fields["id"] = .string(bot.id); fields["can_start_threads"] = .bool(canStart) }
            else if !existingTask.isEmpty { fields["thread_id"] = .string(existingTask) }
            else { fields["provider"] = .string(provider); if !model.isEmpty { fields["model_id"] = .string(model) } }
            let result = try await store.request("/api/bots", method: "POST", body: .object(fields)); await store.refresh()
            if bot == nil { await store.selectTask(result["bot"]["thread_id"].string, preservePinScope: false, focusComposer: true) }; dismiss()
        }
    }
    private func loadDocuments() async throws {
        guard let bot else { return }; documents = try await store.request(["api", "bots", bot.id, "documents"]).array.map(\.string)
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil
        Task { @MainActor in defer { busy = false }; do { try await action() } catch { self.error = error.localizedDescription } }
    }
    private func importDocument() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 1_048_576 else { throw PilotError("Document must be at most 1 MB.") }
            documentContent = try String(contentsOf: url, encoding: .utf8); documentName = url.lastPathComponent; documentVersion = nil; originalDocumentName = ""; editingDocument = true
        } catch { self.error = error.localizedDescription }
    }
}
