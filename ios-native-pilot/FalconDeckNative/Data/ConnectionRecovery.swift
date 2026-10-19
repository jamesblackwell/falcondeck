import Foundation

@MainActor extension AppModel {
    func setForeground(_ active: Bool) {
        guard active != foreground else { return }
        foreground = active
        Task { await relay.setForeground(active) }
        if active {
            synchronizePush()
            taskActivity.reconcileDismissal()
            synchronizeTaskActivity()
            if hasSession && !demo && !restoringSession, foregroundRefresh == nil {
                foregroundRefresh = Task {
                    defer { self.foregroundRefresh = nil }
                    if self.connected { await self.refresh() } else { await self.reconnect() }
                }
            }
        } else { reconnectTask?.cancel(); reconnectTask = nil }
    }

    /// Capture input before yielding to another scene, connection or edit.
    /// Inactive interruptions (permission dialogs, Control Center) do not flush
    /// or trigger a second batch. iOS gets its assertion before async disk I/O.
    func saveBeforeSuspension() {
        guard !demo else { return }
        let lease = backgroundExecution.begin("Save native input and preview")
        let current = sessionScope, store = draftStore, cache = sessionCache
        for work in draftSaves.values { work.cancel() }; draftSaves = [:]
        previewSave?.cancel(); previewSave = nil
        let drafts = chats.map { $0.value.saved(id: $0.key) }, preferences = composerPreferences
        let preview = cache == nil ? nil : previewInput()
        let selection: Destination? = {
            switch self.selection { case .task, .draft, .projects: self.selection; default: nil }
        }()
        let previous = backgroundSave
        let revision = InputWriteRevision.next()
        let saveID = UUID(); backgroundSaveID = saveID
        backgroundSave = Task {
            defer { lease.finish(); if saveID == self.backgroundSaveID { self.backgroundSave = nil } }
            await previous?.value
            do {
                if let store {
                    try await store.saveInputs(drafts, preferences: preferences, revision: revision)
                    if let selection { try await store.saveSelection(selection, revision: revision) }
                }
                if !lease.expired, let cache, let preview { try await cache.save(preview) }
            } catch {
                if current == self.sessionScope { self.error = "Couldn't save local input: \(error.localizedDescription)" }
            }
            await self.taskActivity.settle()
        }
    }
    func scheduleReconnect() {
        guard hasSession, !demo, foreground, networkAvailable, reconnectTask == nil else { return }
        let delay = ReconnectDelay.seconds(attempt: reconnectAttempt)
        reconnectAttempt += 1
        reconnectTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self else { return }
            self.reconnectTask = nil
            guard !self.connected, self.foreground, self.networkAvailable else { return }
            await self.reconnect()
        }
    }

}
