import Foundation

@MainActor extension AppModel {
    func restoreInputs() async {
        guard let session = try? sessionLoader() else { return }
        do {
            let store = try DraftStore(session: session)
            let drafts = try await store.load()
            let unreadable = await store.unreadableDraftCount
            draftStore = store; savedDrafts = Dictionary(drafts.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            composerPreferences = (try? await store.loadComposerPreferences()) ?? [:]
            pendingSelection = try await store.loadSelection()
            if case .task(let id) = pendingSelection { await relay.selectThread(id) }
            if unreadable > 0 { error = "Some saved input couldn't be read. Other drafts have been restored." }
        } catch { self.error = "Input recovery failed: \(error.localizedDescription)" }
    }
    func scheduleInputSave(_ id: String, chat: ChatSession) {
        guard !demo, let store = draftStore else { return }
        draftSaves[id]?.cancel()
        draftSaves[id] = Task { [weak self, weak chat] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard let self, let chat, self.chats[id] === chat else { return }
            self.draftSaves.removeValue(forKey: id)
            do {
                let preferences = self.composerPreferences
                try await store.save(chat.saved(id: id))
                try await store.saveComposerPreferences(preferences)
            }
            catch { chat.error = "Couldn't save input on this device: \(error.localizedDescription)" }
        }
    }
    func saveAllInputs() async {
        guard !demo, let store = draftStore else { return }
        for task in draftSaves.values { task.cancel() }; draftSaves = [:]
        let values = chats.map { $0.value.saved(id: $0.key) }
        let preferences = composerPreferences
        do {
            for value in values { try await store.save(value) }
            try await store.saveComposerPreferences(preferences)
        }
        catch { self.error = "Couldn't save input on this device: \(error.localizedDescription)" }
    }

}
