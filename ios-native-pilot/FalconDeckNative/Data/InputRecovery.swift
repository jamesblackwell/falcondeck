import Foundation

@MainActor extension AppModel {
    func restoreInputs() async {
        guard let session = try? sessionLoader() else { return }
        do {
            let store = try DraftStore(session: session)
            let drafts = try await store.load()
            draftStore = store; savedDrafts = Dictionary(drafts.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            pendingSelection = try await store.loadSelection()
            if case .task(let id) = pendingSelection { await relay.selectThread(id) }
        } catch { self.error = "Input recovery failed: \(error.localizedDescription)" }
    }
    func scheduleInputSave(_ id: String, chat: ChatSession) {
        guard !demo, let store = draftStore else { return }
        draftSaves[id]?.cancel()
        draftSaves[id] = Task { [weak self, weak chat] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard let self, let chat, self.chats[id] === chat else { return }
            self.draftSaves.removeValue(forKey: id)
            do { try await store.save(chat.saved(id: id)) }
            catch { chat.error = "Couldn't save input on this device: \(error.localizedDescription)" }
        }
    }
    func saveAllInputs() async {
        guard !demo, let store = draftStore else { return }
        for task in draftSaves.values { task.cancel() }; draftSaves = [:]
        let values = chats.map { $0.value.saved(id: $0.key) }
        do { for value in values { try await store.save(value) } }
        catch { self.error = "Couldn't save input on this device: \(error.localizedDescription)" }
    }

}
