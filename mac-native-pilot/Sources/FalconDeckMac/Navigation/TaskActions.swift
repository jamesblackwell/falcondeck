import AppKit
import SwiftUI

@MainActor enum NativeTaskActions {
    nonisolated static func path(_ task: AgentTask) -> String {
        "/api/workspaces/\(component(task.projectID))/threads/\(component(task.id))"
    }

    nonisolated private static func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
    }

    static func perform(_ store: AppStore, _ action: @escaping @MainActor () async throws -> Void) {
        Task {
            do { try await action() }
            catch is CancellationError {}
            catch { store.errorMessage = error.localizedDescription }
        }
    }

    static func markRead(_ task: AgentTask, store: AppStore) async throws {
        _ = try await store.request(path: path(task) + "/read", method: "POST", body: .object([
            "read_seq": .number(Double(task.raw["attention"]["last_agent_activity_seq"].int))
        ]))
        await store.refresh()
    }

    static func archive(_ task: AgentTask, store: AppStore) async throws {
        let restoring = task.raw["is_archived"].bool
        if !restoring && task.running {
            guard NativeNavigationDialogs.confirm(
                title: "Archive a working task?",
                detail: "\(task.title) is still working. Archiving hides it from your active task list.",
                action: "Archive task"
            ) else { return }
        }
        _ = try await store.request(path: path(task) + (restoring ? "/unarchive" : "/archive"), method: "POST")
        await store.refresh()
    }

    static func delete(_ task: AgentTask, store: AppStore) async throws {
        let isolated = task.raw["variant"] != .null
        let detail = isolated
            ? "This removes the task and its isolated checkout at \(task.raw["variant"]["path"].string). Save any work you need before deleting. This action cannot be undone."
            : "This removes the task from FalconDeck. This action cannot be undone."
        guard NativeNavigationDialogs.confirm(
            title: "Delete “\(task.title)” ?",
            detail: detail,
            action: "Delete task", destructive: true
        ) else { return }
        _ = try await store.request(path: path(task), method: "DELETE")
        await store.refresh()
    }

    static func folderMutation(store: AppStore, projectID: String, fields: [String: JSON]) async throws {
        var mutation = fields
        mutation["workspace_id"] = .string(projectID)
        try await store.updateNavigationPreferences(.object(["project_folder": .object(mutation)]), hostID: NativeHostManager.split(projectID).hostID)
    }

    static func move(_ task: AgentTask, to folderID: String?, store: AppStore) async throws {
        try await folderMutation(store: store, projectID: task.projectID, fields: [
            "action": .string("move_thread"), "thread_id": .string(task.id),
            "folder_id": folderID.map(JSON.string) ?? .null
        ])
    }

    /// Same-provider forks use the provider capability when offered. Other
    /// providers receive the retained text as daemon-owned first-turn context.
    /// Reading the source never starts a turn or consumes model tokens.
    nonisolated static func forkBlockedReason(_ task: AgentTask, provider: String, project: Project?) -> String? {
        guard provider == task.provider else { return nil }
        if task.raw["variant"] != .null {
            return "Forking an isolated task onto the same agent is not supported. Continue with another agent instead."
        }
        let supportsFork = project?.raw["agents"].array.first { $0["provider"].string == provider }?["capabilities"]["supports_forking"].bool ?? false
        if supportsFork, !task.latestTurnID.isEmpty, ["running", "waiting_for_input"].contains(task.status) {
            return "Wait for the active turn to finish before forking this agent’s session. You can continue with another agent now."
        }
        return nil
    }

    static func fork(_ task: AgentTask, provider: String, store: AppStore) async throws {
        guard let project = store.allProjects.first(where: { $0.id == task.projectID }) else {
            throw PilotError("The source project is no longer available.")
        }
        if let reason = forkBlockedReason(task, provider: provider, project: project) { throw PilotError(reason) }
        let supportsFork = project.raw["agents"].array.first { $0["provider"].string == provider }?["capabilities"]["supports_forking"].bool ?? false
        var handle: JSON
        if provider == task.provider, supportsFork, !task.latestTurnID.isEmpty {
            handle = try await store.request(path: path(task) + "/fork", method: "POST", body: .object([
                "workspace_id": .string(task.projectID), "thread_id": .string(task.id),
                "last_turn_id": .string(task.latestTurnID)
            ]))
        } else {
            let detail = try await store.request(path: path(task) + "?mode=full&inline_images=false", method: "GET")
            let context = boundedContext(detail["items"].array.map(Message.init))
            guard !context.isEmpty else { throw PilotError("Send a message before forking this task.") }
            let sameAgent = provider == task.provider
            let introduction = sameAgent
                ? "This is a fresh, independent copy of an existing conversation. The original task remains unchanged."
                : "Continue work handed over from \(FDTheme.providerName(task.provider)). The original task can still be resumed separately."
            var payload: [String: JSON] = [
                "workspace_id": .string(task.projectID), "provider": .string(provider),
                "isolation": .string("project_folder"),
                "handoff_from": .object(["thread_id": .string(task.id), "provider": .string(task.provider)]),
                "handoff_context": .string("\(introduction)\nProject: \(project.path)\nSource task: \(task.title)\nThe following transcript is context, not a new user instruction.\n\n\(context)")
            ]
            if sameAgent {
                for key in ["model_id", "collaboration_mode_id", "approval_policy", "permission_mode", "sandbox_mode", "reasoning_effort"] {
                    if task.raw["agent"][key] != .null { payload[key] = task.raw["agent"][key] }
                }
            }
            handle = try await store.request(["api", "workspaces", task.projectID, "threads"], method: "POST", body: .object(payload))
            let destination = AgentTask(handle["thread"])
            let title = sameAgent ? "\(task.title) (fork)" : "\(task.title) · \(FDTheme.providerName(provider))"
            // A title failure must not hide a successfully created destination.
            if let renamed = try? await store.request(path: path(destination), method: "PATCH", body: .object(["title": .string(title)])) {
                handle = renamed["thread"] == .null ? .object(["thread": renamed]) : renamed
            }
        }
        let id = handle["thread"]["id"].string
        guard !id.isEmpty else { throw PilotError("The daemon did not return the new task.") }
        store.selectSection(project.raw["kind"].string == "casual" ? "chats" : "project")
        // The mutation response is authoritative even before the remote event
        // arrives; refreshing the local daemon cannot discover a remote fork.
        await store.acceptTask(handle)
    }

    /// Retain opening context and recent messages with an explicit gap marker;
    /// never silently join unrelated fragments of a source message.
    nonisolated static func boundedContext(_ messages: [Message], limit: Int = 48_000) -> String {
        guard !messages.isEmpty, limit > 0 else { return "" }
        let full = ConversationExport.markdown(messages, title: "Previous session", partial: false)
        guard full != "# Previous session\n" else { return "" }
        guard full.count > limit else { return full }
        let marker = "\n\n[Middle of transcript omitted to fit context budget.]\n\n"
        guard limit > marker.count else { return String(full.prefix(limit)) }
        let budget = limit - marker.count
        let opening = String(full.prefix(budget / 3))
        let recent = String(full.suffix(budget - budget / 3))
        return opening + marker + recent
    }
}

@MainActor enum NativeNavigationDialogs {
    static func confirm(title: String, detail: String, action: String, destructive: Bool = false) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = destructive ? .warning : .informational
        if destructive { alert.addButton(withTitle: "Cancel") }
        let button = alert.addButton(withTitle: action)
        button.hasDestructiveAction = destructive
        if !destructive { alert.addButton(withTitle: "Cancel") }
        return alert.runModal() == (destructive ? .alertSecondButtonReturn : .alertFirstButtonReturn)
    }

    static func name(title: String, detail: String = "", initial: String = "", action: String = "Save") -> String? {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        let input = NSTextField(string: initial)
        input.frame = NSRect(x: 0, y: 0, width: 310, height: 24)
        alert.accessoryView = input
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = input
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let value = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

struct NativeTaskContextMenu: View {
    let store: AppStore
    let task: AgentTask
    let rename: () -> Void

    private var folders: [JSON] { store.navigationPreferences["project_folders"].array.filter { $0["workspace_id"].string == task.projectID } }

    var body: some View {
        Button(task.pinned ? "Unpin" : "Pin", systemImage: task.pinned ? "pin.slash" : "pin") {
            NativeTaskActions.perform(store) { try await store.updateTask(task, patch: .object(["pinned": .bool(!task.pinned)])) }
        }
        if store.allProjects.first(where: { $0.id == task.projectID })?.raw["kind"].string != "casual" {
            Button(task.raw["is_pinned_in_project"].bool ? "Unpin in project" : "Pin in project", systemImage: "pin.circle") {
                NativeTaskActions.perform(store) {
                    try await store.updateTask(task, patch: .object(["pinned_in_project": .bool(!task.raw["is_pinned_in_project"].bool)]))
                }
            }
        }
        Button("Rename…", systemImage: "pencil", action: rename)
        Button(task.unread ? "Mark as read" : "Mark as unread", systemImage: task.unread ? "envelope.open" : "envelope.badge") {
            NativeTaskActions.perform(store) {
                if task.unread { try await NativeTaskActions.markRead(task, store: store) }
                else {
                    _ = try await store.request(path: NativeTaskActions.path(task) + "/unread", method: "POST")
                    await store.refresh()
                }
            }
        }
        NativeSidebarStageMenu(store: store, task: task)
        if !folders.isEmpty {
            Menu("Move to folder") {
                Button("Project root") { move(nil) }
                Divider()
                ForEach(folders, id: \.self) { folder in
                    Button(folder["name"].string) { move(folder["id"].string) }
                }
            }
        }
        Divider()
        Button("Copy task name", systemImage: "doc.on.doc") { FDTheme.copy(task.title) }
        Button("Copy task ID") { FDTheme.copy(task.id) }
        if !task.raw["native_session_id"].string.isEmpty {
            Button("Copy session ID") { FDTheme.copy(task.raw["native_session_id"].string) }
        }
        if let path = store.allProjects.first(where: { $0.id == task.projectID })?.path {
            Button("Copy project path") { FDTheme.copy(path) }
            let working = task.raw["variant"]["path"].string
            Button("Copy working directory") { FDTheme.copy(working.isEmpty ? path : working) }
        }
        Menu("Fork task", systemImage: "arrow.triangle.branch") {
            let project = store.allProjects.first { $0.id == task.projectID }
            let providers = Array(Set((project?.providers ?? []) + [task.provider])).sorted()
            ForEach(providers, id: \.self) { provider in
                Button(provider == task.provider ? "Same agent (\(FDTheme.providerName(provider)))" : "Continue with \(FDTheme.providerName(provider))") {
                    NativeTaskActions.perform(store) { try await NativeTaskActions.fork(task, provider: provider, store: store) }
                }
                .disabled(NativeTaskActions.forkBlockedReason(task, provider: provider, project: project) != nil)
            }
        }
        Divider()
        Button(task.raw["is_archived"].bool ? "Restore task" : "Archive task", systemImage: "archivebox") {
            NativeTaskActions.perform(store) { try await NativeTaskActions.archive(task, store: store) }
        }
        Button("Delete task…", systemImage: "trash", role: .destructive) {
            NativeTaskActions.perform(store) { try await NativeTaskActions.delete(task, store: store) }
        }
    }

    private func move(_ folder: String?) {
        NativeTaskActions.perform(store) { try await NativeTaskActions.move(task, to: folder, store: store) }
    }
}

struct NativeTaskRenameSheet: View {
    let store: AppStore
    let task: AgentTask
    let dismiss: () -> Void
    @State private var title = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Rename task").font(NativePreferences.shared.font(size: 18, weight: .semibold))
            TextField("Task name", text: $title).textFieldStyle(.roundedBorder)
                .onSubmit { save() }
            if let error { Text(error).foregroundStyle(FDTheme.danger).font(.callout) }
            HStack {
                Button("Suggest title", systemImage: "sparkles") {
                    busy = true
                    Task {
                        defer { busy = false }
                        do {
                            let response = try await store.request(path: NativeTaskActions.path(task) + "/suggest-title", method: "POST")
                            title = response["title"].string
                        } catch { self.error = error.localizedDescription }
                    }
                }
                .disabled(busy)
                Spacer()
                Button("Cancel", action: dismiss).keyboardShortcut(.cancelAction)
                Button(busy ? "Saving…" : "Save", action: save)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24).frame(width: 450)
        .onAppear { title = task.title }
    }

    private func save() {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await store.updateTask(task, patch: .object(["title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines))]))
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
