import SwiftUI
import AppKit
import UniformTypeIdentifiers

extension ConversationView {
    var canBranch: Bool { store.selectedTask.map { ConversationActionSemantics.canBranch(task: $0, capabilities: capabilities) } ?? false }

    func taskMenu(_ task: AgentTask) -> some View {
        Menu {
            Button("Rename…") { activeSheet = .rename }
            Button(task.pinned ? "Unpin globally" : "Pin globally") { action { _ = try await ConversationActions.request(store, task: task, method: "PATCH", body: .object(["pinned": .bool(!task.pinned)])) } }
            if capabilities["supports_goals"].bool { Button(task.raw["goal"] == .null ? "Set goal…" : "Edit goal…") { activeSheet = .goal } }
            Divider()
            if capabilities["supports_compaction"].bool { Button("Compact context…") { activeSheet = .compact }.disabled(task.running) }
            if capabilities["supports_review"].bool {
                Button("Review uncommitted changes") {
                    action { _ = try await ConversationActions.request(store, task: task, suffix: "/review", body: .object(["target": .object(["type": .string("uncommittedChanges")])])) }
                }.disabled(task.running)
            }
            if capabilities["supports_forking"].bool {
                Button("Fork conversation") { action { try await fork(task, lastTurnID: task.latestTurnID) } }.disabled(!canBranch || task.latestTurnID.isEmpty)
            }
            Menu("Continue with another agent") {
                ForEach(store.availableProviders.filter { $0 != provider }, id: \.self) { destination in
                    Button(FDTheme.providerName(destination)) { action { try await handoff(task, provider: destination) } }
                }
            }.disabled(task.running || store.availableProviders.count < 2)
            Divider()
            Button("Copy working directory") { FDTheme.copy(workingDirectory) }
            if !task.raw["native_session_id"].string.isEmpty { Button("Copy session ID") { FDTheme.copy(task.raw["native_session_id"].string) } }
            Button("Show project in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: workingDirectory) }
                .disabled(store.selectedHostID != nil)
            Menu("Export conversation") {
                Button("Save loaded messages as Markdown…") { saveExport(partial: store.hasOlder) }
                Button("Load complete history and save…") { action { try await loadAll(task); saveExport(partial: false) } }
                Button("Copy loaded messages") { FDTheme.copy(ConversationExport.markdown(store.messages, title: task.title, partial: store.hasOlder)) }
            }
        } label: { Image(systemName: "ellipsis.circle") }
        .menuStyle(.borderlessButton).fixedSize().disabled(actionPending).accessibilityLabel("Conversation actions")
    }

    func send() { submit(alternate: false) }
    func sendAlternate() { submit(alternate: true) }
    func submit(alternate: Bool) {
        guard canSend else { return }
        let text = store.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if text == "/compact" || text.hasPrefix("/compact ") {
            guard let task = store.selectedTask, capabilities["supports_compaction"].bool, !task.running, attachments.isEmpty, quote.isEmpty else {
                store.errorMessage = "Compaction needs an idle conversation without attachments or quotes."; return
            }
            let key = store.composerKey
            action {
                let body = try ConversationActionSemantics.compactionBody(instructions: String(text.dropFirst(8)), capabilities: capabilities)
                _ = try await ConversationActions.request(store, task: task, suffix: "/compact", body: body)
                if store.composerKey == key, store.draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { store.draft = "" }
            }; return
        }
        do { try NativeMacAttachment.validate(attachments) } catch { store.errorMessage = error.localizedDescription; return }
        if attachments.contains(where: { $0.kind == .image }), !capabilities["supports_images"].bool {
            store.errorMessage = "This agent does not support image attachments."; return
        }
        var inputs: [JSON] = []
        let quoted = quote.split(separator: "\n", omittingEmptySubsequences: false).map { "> " + $0 }.joined(separator: "\n")
        let prompt = quote.isEmpty ? text : quoted + "\n\n" + text
        if !prompt.isEmpty { inputs.append(.object(["type": .string("text"), "text": .string(prompt)])) }
        inputs += attachments.map(\.input)
        var fields = selection.validated(project: store.selectedProject, provider: provider, task: store.selectedTask).fields
        fields["isolation"] = .string(selection.isolation)
        let steer = alternate ? selection.followUp != "steer" : selection.followUp == "steer"
        fields["steer"] = .bool(steer && capabilities["supports_steering"].bool)
        fields["selected_skills"] = .array(ConversationCatalog.selectedSkills(text, skills: skills))
        followsLatest = true
        Task { await store.sendInputs(inputs, settings: fields) }
    }

    func restoreSelection() {
        selection = NativeComposerSelection.restored(ConversationLocalStorage.load(NativeComposerSelection.self, key: selectionKey), task: store.selectedTask, project: store.selectedProject, provider: provider)
        selection.followUp = NativePreferences.shared.followUpBehavior
    }
    func restorePayload() {
        let payload = store.composerPayload(key: store.composerKey)
        attachments = (try? JSONDecoder().decode([NativeMacAttachment].self, from: payload["attachments"].data())) ?? []
        quote = payload["quote"].string
    }
    func persistPayload() {
        let encoded = (try? JSON.decode(JSONEncoder().encode(attachments))) ?? .array([])
        store.setComposerPayload(.object(["attachments": encoded, "quote": .string(quote)]), key: store.composerKey)
    }
    func pickAttachments() {
        let key = store.composerKey
        AttachmentPicker.pick { values, error in
            appendAttachments(values, expectedKey: key)
            if let error { store.errorMessage = error }
        }
    }
    func appendAttachments(_ values: [NativeMacAttachment], expectedKey: String) {
        guard expectedKey == store.composerKey else { store.errorMessage = "The conversation changed while files were loading. Attach them again in the intended conversation."; return }
        do { try NativeMacAttachment.validate(attachments + values); attachments += values; persistPayload() }
        catch { store.errorMessage = error.localizedDescription }
    }

    func loadCatalog() async {
        guard store.isSelectedHostConnected, let projectID = store.selectedProjectID else { return }
        let key = catalogKey, chosenProvider = provider
        loadingCatalog = true
        defer { if catalogKey == key { loadingCatalog = false } }
        do {
            let base = "/api/workspaces/" + conversationPathComponent(projectID)
            async let skillResult = store.request(path: base + "/skills?provider=" + conversationPathComponent(chosenProvider))
            async let promptResult = store.request(path: base + "/prompts")
            _ = try await store.request(path: base + "/providers/" + conversationPathComponent(chosenProvider) + "/hydrate", method: "POST")
            let result = try await (skillResult, promptResult)
            guard key == catalogKey else { return }
            skills = result.0["skills"].array.filter { skill in
                let supported = skill["providers"].array.map(\.string)
                return supported.isEmpty ? ["both", chosenProvider].contains(skill["availability"].string) : supported.contains(chosenProvider)
            }
            prompts = result.1["prompts"].array
        } catch { if key == catalogKey { skills = []; prompts = [] } }
    }

    func action(_ operation: @escaping () async throws -> Void) {
        guard !actionPending else { return }; actionPending = true; store.errorMessage = nil
        Task {
            defer { actionPending = false }
            do { try await operation() }
            catch is CancellationError {}
            catch { store.errorMessage = error.localizedDescription }
        }
    }
    @discardableResult func fork(_ task: AgentTask, lastTurnID: String) async throws -> String {
        guard ConversationActionSemantics.canBranch(task: task, capabilities: capabilities) else {
            throw PilotError("Forking requires an idle task in the project folder and an agent that supports it.")
        }
        guard !lastTurnID.isEmpty else { throw PilotError("There isn't a completed turn to fork yet.") }
        let result = try await ConversationActions.request(store, task: task, suffix: "/fork", body: .object(["last_turn_id": .string(lastTurnID)]))
        guard store.selectedTaskID == task.id else { throw CancellationError() }
        await ConversationActions.adopt(store, result: result)
        return result["thread"]["id"].string
    }
    func edit(_ message: Message, retry: Bool) async throws {
        guard let task = store.selectedTask else { return }
        guard ConversationActionSemantics.canBranch(task: task, capabilities: capabilities), !message.raw["turn_id"].string.isEmpty else {
            throw PilotError("This message does not have a supported turn boundary for editing or retrying.")
        }
        var retrySettings = ConversationActionSemantics.branchSettings(task)
        retrySettings["selected_skills"] = .array(ConversationCatalog.selectedSkills(message.text, skills: skills))
        var original = message
        if !message.raw["attachments"].array.isEmpty {
            original = Message(try await store.request(path: conversationPath(task) + "/items/" + conversationPathComponent(message.id)))
        }
        guard store.selectedTaskID == task.id else { throw CancellationError() }
        let restoredAttachments = try original.raw["attachments"].array.map { image -> NativeMacAttachment in
            let value = image["url"].string
            guard value.hasPrefix("data:image/"), let comma = value.firstIndex(of: ","), let bytes = Data(base64Encoded: String(value[value.index(after: comma)...])) else {
                throw PilotError("An image in this message could not be restored. Open its preview and attach the image again before editing.")
            }
            return try NativeMacAttachment.prepare(bytes, name: image["name"].string)
        }
        let lastTurnID = original.raw["previous_turn_id"].string
        let destinationID: String
        if !lastTurnID.isEmpty { destinationID = try await fork(task, lastTurnID: lastTurnID) }
        else {
            let result = try await store.request(path: "/api/workspaces/" + conversationPathComponent(task.projectID) + "/threads", method: "POST", body: ConversationActionSemantics.newBranchBody(task))
            guard store.selectedTaskID == task.id else { throw CancellationError() }
            let destination = AgentTask(result["thread"])
            guard !destination.id.isEmpty else { throw PilotError("The daemon did not return the new task.") }
            // StartThread does not accept effort or speed. Preserve those via
            // the ordinary settings PATCH before the branch is opened.
            let updated = try await ConversationActions.request(store, task: destination, method: "PATCH", body: .object(ConversationActionSemantics.branchSettings(task)))
            guard store.selectedTaskID == task.id else { throw CancellationError() }
            destinationID = destination.id
            await ConversationActions.adopt(store, result: updated["thread"] == .null ? result.setting("thread", updated) : updated)
        }
        guard store.selectedTaskID == destinationID else { throw CancellationError() }
        store.draft = original.text
        attachments = restoredAttachments
        quote = ""; persistPayload()
        if retry {
            var inputs: [JSON] = original.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : [.object(["type": .string("text"), "text": .string(original.text)])]
            inputs += attachments.map(\.input)
            await store.sendInputs(inputs, settings: retrySettings)
        }
    }
    func retry(_ message: Message) async throws {
        guard let user = ConversationActionSemantics.retrySource(for: message, messages: store.messages) else { throw PilotError("The original message does not have a loaded turn boundary. Load earlier messages and try again.") }
        try await edit(user, retry: true)
    }
    func loadAll(_ task: AgentTask) async throws {
        guard store.selectedTaskID == task.id else { throw CancellationError() }
        while store.hasOlder {
            guard store.selectedTaskID == task.id else { throw CancellationError() }
            let first = store.messages.first?.id
            await store.loadOlder()
            guard store.selectedTaskID == task.id else { throw CancellationError() }
            if store.hasOlder && store.messages.first?.id == first { throw PilotError("Couldn’t load the complete conversation. Try again when connected.") }
        }
    }
    func handoff(_ task: AgentTask, provider destination: String) async throws {
        try await loadAll(task)
        let context = ConversationExport.markdown(store.messages, title: task.title, partial: false)
        let result = try await store.request(path: "/api/workspaces/" + conversationPathComponent(task.projectID) + "/threads", method: "POST", body: .object([
            "workspace_id": .string(task.projectID), "provider": .string(destination), "handoff_from": .object(["thread_id": .string(task.id), "provider": .string(task.provider), "context_pending": .bool(true)]),
            "handoff_context": .string(context), "isolation": .string("project_folder")
        ]))
        guard store.selectedTaskID == task.id else { throw CancellationError() }
        await ConversationActions.adopt(store, result: result)
    }
    func saveExport(partial: Bool) {
        let title = store.selectedTask?.title ?? "Conversation"
        let content = ConversationExport.markdown(store.messages, title: title, partial: partial)
        let panel = NSSavePanel(); panel.allowedContentTypes = [.plainText]; panel.nameFieldStringValue = title.replacingOccurrences(of: "/", with: "-") + ".md"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do { try content.write(to: url, atomically: true, encoding: .utf8) }
            catch { store.errorMessage = error.localizedDescription }
        }
    }
}

struct ConversationActionEditor: View {
    let title: String
    let description: String
    let fieldLabel: String
    let value: String
    let allowsEmpty: Bool
    var acceptsInput = true
    let perform: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var pending = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(NativePreferences.shared.font(size: 19, weight: .semibold))
            if !description.isEmpty { Text(description).font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted) }
            if acceptsInput { TextField(fieldLabel, text: $text, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(2...8) }
            if let error { Text(error).font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.warning) }
            HStack { Spacer(); Button("Cancel") { dismiss() }; Button(pending ? "Working…" : "Continue") {
                pending = true; error = nil
                Task { defer { pending = false }; do { try await perform(text.trimmingCharacters(in: .whitespacesAndNewlines)); dismiss() } catch { self.error = error.localizedDescription } }
            }.keyboardShortcut(.defaultAction).disabled(pending || (!allowsEmpty && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) }
        }.padding(24).frame(width: 480).onAppear { text = value }
    }
}
