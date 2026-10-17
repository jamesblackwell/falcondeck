import Foundation

extension AgentTask {
    var archived: Bool { raw["is_archived"].bool }
    var goal: JSON { raw["goal"] }
    var queued: [JSON] { raw["queued_turns"].array }
    var activitySeq: Int { raw["attention"]["last_agent_activity_seq"].int }
    var isDraft: Bool { raw["native_draft"].bool }
}

extension Project {
    func agent(_ provider: String) -> JSON { raw["agents"].array.first { $0["provider"].string == provider } ?? raw }
    func capabilities(_ provider: String) -> JSON { agent(provider)["capabilities"] }
    func modes(_ provider: String) -> [JSON] { agent(provider)["collaboration_modes"].array }
}

@MainActor extension AppModel {
    func taskRequest(_ task: AgentTask, method: String, fields: [String: JSON] = [:]) async throws -> JSON {
        let current = connectionID
        if demo {
            guard method == "thread.update" else { throw PilotError("This action is not available in the demo.") }
            var raw = task.raw
            for (key, value) in fields {
                let mapped = key == "pinned" ? "is_pinned" : key == "pinned_in_project" ? "is_pinned_in_project" : key
                if ["model_id", "reasoning_effort", "collaboration_mode_id", "approval_policy", "permission_mode", "sandbox_mode", "service_tier"].contains(key) {
                    raw = raw.setting("agent", (raw["agent"] == .null ? .object([:]) : raw["agent"]).setting(key, value))
                } else { raw = raw.setting(mapped, value) }
            }
            if fields["pinned"]?.bool == true { raw = raw.setting("is_pinned_in_project", .bool(false)) }
            if fields["pinned_in_project"]?.bool == true { raw = raw.setting("is_pinned", .bool(false)) }
            upsertTask(raw); return raw
        }
        let params = JSON.object(fields).setting("workspace_id", .string(task.projectID)).setting("thread_id", .string(task.id))
        let result = try await relay.call(method, params: params)
        guard current == connectionID else { throw CancellationError() }
        let raw = result["thread"] == .null ? result : result["thread"]
        if raw["id"].string == task.id { upsertTask(raw) }
        return result
    }

    func setGoal(_ task: AgentTask, objective: String? = nil, budget: Int? = nil, status: String? = nil, clear: Bool = false) async throws {
        var fields: [String: JSON] = [:]
        if let objective { fields["objective"] = .string(objective) }
        if let budget, budget > 0 { fields["token_budget"] = .number(Double(budget)) }
        if let status { fields["status"] = .string(status) }
        if demo {
            var goal = task.goal == .null ? JSON.object(["status": .string("active"), "started_at": .string(Date.now.ISO8601Format())]) : task.goal
            for (key, value) in fields { goal = goal.setting(key, value) }
            upsertTask(task.raw.setting("goal", clear ? .null : goal)); return
        }
        _ = try await taskRequest(task, method: clear ? "thread.goal.clear" : "thread.goal.set", fields: fields)
    }

    func queueAction(_ task: AgentTask, queuedID: String, action: String, text: String? = nil) async throws {
        guard ["edit", "remove", "steer"].contains(action) else { return }
        var fields: [String: JSON] = ["queued_id": .string(queuedID)]
        if let text { fields["text"] = .string(text) }
        if demo {
            var queue = task.queued
            if action == "edit", let index = queue.firstIndex(where: { $0["id"].string == queuedID }) {
                queue[index] = queue[index].setting("text", .string(text ?? "")).setting("preview", .string(String((text ?? "").prefix(140))))
            } else { queue.removeAll { $0["id"].string == queuedID } }
            upsertTask(task.raw.setting("queued_turns", .array(queue))); return
        }
        _ = try await taskRequest(task, method: "thread.queue.\(action)", fields: fields)
    }

    func markRead(_ task: AgentTask, unread: Bool = false, automatic: Bool = false) async {
        guard !task.isDraft, task.activitySeq > 0, demo || connected else { return }
        if automatic {
            guard task.unread, readSuppression[task.id] != task.activitySeq else { return }
        }
        if unread { readSuppression[task.id] = task.activitySeq }
        else { readSuppression.removeValue(forKey: task.id) }
        do {
            if demo {
                var attention = task.raw["attention"].setting("unread", .bool(unread))
                if !unread { attention = attention.setting("last_read_seq", .number(Double(task.activitySeq))) }
                upsertTask(task.raw.setting("attention", attention)); return
            }
            _ = try await taskRequest(task, method: unread ? "thread.mark_unread" : "thread.mark_read", fields: unread ? [:] : ["read_seq": .number(Double(task.activitySeq))])
        } catch {
            if !automatic { self.error = error.localizedDescription }
        }
    }

    func loadArchived() async throws {
        if demo { return }
        let current = connectionID
        let snapshot = try await relay.call("snapshot.current", params: .object([
            "include_archived_threads": .bool(true), "include_thread_plans": .bool(false), "include_thread_diffs": .bool(false),
            "include_agent_skills": .bool(false), "include_workspace_skills": .bool(false)
        ]))
        guard current == connectionID else { return }
        archivedTasks = snapshot["threads"].array.filter { $0["is_archived"].bool }.map(AgentTask.init)
    }

    func unarchive(_ task: AgentTask) async throws {
        if demo { upsertTask(task.raw.setting("is_archived", .bool(false))) }
        else { _ = try await taskRequest(task, method: "thread.unarchive") }
        archivedTasks.removeAll { $0.id == task.id }
    }

    func compact(_ task: AgentTask, instructions: String = "") async throws {
        guard !task.running, task.status != "waiting_for_input" else { throw PilotError("Wait for this turn to finish before compacting.") }
        if demo { chat(for: task).notice = "Context compacted in this demo."; return }
        _ = try await taskRequest(task, method: "thread.compact", fields: instructions.isEmpty ? [:] : ["instructions": .string(instructions)])
        await loadChat(task)
    }

    func newChat() async {
        do {
            let current = connectionID
            let project = demo ? Demo.projects[0] : Project(try await relay.call("chat.create", params: .object(["create": .bool(true)])))
            guard current == connectionID else { return }
            if !projects.contains(where: { $0.id == project.id }) { projects.append(project) }
            selection = .draft(project.id, nil)
        } catch { self.error = error.localizedDescription }
    }

    func draftTask(project: Project, folderID: String?) -> AgentTask {
        let id = "draft:\(project.id):\(folderID ?? "root")"
        let provider = chats[id]?.provider.nonempty ?? project.defaultProvider
        return AgentTask(.object(["id": .string(id), "workspace_id": .string(project.id), "title": .string("New task"), "provider": .string(provider), "status": .string("idle"), "native_draft": .bool(true), "folder_id": folderID.map(JSON.string) ?? .null]))
    }
}
