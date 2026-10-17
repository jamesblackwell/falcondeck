import Foundation

struct TaskPageScope: Hashable {
    let projectID: String
    var folderID: String? = nil
    func key(sort: String) -> String { CompactSync.key(project: projectID, folder: folderID, sort: sort) }
}

struct TaskPagePlan: Hashable {
    let connectionID: UUID
    let token: String?
    let connected: Bool
    let sort: String
    let scopes: [TaskPageScope]
}

struct CompactSync {
    let token: String
    let counts: JSON
    var cursors: [String: JSON] = [:]
    var touched: Set<String> = []
    var carried: Set<String> = []
    static func expand(_ index: JSON) throws -> JSON {
        guard !index["token"].string.isEmpty, case .array(let agents) = index["agent_catalogs"], case .array(let models) = index["model_catalogs"] else { throw PilotError("Invalid compact project index.") }
        let workspaces = try index["snapshot"]["workspaces"].array.map { workspace in
            let id = workspace["id"].string
            let catalogs = try index["workspace_agents"][id].array.map { reference in
                guard let position = reference.optionalInt, agents.indices.contains(position) else { throw PilotError("Missing agent catalog in project index.") }
                return agents[position]
            }
            let model = index["workspace_models"][id].optionalInt
            return workspace.setting("agents", .array(catalogs)).setting("models", model.flatMap { models.indices.contains($0) ? models[$0] : nil } ?? .array([]))
        }
        return index["snapshot"].setting("workspaces", .array(workspaces)).setting("native_sync", .object(["token": index["token"], "counts": index["counts"]]))
    }
    mutating func retain(_ incoming: [AgentTask], previous: [AgentTask], projectIDs: Set<String>, hidden: Set<String>, selected: String?) -> [AgentTask] {
        let ids = Set(incoming.map(\.id))
        let retained = previous.filter { !ids.contains($0.id) && !$0.archived && projectIDs.contains($0.projectID) && (!hidden.contains($0.projectID) || $0.id == selected) && counts[$0.projectID]["total"].int > 0 }
        carried = Set(retained.map(\.id))
        return incoming.map { row in
            guard let old = previous.first(where: { $0.id == row.id }) else { return row }
            if TaskSummaryOrder.isStale(row.raw, comparedTo: old.raw) { touched.insert(old.id); return old }
            return Self.hydrated(row, previous: old)
        } + retained
    }
    /// A projected row intentionally omits these large fields. Keep a hydrated
    /// copy only when the timestamp proves it belongs to the same summary.
    static func hydrated(_ row: AgentTask, previous: AgentTask) -> AgentTask {
        guard AutomationDraft.parseDate(row.updatedAt) == AutomationDraft.parseDate(previous.updatedAt) else { return row }
        var raw = row.raw
        for key in ["goal", "queued_turns", "last_error", "latest_plan", "latest_diff", "native_session_id"] {
            if row.raw[key] == .null || row.raw[key] == .array([]) { raw = raw.setting(key, previous.raw[key]) }
        }
        return AgentTask(raw)
    }
    static func key(project: String, folder: String?, sort: String = "last_updated") -> String { project + ":" + (folder.map { "folder:\($0):" } ?? "") + sort }
}

@MainActor extension AppModel {
    /// One initial page per visible scope, serially. Reopening a section does
    /// not fetch another page; a fresh index token does restart initial loads.
    func loadInitialTaskPages(_ plan: TaskPagePlan) async {
        for scope in plan.scopes {
            guard !Task.isCancelled, plan.connected, connected, connectionID == plan.connectionID, let index = syncIndex, index.token == plan.token else { return }
            if index.cursors[scope.key(sort: plan.sort)] == nil, hasMoreTasks(scope.projectID, folderID: scope.folderID, sort: plan.sort) {
                await loadTaskPage(scope.projectID, folderID: scope.folderID, sort: plan.sort)
            }
        }
    }

    func loadTaskPage(_ projectID: String, folderID: String? = nil, sort: String = "last_updated", limit: Int = 10) async {
        guard let state = syncIndex, !demo, connected else { return }
        let key = CompactSync.key(project: projectID, folder: folderID, sort: sort)
        guard state.cursors[key] != .null, !taskPageLoads.contains(key) else { return }
        taskPageLoads.insert(key)
        let current = connectionID, token = state.token
        defer { if current == connectionID, syncIndex?.token == token { taskPageLoads.remove(key) } }
        do {
            var params = JSON.object(["token": .string(token), "workspace_id": .string(projectID), "cursor": state.cursors[key] ?? .number(0), "sort": .string(sort), "limit": .number(Double(folderID == nil ? max(1, min(50, limit)) : 50))])
            if let folderID { params = params.setting("folder_id", .string(folderID)) }
            // A view can disappear while another visible scope still needs
            // this same read. Connection/index checks own its result lifetime.
            let page = try await Task { try await relay.call("sync.threads", params: params) }.value
            // A collapsed/reopened scope may cancel its view task while this
            // read is in flight. Its valid page still belongs to this index.
            guard current == connectionID, var index = syncIndex, index.token == token, page["token"].string == token else { return }
            let rows = page["threads"].array.map(AgentTask.init)
            guard page["workspace_id"].string == projectID, rows.allSatisfy({ $0.projectID == projectID }) else { throw PilotError("Project page scope did not match.") }
            let accepted = rows.filter { !index.touched.contains($0.id) && (task($0.id) == nil || index.carried.contains($0.id)) }
            upsertTasks(accepted.map(\.raw))
            for row in rows {
                index.carried.remove(row.id)
            }
            if folderID == nil, page["next_cursor"] == .null {
                let remove = index.carried.filter { id in !index.touched.contains(id) && task(id)?.projectID == projectID }
                tasks.removeAll { remove.contains($0.id) }; index.carried.subtract(remove)
            }
            index.cursors[key] = page["next_cursor"]; syncIndex = index
        } catch {
            guard current == connectionID, syncIndex?.token == token else { return }
            if error.localizedDescription.contains("sync_index_expired") { await relay.refresh() }
            else { self.error = error.localizedDescription }
        }
    }
    func hasMoreTasks(_ projectID: String, folderID: String? = nil, sort: String = "last_updated") -> Bool {
        guard let index = syncIndex, index.counts[projectID]["total"].int > 0 else { return false }
        return index.cursors[CompactSync.key(project: projectID, folder: folderID, sort: sort)] != .null
    }
}
