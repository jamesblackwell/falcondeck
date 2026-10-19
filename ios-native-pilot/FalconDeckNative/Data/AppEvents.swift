import Foundation

/// Relay coalescing can advance a text delta's sequence without moving its
/// queue slot. Deduplicate deliveries, rather than rejecting every event below
/// a global high-water mark (which would lose unrelated summaries and items).
struct RecentEventSequences {
    private var seen: Set<Int> = []
    private var ring: [Int] = []
    private var next = 0
    private let capacity = 8192

    mutating func insert(_ sequence: Int) -> Bool {
        guard seen.insert(sequence).inserted else { return false }
        if ring.count < capacity { ring.append(sequence) }
        else {
            seen.remove(ring[next]); ring[next] = sequence
            next = (next + 1) % capacity
        }
        return true
    }
}

@MainActor extension AppModel {
    func receive(_ update: RelayUpdate) {
        guard update.connectionID == connectionID, !demo else { return }
        switch update.event {
        case .status(let text, let online):
            let reconnected = online && !connected
            status = text; connected = online
            // Visible composers retry through their connection-scoped task.
            // Do not leave a failed request latched across a daemon reconnect.
            if reconnected { for catalog in composerCatalogs.values { catalog.modelsError = nil } }
            if connectionLog.last?.message != text { connectionLog.append(ConnectionLogEntry(message: text)); if connectionLog.count > 100 { connectionLog.removeFirst(connectionLog.count - 100) } }
            if online { reconnectAttempt = 0; reconnectTask?.cancel(); reconnectTask = nil; automations.scheduleRefresh(model: self); synchronizePush(); Task { await self.extensions.load(model: self); await self.openPendingNotification() } }
            if text == "Connecting…" { receivedEventSequences = RecentEventSequences() }
            synchronizeTaskActivity()
        case .snapshot(let value):
            if pairingPending { pairingPending = false; hasSession = true; showConnection = false }
            summaryFlush?.cancel(); summaryFlush = nil; pendingSummaries = [:]
            projects = value["workspaces"].array.filter { $0["kind"].string != "scratch" }.map(Project.init)
            let incoming = value["threads"].array.filter { !$0["is_archived"].bool }.map(AgentTask.init)
            previewTaskIDs.subtract(incoming.map(\.id))
            let selected: String? = { if case .task(let id) = selection { return id }; return nil }()
            if !value["native_sync"]["token"].string.isEmpty {
                var index = CompactSync(token: value["native_sync"]["token"].string, counts: value["native_sync"]["counts"])
                // A disk preview cannot overrule authoritative incoming rows,
                // even if its cached sequence belongs to an older daemon run.
                let liveIDs = Set(incoming.map(\.id))
                let previous = !hasLiveSnapshot && cachedAt != nil ? tasks.filter { !liveIDs.contains($0.id) } : tasks
                tasks = index.retain(incoming, previous: previous, projectIDs: Set(projects.map(\.id)), hidden: Set(value["preferences"]["hidden_workspace_ids"].array.map(\.string)), selected: selected)
                syncIndex = index; taskPageLoads = []
            } else { tasks = incoming; syncIndex = nil; taskPageLoads = [] }
            previewTaskIDs.formIntersection(tasks.map(\.id)); previewTaskIDs.subtract(incoming.map(\.id))
            extensions.setBase(value["extensions"], token: syncIndex?.token)
            if connected { Task { await self.extensions.load(model: self) } }
            preferences = value["preferences"]
            requests = value["interactive_requests"].array
            serviceNotices = value["service_notices"].array
            operationalConditions = value["operational_conditions"].array
            tokenUsage = value["thread_token_usage"] == .null ? .object([:]) : value["thread_token_usage"]
            hasLiveSnapshot = true
            synchronizePush()
            schedulePreviewSave()
            refreshedAt = .now; error = nil; demo = false
            Task { await self.openPendingNotification() }
            if let pendingSelection {
                switch pendingSelection {
                case .task(let id): if task(id) != nil { selection = pendingSelection; self.pendingSelection = nil }
                case .draft(let id, _): if projects.contains(where: { $0.id == id }) { selection = pendingSelection; self.pendingSelection = nil }
                default: self.pendingSelection = nil
                }
            }
            synchronizeTaskActivity()
        case .events(let events):
            for event in events { applyEnvelope(event) }
        case .rebase(let events):
            for event in events { applyEnvelope(event, rebase: true) }
        case .error(let message):
            if claimingPairing { pairingNeedsReconnect = true }
            error = message; connected = false; scheduleReconnect()
            connectionLog.append(ConnectionLogEntry(message: "Connection request failed"))
            if connectionLog.count > 100 { connectionLog.removeFirst(connectionLog.count - 100) }
            synchronizeTaskActivity()
        }
    }

    func upsertTask(_ raw: JSON) {
        upsertTasks([raw])
    }

    /// Publish a page/burst once, rebuilding the sidebar's task groups once
    /// rather than once for every row in the response.
    func upsertTasks(_ rows: [JSON]) {
        guard !rows.isEmpty else { return }
        var active = tasks, archived = archivedTasks
        for raw in rows {
            guard !raw["id"].string.isEmpty else { continue }
            let task = AgentTask(raw)
            let current = pendingSummaries[task.id] ?? active.first(where: { $0.id == task.id })?.raw ?? archived.first(where: { $0.id == task.id })?.raw
            if let current, !previewTaskIDs.contains(task.id), TaskSummaryOrder.isStale(raw, comparedTo: current) { continue }
            if archivedLoadID != nil { archivedTouched.insert(task.id) }
            previewTaskIDs.remove(task.id)
            chats[task.id]?.reconcileSettings(task)
            if task.archived {
                active.removeAll { $0.id == task.id }
                if let index = archived.firstIndex(where: { $0.id == task.id }) { archived[index] = task } else { archived.append(task) }
            } else {
                archived.removeAll { $0.id == task.id }
                if let index = active.firstIndex(where: { $0.id == task.id }) { active[index] = task } else { active.append(task) }
            }
        }
        if active != tasks { tasks = active }
        if archived != archivedTasks { archivedTasks = archived }
        schedulePreviewSave()
    }

    func applyEnvelope(_ envelope: JSON, rebase: Bool = false) {
        guard !demo, let seq = envelope["seq"].optionalInt, rebase || receivedEventSequences.insert(seq) else { return }
        let event = envelope["event"], id = envelope["thread_id"].string
        if !rebase, !voice.starting, !voice.recording, !voice.transcribing, readAloud.messageID == nil { realtimeAudio.handle(event, taskID: id) }
        switch event["type"].string {
        case "thread-started", "thread-updated":
            let raw = event["thread"]
            let old = pendingSummaries[id] ?? tasks.first(where: { $0.id == id })?.raw ?? .null
            if !rebase, old["status"].string == "running", ["idle", "error"].contains(raw["status"].string), (!foreground ? !push.registered : selection != .task(id)), preferences["notifications"]["enabled"] != .bool(false) {
                let failed = raw["status"].string == "error"
                if preferences["notifications"][failed ? "notify_on_error" : "notify_on_turn_complete"] != .bool(false) {
                    announceTask(title: raw["title"].string.nonempty ?? "FalconDeck", body: failed ? raw["last_error"].string : raw["last_message_preview"].string.nonempty ?? "Task completed", taskID: id, workspaceID: raw["workspace_id"].string)
                }
            }
            stageSummary(raw)
        case "service":
            let notice = event["notice"]
            if notice != .null { serviceNotices.removeAll { $0["id"] == notice["id"] }; serviceNotices.append(notice); if serviceNotices.count > 100 { serviceNotices.removeFirst(serviceNotices.count - 100) } }
        case "operational-condition-upserted":
            let condition = event["condition"]
            operationalConditions.removeAll { $0["key"] == condition["key"] }; operationalConditions.append(condition)
        case "operational-condition-cleared": operationalConditions.removeAll { $0["key"] == event["key"] && $0["id"] == event["condition_id"] }
        case "thread-token-usage-updated": if !id.isEmpty { tokenUsage = tokenUsage.setting(id, event["usage"]) }
        case "extension-catalog-updated", "extension-view-updated": extensions.apply(event)
        case "control-state-changed": automations.scheduleRefresh(model: self)
        case "workspace-updated":
            let project = Project(event["workspace"])
            if let index = projects.firstIndex(where: { $0.id == project.id }) { projects[index] = project }
            else { projects.append(project) }
            schedulePreviewSave()
            synchronizeTaskActivity()
        case "preferences-updated": preferences = event["preferences"]
        case "interactive-request":
            let request = event["request"]
            if !rebase, !requests.contains(where: { $0["request_id"] == request["request_id"] }), (!foreground ? !push.registered : selection != .task(id)), preferences["notifications"]["enabled"] != .bool(false), preferences["notifications"]["notify_on_input_required"] != .bool(false) {
                announceTask(title: "Input needed", body: request["title"].string, taskID: id, workspaceID: request["workspace_id"].string)
            }
            requests.removeAll { $0["request_id"] == request["request_id"] }; requests.append(request)
        case "turn-end":
            schedulePreviewSave()
            // ThreadUpdated carries the authoritative status, including errors
            // and transient retries that remain running after a turn-end.
            if event["status"].string != "running" { requests.removeAll { $0["thread_id"].string == id } }
        case "conversation-item-updated", "conversation-item-added":
            let item = event["item"]
            let cacheKey = "\(connectionID):\(id):\(item["id"].string)"
            itemCache.removeValue(forKey: cacheKey); itemCacheOrder.removeAll { $0 == cacheKey }
            itemLoads.removeValue(forKey: cacheKey)
            if item["kind"].string == "interactive_request", item["resolved"].bool {
                requests.removeAll { $0["request_id"] == item["request"]["request_id"] }
            }
        default: break
        }
        if !rebase, let chat = chats[id] {
            chat.outgoingMessage?.observe(event)
            if chat.loading {
                if chat.bufferedEvents.count < 2048 { chat.bufferedEvents.append(event) }
                else { chat.bufferOverflowed = true }
            }
            chat.transcript.apply(event)
            chat.settleSubmission(queued: tasks.first(where: { $0.id == id })?.queued ?? [])
            if chat.outgoingMessage?.needsHistoryRecheck == true, let task = task(id) { recheckOutgoingHistory(task, chat: chat) }
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
        if let current, (pendingSummaries[id] != nil || !previewTaskIDs.contains(id)), TaskSummaryOrder.isStale(raw, comparedTo: current) { return }
        syncIndex?.touched.insert(id)
        pendingSummaries[id] = raw
        guard summaryFlush == nil else { return }
        // Keep transcript tokens immediate; coalesce sidebar metadata so a
        // busy task doesn't rebuild thousands of sidebar rows per token.
        summaryFlush = Task {
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
            let updates = self.pendingSummaries
            self.pendingSummaries = [:]; self.summaryFlush = nil
            self.upsertTasks(Array(updates.values))
        }
    }

}
