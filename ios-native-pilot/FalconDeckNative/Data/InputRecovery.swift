import Foundation

@MainActor extension AppModel {
    func restoreInputs() async {
        let current = connectionID, loader = sessionLoader
        let session = await Task.detached { try? loader() }.value
        guard current == connectionID else { return }
        await restoreInputs(session: session)
    }
    func restoreInputs(session: SavedSession?) async {
        let current = connectionID
        guard !demo, let session else { return }
        do {
            let root = inputDraftRoot
            let store = try await Task.detached { try DraftStore(session: session, root: root) }.value
            let drafts = try await store.load()
            let unreadable = await store.unreadableDraftCount
            let preferences = (try? await store.loadComposerPreferences()) ?? [:]
            let selection: Destination?
            var selectionFailed = false
            do { selection = try await store.loadSelection() }
            catch { selection = nil; selectionFailed = true }
            guard current == connectionID, !demo else { return }
            if selectionFailed { error = "Saved navigation couldn't be read. Your input has been restored." }
            draftStore = store; savedDrafts = Dictionary(drafts.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            composerPreferences = preferences
            pendingSelection = selection
            if case .task(let id) = pendingSelection { await relay.selectThread(id) }
            guard current == connectionID, !demo else { return }
            if unreadable > 0 { error = "Some saved input couldn't be read. Other drafts have been restored." }
        } catch { if current == connectionID, !demo { self.error = "Input recovery failed: \(error.localizedDescription)" } }
    }
    func scheduleInputSave(_ id: String, chat: ChatSession) {
        guard !demo, let store = draftStore else { return }
        draftSaves[id]?.cancel()
        draftSaves[id] = Task { [weak self, weak chat] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard let self, let chat, self.chats[id] === chat, self.draftStore === store else { return }
            self.draftSaves.removeValue(forKey: id)
            do {
                let preferences = self.composerPreferences
                let draft = chat.saved(id: id)
                try await store.saveInputs([draft], preferences: preferences, revision: draft.writeRevision)
            }
            catch { if self.chats[id] === chat, self.draftStore === store { chat.error = "Couldn't save input on this device: \(error.localizedDescription)" } }
        }
    }
    func saveAllInputs() async {
        guard !demo, let store = draftStore else { return }
        for task in draftSaves.values { task.cancel() }; draftSaves = [:]
        let values = chats.map { $0.value.saved(id: $0.key) }
        let preferences = composerPreferences, current = sessionScope
        let revision = InputWriteRevision.next()
        do {
            try await store.saveInputs(values, preferences: preferences, revision: revision)
        }
        catch { if current == sessionScope { self.error = "Couldn't save input on this device: \(error.localizedDescription)" } }
    }

}
