import Foundation

@MainActor extension AppModel {
    func send(_ task: AgentTask, textOverride: String? = nil, initialInput: SavedDraft? = nil) async {
        let current = connectionID
        let origin = conversationOrigin
        let chat = chat(for: task)
        let id = initialInput?.submission?.id ?? "user-\(UUID().uuidString)"
        var initialInputHandled = false
        defer {
            if let initialInput, !initialInputHandled {
                // A first send can be rejected before creating an optimistic
                // row (for example, if the connection dropped during creation).
                // Its source draft has already been consumed by the caller.
                restoreSubmission(task, chat: chat, id: id, text: initialInput.text, attachments: initialInput.attachments)
            }
        }
        let consumesComposer = textOverride == nil && initialInput == nil
        let recoversInput = consumesComposer || initialInput != nil
        let text = (initialInput?.text ?? textOverride ?? chat.draft).trimmingCharacters(in: .whitespacesAndNewlines)
        let selectedModel = initialInput?.modelID ?? chat.modelID, selectedEffort = initialInput?.effort ?? chat.effort
        let activeModel = AgentModel.resolve(models: effectiveModels(projectID: task.projectID, provider: task.provider), provider: task.provider, id: selectedModel)
        let turnSettings = NativeRequest.turnSettings(initialInput?.overrides ?? chat.overrides, task: task, model: activeModel)
        var selectedOverrides = initialInput?.overrides ?? chat.overrides
        if selectedOverrides["service_tier"] != nil { selectedOverrides["service_tier"] = turnSettings["service_tier"] }
        let attachments = initialInput?.attachments ?? (consumesComposer ? chat.attachments : [])
        let recoveryText = recoversInput ? text : ""
        guard !task.isDraft || consumesComposer else { return }
        guard !text.isEmpty || !attachments.isEmpty, !chat.sending, !chat.preparingAttachments, demo || connected else { return }
        do {
            try NativeAttachment.validate(attachments)
            if !attachments.isEmpty, projects.first(where: { $0.id == task.projectID })?.capabilities(task.provider)["supports_images"] == .bool(false) { throw PilotError("This agent doesn't support image attachments.") }
        } catch { chat.error = error.localizedDescription; return }
        chat.sending = true; chat.error = nil; chat.notice = nil
        if task.isDraft {
            defer { chat.sending = false }
            let outgoing = OutgoingMessage(id: id, text: text, attachments: attachments)
            chat.outgoingMessage = outgoing
            chat.transcript.upsert(outgoing.item)
            chat.submission = outgoing.submission
            chat.draft = ""; chat.attachments = []
            do {
                guard let project = projects.first(where: { $0.id == task.projectID }) else { throw PilotError("Select a project first.") }
                var input = SavedDraft(id: task.id, text: text, attachments: attachments, modelID: selectedModel, effort: selectedEffort, provider: chat.provider, overrides: selectedOverrides)
                input.submission = outgoing.submission
                if let store = draftStore { try await store.save(chat.saved(id: task.id)) }
                guard current == connectionID else { restoreSubmission(task, chat: chat, id: id, text: text, attachments: attachments); return }
                let created = try await createTask(project: project, provider: input.provider, modelID: selectedModel, folderID: task.raw["folder_id"].string.nonempty, overrides: selectedOverrides, initialInput: input, outgoingMessage: outgoing, origin: origin)
                guard current == connectionID else { restoreSubmission(task, chat: chat, id: id, text: text, attachments: attachments); return }
                chat.transcript.items.removeAll { $0.id == id }
                chat.submission = nil; chat.outgoingMessage = nil
                // Submit the captured first input without consuming any newer
                // edits made through the new task's sidebar entry.
                await send(created, initialInput: input)
            } catch {
                restoreSubmission(task, chat: chat, id: id, text: text, attachments: attachments)
                if current == connectionID { chat.error = error.localizedDescription }
            }
            return
        }
        if recoversInput && (text == "/compact" || text.hasPrefix("/compact ")) {
            defer { chat.sending = false }
            chat.transcript.items.removeAll { $0.id == id && $0.raw["pending"].bool }
            if chat.outgoingMessage?.id == id { chat.outgoingMessage = nil }
            do {
                guard attachments.isEmpty else { throw PilotError("Remove attachments before compacting.") }
                try await compact(task, instructions: String(text.dropFirst(8)).trimmingCharacters(in: .whitespacesAndNewlines)); initialInputHandled = true
                if consumesComposer && chat.draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { chat.draft = "" } }
            catch { chat.error = error.localizedDescription }
            return
        }
        initialInputHandled = true
        let outgoing = chat.outgoingMessage.flatMap { $0.id == id ? $0 : nil } ?? OutgoingMessage(id: id, text: text, attachments: attachments)
        chat.outgoingMessage = outgoing
        let optimistic = outgoing.item
        let expectQueued = task.running || task.status == "waiting_for_input"
        let queued = QueuedDraft(id: id, text: text, attachmentCount: attachments.count, knownIDs: Set(task.queued.map { $0["id"].string }))
        if expectQueued { chat.pendingQueue.append(queued) }
        else if !chat.transcript.items.contains(where: { $0.id == id && !$0.raw["pending"].bool }) { chat.transcript.upsert(optimistic) }
        if recoversInput { chat.submission = SavedSubmission(id: id, text: text, attachments: attachments) }
        if consumesComposer { chat.draft = ""; chat.attachments = [] }
        if let store = draftStore {
            do {
                try await store.save(chat.saved(id: task.id))
                // Persist the new owner first, then retire the project-draft
                // recovery record, before any turn can reach the Mac.
                if let initialInput, initialInput.id != task.id, let source = chats[initialInput.id] {
                    try await store.save(source.saved(id: initialInput.id))
                }
            }
            catch { restoreSubmission(task, chat: chat, id: id, text: recoveryText, attachments: attachments); chat.error = "Couldn't save a recovery copy: \(error.localizedDescription)"; chat.sending = false; return }
        }
        guard current == connectionID else { restoreSubmission(task, chat: chat, id: id, text: recoveryText, attachments: attachments); chat.sending = false; return }
        defer { chat.sending = false }
        if demo {
            outgoing.phase = .accepted
            outgoing.observe(.object(["type": .string("turn-end")]))
            chat.pendingQueue.removeAll { $0.id == id }
            chat.transcript.upsert(Message(optimistic.raw.setting("pending", .bool(false))))
            if chat.submission?.id == id { chat.submission = nil }
            chat.transcript.upsert(Message(.object(["id": .string("demo-\(UUID())"), "kind": .string("assistant_message"), "text": .string(Demo.markdownReply)])))
            return
        }
        do {
            if !selectedOverrides.isEmpty {
                _ = try await taskRequest(task, method: "thread.update", fields: selectedOverrides)
                guard current == connectionID else { restoreSubmission(task, chat: chat, id: id, text: recoveryText, attachments: attachments); return }
            }
            if text.contains("/") { await loadCatalog(task) }
            guard current == connectionID else { restoreSubmission(task, chat: chat, id: id, text: recoveryText, attachments: attachments); return }
            let params = NativeRequest.turn(task: task, text: text, itemID: id, modelID: selectedModel, effort: selectedEffort, overrides: turnSettings, attachments: attachments).setting("selected_skills", .array(ComposerCatalog.selected(text, skills: catalog(task).skills)))
            let response = try await relay.call("turn.start", params: params)
            guard current == connectionID else { restoreSubmission(task, chat: chat, id: id, text: recoveryText, attachments: attachments); return }
            if response["message"].string == "queued" {
                outgoing.phase = .queued
                if chat.submission?.id == id { chat.submission = nil }
                chat.transcript.items.removeAll { $0.id == id && $0.raw["pending"].bool }
                if !expectQueued, !chat.transcript.items.contains(where: { $0.id == id && !$0.raw["pending"].bool }) { chat.pendingQueue.append(queued) }
                chat.pendingQueue = QueuedDraft.reconcile(chat.pendingQueue, queued: tasks.first(where: { $0.id == task.id })?.queued ?? [], items: chat.transcript.items)
            } else {
                outgoing.phase = .accepted
                recheckOutgoingHistory(task, chat: chat)
                if chat.submission?.id == id { chat.submission = nil }
                if expectQueued {
                    chat.pendingQueue.removeAll { $0.id == id }
                    if !chat.transcript.items.contains(where: { $0.id == id && !$0.raw["pending"].bool }) { chat.transcript.upsert(optimistic) }
                }
            }
        } catch {
            restoreSubmission(task, chat: chat, id: id, text: recoveryText, attachments: attachments)
            if chats[task.id] === chat { chat.error = "\(error.localizedDescription) Refresh this task before resending if delivery is uncertain." }
        }
    }

    func recheckOutgoingHistory(_ task: AgentTask, chat: ChatSession) {
        guard chats[task.id] === chat, let outgoing = chat.outgoingMessage,
              outgoing.phase == .accepted, outgoing.needsHistoryRecheck else { return }
        chat.needsRefresh = true
        guard !chat.loading, foreground, connected, selection == .task(task.id) else { return }
        outgoing.needsHistoryRecheck = false
        Task { [weak self, weak chat] in
            guard let self, let chat, self.chats[task.id] === chat, self.selection == .task(task.id), self.foreground else { return }
            await self.loadChat(self.task(task.id) ?? task)
        }
    }

    private func restoreSubmission(_ task: AgentTask, chat: ChatSession, id: String, text: String, attachments: [NativeAttachment]) {
        // Reconnect retains this session; forgetting/re-pairing replaces it.
        // Recover only into the original instance, never into a new computer.
        guard chats[task.id] === chat else { return }
        chat.pendingQueue.removeAll { $0.id == id }
        guard !chat.transcript.items.contains(where: { $0.id == id && !$0.raw["pending"].bool }) else { return }
        if chat.outgoingMessage?.id == id { chat.outgoingMessage = nil }
        chat.transcript.items.removeAll { $0.id == id && $0.raw["pending"].bool }
        if !text.isEmpty {
            if chat.draft.isEmpty { chat.draft = text }
            else if chat.draft != text { chat.draft = text + "\n\n" + chat.draft }
        }
        chat.attachments = attachments + chat.attachments.filter { newer in !attachments.contains { $0.id == newer.id } }
        if chat.submission?.id == id { chat.submission = nil }
        chat.notice = "Delivery wasn't confirmed. Refresh this task before sending again."
    }

}
