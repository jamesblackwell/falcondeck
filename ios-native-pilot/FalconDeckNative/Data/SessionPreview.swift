import Foundation

@MainActor extension AppModel {
    func restorePreview() async {
        let current = connectionID
        guard !demo, let session = try? sessionLoader(), let store = try? SessionCacheStore(session: session, root: sessionCacheRoot) else { return }
        let preview = await store.load()
        guard current == connectionID, !demo else { return }
        sessionCache = store
        schedulePreviewSave()
        guard let preview, !hasLiveSnapshot else { return }
        projects = preview.projects.map(Project.init)
        tasks = preview.tasks.map(AgentTask.init)
        previewTaskIDs = Set(tasks.map(\.id))
        preferences = preview.preferences
        cachedAt = preview.savedAt
        for (id, history) in preview.histories {
            guard let task = task(id) else { continue }
            let chat = chat(for: task)
            chat.transcript = Transcript(items: history.items.map(Message.init))
            chat.loaded = true; chat.needsRefresh = true
            chat.hasOlder = history.hasOlder; chat.oldestID = chat.transcript.items.first?.id
        }
        if let pendingSelection {
            switch pendingSelection {
            case .task(let id) where task(id) != nil: selection = pendingSelection; self.pendingSelection = nil
            case .draft(let id, _) where projects.contains(where: { $0.id == id }): selection = pendingSelection; self.pendingSelection = nil
            default: break
            }
        }
    }

    /// Throttle rather than debounce: frequent metadata updates should neither
    /// encrypt on every token nor postpone saving forever during a long turn.
    func schedulePreviewSave() {
        guard !demo, hasLiveSnapshot, sessionCache != nil, previewSave == nil else { return }
        previewSave = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            guard let self else { return }
            self.previewSave = nil
            await self.savePreview()
        }
    }

    func savePreview() async {
        previewSave?.cancel(); previewSave = nil
        guard !demo, hasLiveSnapshot, let store = sessionCache else { return }
        let selected: String? = { if case .task(let id) = selection { return id }; return nil }()
        // Copy only bounded tails here. Encoding/encryption belongs to the
        // cache actor, away from navigation, live tokens and prompt input.
        let ordered = tasks.sorted { lhs, rhs in
            if (lhs.id == selected) != (rhs.id == selected) { return lhs.id == selected }
            return lhs.updatedAt > rhs.updatedAt
        }
        var histories: [String: CachedHistory] = [:]
        for task in ordered {
            guard histories.count < 5 else { break }
            guard let chat = chats[task.id], chat.loaded, !chat.needsRefresh, !chat.transcript.needsRecovery else { continue }
            histories[task.id] = CachedHistory(items: chat.transcript.items.suffix(150).map(\.raw), hasOlder: chat.hasOlder || chat.transcript.items.count > 150)
        }
        let input = SessionCacheInput(projects: projects.map(\.raw), tasks: tasks.map(\.raw), preferences: preferences, selectedID: selected, histories: histories)
        try? await store.save(input)
    }
}
