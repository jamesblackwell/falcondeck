import Foundation

@MainActor extension AppModel {
    func receive(_ update: RelayUpdate) {
        guard update.connectionID == connectionID, !demo else { return }
        switch update.event {
        case .status(let text, let online):
            status = text; connected = online
            if connectionLog.last?.message != text { connectionLog.append(ConnectionLogEntry(message: text)); if connectionLog.count > 100 { connectionLog.removeFirst(connectionLog.count - 100) } }
            if online { reconnectAttempt = 0; reconnectTask?.cancel(); reconnectTask = nil; automations.scheduleRefresh(model: self); Task { await self.extensions.load(model: self) } }
            if text == "Connecting…" { lastEventSeq = 0 }
        case .snapshot(let value):
            summaryFlush?.cancel(); summaryFlush = nil; pendingSummaries = [:]
            projects = value["workspaces"].array.filter { $0["kind"].string != "scratch" }.map(Project.init)
            let incoming = value["threads"].array.filter { !$0["is_archived"].bool }.map(AgentTask.init)
            let selected: String? = { if case .task(let id) = selection { return id }; return nil }()
            if !value["native_sync"]["token"].string.isEmpty {
                var index = CompactSync(token: value["native_sync"]["token"].string, counts: value["native_sync"]["counts"])
                tasks = index.retain(incoming, previous: tasks, projectIDs: Set(projects.map(\.id)), hidden: Set(value["preferences"]["hidden_workspace_ids"].array.map(\.string)), selected: selected)
                syncIndex = index; taskPageLoads = []
            } else { tasks = incoming; syncIndex = nil; taskPageLoads = [] }
            extensions.setBase(value["extensions"], token: syncIndex?.token)
            if connected { Task { await self.extensions.load(model: self) } }
            preferences = value["preferences"]
            requests = value["interactive_requests"].array
            refreshedAt = .now; error = nil; demo = false
            if let pendingSelection {
                switch pendingSelection {
                case .task(let id): if task(id) != nil { selection = pendingSelection; self.pendingSelection = nil }
                case .draft(let id, _): if projects.contains(where: { $0.id == id }) { selection = pendingSelection; self.pendingSelection = nil }
                default: self.pendingSelection = nil
                }
            }
        case .events(let events):
            for event in events { applyEnvelope(event) }
        case .rebase(let events):
            for event in events { applyEnvelope(event, rebase: true) }
        case .error(let message):
            error = message; connected = false; scheduleReconnect()
            connectionLog.append(ConnectionLogEntry(message: "Connection request failed"))
            if connectionLog.count > 100 { connectionLog.removeFirst(connectionLog.count - 100) }
        }
    }

    func upsertTask(_ raw: JSON) {
        guard !raw["id"].string.isEmpty else { return }
        let task = AgentTask(raw)
        let current = pendingSummaries[task.id] ?? tasks.first(where: { $0.id == task.id })?.raw ?? archivedTasks.first(where: { $0.id == task.id })?.raw
        if let current, TaskSummaryOrder.isStale(raw, comparedTo: current) { return }
        if task.archived {
            tasks.removeAll { $0.id == task.id }
            if let index = archivedTasks.firstIndex(where: { $0.id == task.id }) { archivedTasks[index] = task } else { archivedTasks.append(task) }
            return
        }
        archivedTasks.removeAll { $0.id == task.id }
        if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index] = task }
        else { tasks.append(task) }
    }

    func applyEnvelope(_ envelope: JSON, rebase: Bool = false) {
        guard !demo, let seq = envelope["seq"].optionalInt, rebase || seq > lastEventSeq else { return }
        if !rebase { lastEventSeq = seq }
        let event = envelope["event"], id = envelope["thread_id"].string
        switch event["type"].string {
        case "thread-started", "thread-updated":
            let raw = event["thread"]
            let old = pendingSummaries[id] ?? tasks.first(where: { $0.id == id })?.raw ?? .null
            if !rebase, old["status"].string == "running", ["idle", "error"].contains(raw["status"].string), (!foreground || selection != .task(id)), preferences["notifications"]["enabled"] != .bool(false) {
                let failed = raw["status"].string == "error"
                if preferences["notifications"][failed ? "notify_on_error" : "notify_on_turn_complete"] != .bool(false) {
                    notifications.announce(title: raw["title"].string.nonempty ?? "FalconDeck", body: failed ? raw["last_error"].string : raw["last_message_preview"].string.nonempty ?? "Task completed", taskID: id)
                }
            }
            stageSummary(raw)
        case "extension-catalog-updated", "extension-view-updated": extensions.apply(event)
        case "control-state-changed": automations.scheduleRefresh(model: self)
        case "workspace-updated":
            let project = Project(event["workspace"])
            if let index = projects.firstIndex(where: { $0.id == project.id }) { projects[index] = project }
            else { projects.append(project) }
        case "preferences-updated": preferences = event["preferences"]
        case "interactive-request":
            let request = event["request"]
            if !rebase, !requests.contains(where: { $0["request_id"] == request["request_id"] }), (!foreground || selection != .task(id)), preferences["notifications"]["enabled"] != .bool(false), preferences["notifications"]["notify_on_input_required"] != .bool(false) {
                notifications.announce(title: "Input needed", body: request["title"].string, taskID: id)
            }
            requests.removeAll { $0["request_id"] == request["request_id"] }; requests.append(request)
        case "turn-end":
            // ThreadUpdated carries the authoritative status, including errors
            // and transient retries that remain running after a turn-end.
            if event["status"].string != "running" { requests.removeAll { $0["thread_id"].string == id } }
        case "conversation-item-updated", "conversation-item-added":
            let item = event["item"]
            let cacheKey = "\(connectionID):\(id):\(item["id"].string)"
            itemCache.removeValue(forKey: cacheKey); itemCacheOrder.removeAll { $0 == cacheKey }
            if item["kind"].string == "interactive_request", item["resolved"].bool {
                requests.removeAll { $0["request_id"] == item["request"]["request_id"] }
            }
        default: break
        }
        if !rebase, let chat = chats[id] {
            if chat.loading {
                if chat.bufferedEvents.count < 2048 { chat.bufferedEvents.append(event) }
                else { chat.bufferOverflowed = true }
            }
            chat.transcript.apply(event)
            chat.settleSubmission(queued: tasks.first(where: { $0.id == id })?.queued ?? [])
            if !chat.pendingQueue.isEmpty {
                chat.pendingQueue = QueuedDraft.reconcile(chat.pendingQueue, queued: tasks.first(where: { $0.id == id })?.queued ?? [], items: chat.transcript.items)
            }
            if chat.transcript.needsRecovery, !chat.loading, let task = tasks.first(where: { $0.id == id }) {
                Task { await self.loadChat(task) }
            }
        }
    }

    func stageSummary(_ raw: JSON) {
        let id = raw["id"].string
        guard !id.isEmpty else { return }
        let current = pendingSummaries[id] ?? tasks.first(where: { $0.id == id })?.raw ?? archivedTasks.first(where: { $0.id == id })?.raw
        if let current, TaskSummaryOrder.isStale(raw, comparedTo: current) { return }
        syncIndex?.touched.insert(id)
        pendingSummaries[id] = raw
        guard summaryFlush == nil else { return }
        // Keep transcript tokens immediate; coalesce sidebar metadata so a
        // busy task doesn't rebuild thousands of sidebar rows per token.
        summaryFlush = Task {
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
            let updates = self.pendingSummaries
            self.pendingSummaries = [:]; self.summaryFlush = nil
            for (_, raw) in updates { self.upsertTask(raw) }
        }
    }

}
