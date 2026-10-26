import Foundation

struct NativeBot: Identifiable, Hashable, Sendable {
    let raw: JSON
    var id: String { raw["id"].string }
    var name: String { raw["name"].string }
    var taskID: String { raw["thread_id"].string }
    var projectID: String { raw["workspace_id"].string }
    var instructions: String { raw["instructions"].string }
    var canStartThreads: Bool { raw["can_start_threads"] != .bool(false) }
    var spacePath: String { raw["space_path"].string }
    var dedicatedWorkspace: Bool { raw["dedicated_workspace"].bool }
}

struct NativeBotDraft {
    var name = ""
    var instructions = ""
    var provider = "codex"
    var modelID = ""
    var existingTaskID = ""
    var canStartThreads = true

    init(bot: NativeBot? = nil) {
        guard let bot else { return }
        name = bot.name; instructions = bot.instructions; canStartThreads = bot.canStartThreads
    }

    func mutation(bot: NativeBot? = nil) throws -> JSON {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty, cleanName.unicodeScalars.count <= 100, !name.contains("\n"), !name.contains("\r") else {
            throw PilotError("Bot name must be 1–100 characters on one line.")
        }
        guard instructions.utf8.count <= 32_000 else { throw PilotError("Bot instructions must be at most 32,000 bytes.") }
        var fields: [String: JSON] = ["action": .string(bot == nil ? "create" : "update"), "name": .string(cleanName), "instructions": .string(instructions)]
        if let bot { fields["id"] = .string(bot.id); fields["can_start_threads"] = .bool(canStartThreads) }
        else if !existingTaskID.isEmpty { fields["thread_id"] = .string(existingTaskID) }
        else {
            guard !provider.isEmpty else { throw PilotError("Choose a harness for this bot.") }
            fields["provider"] = .string(provider)
            if let model = modelID.trimmingCharacters(in: .whitespacesAndNewlines).nonempty { fields["model_id"] = .string(model) }
        }
        return .object(fields)
    }
}

struct NativeBotDocument: Hashable, Sendable {
    let name: String
    let content: String
    let version: String
    init(raw: JSON) {
        name = raw["name"].string; content = raw["content"].string; version = raw["version"].string
    }
    var raw: JSON { .object(["name": .string(name), "content": .string(content), "version": .string(version)]) }
    static func validate(name: String, content: String? = nil) throws {
        guard !name.isEmpty, name.utf8.count <= 180, !name.hasPrefix("."), !name.contains("/"), !name.contains("\\"),
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw PilotError("Use a plain document filename, without folders or a leading dot.")
        }
        if let content, content.utf8.count > 1_048_576 { throw PilotError("Document must be at most 1 MB.") }
    }
}

@MainActor extension AppModel {
    var bots: [NativeBot] {
        preferences["bots"].array.map(NativeBot.init).filter { !$0.id.isEmpty && !$0.taskID.isEmpty && !$0.projectID.isEmpty }
    }
    var botTaskIDs: Set<String> { Set(bots.map(\.taskID)) }
    var botWorkspaceIDs: Set<String> { Set(bots.filter(\.dedicatedWorkspace).map(\.projectID)) }
    var botProviders: [String] {
        Array(Set(["codex", "claude"] + projects.flatMap { $0.raw["agents"].array.map { $0["provider"].string } })).filter { !$0.isEmpty }.sorted()
    }
    func bot(forTask taskID: String) -> NativeBot? { bots.first { $0.taskID == taskID } }
    func delegatedTasks(for bot: NativeBot) -> [AgentTask] {
        tasks.filter { !$0.archived && $0.raw["origin"]["kind"].string == "agent_spawn" && $0.raw["origin"]["parent_thread_id"].string == bot.taskID }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    @discardableResult func openBot(_ bot: NativeBot) async -> Bool {
        let current = connectionID
        if task(bot.taskID) == nil {
            let home = AgentTask(.object(["id": .string(bot.taskID), "workspace_id": .string(bot.projectID), "title": .string(bot.name), "status": .string("idle")]))
            if demo { upsertTask(home.raw) }
            else {
                guard connected else { error = "Connect to your computer to open this bot."; return false }
                await loadChat(home)
                guard current == connectionID else { return false }
                guard task(bot.taskID) != nil else {
                    error = chats[bot.taskID]?.historyError ?? "Couldn't load this bot. Refresh and try again."
                    return false
                }
            }
        }
        guard current == connectionID else { return false }
        selection = .task(bot.taskID); error = nil
        return true
    }

    @discardableResult func saveBot(_ draft: NativeBotDraft, bot: NativeBot? = nil) async throws -> NativeBot {
        let mutation = try draft.mutation(bot: bot), current = connectionID, revision = preferencesRevision
        let before = bot.flatMap { original in bots.first { $0.id == original.id }?.raw }
        if demo {
            let id = bot?.id ?? "bot-\(UUID().uuidString)"
            let home = bot?.taskID ?? draft.existingTaskID.nonempty ?? "bot-home-\(UUID().uuidString)"
            let project = bot?.projectID ?? task(home)?.projectID ?? "bot-project-\(UUID().uuidString)"
            var raw = bot?.raw ?? .object(["id": .string(id), "thread_id": .string(home), "workspace_id": .string(project), "dedicated_workspace": .bool(draft.existingTaskID.isEmpty), "space_path": .string("Demo bot documents")])
            raw = raw.setting("name", mutation["name"]).setting("instructions", mutation["instructions"]).setting("can_start_threads", .bool(bot == nil || draft.canStartThreads))
            let saved = NativeBot(raw: raw)
            setBotProfile(saved, replacing: before)
            let homeRaw = task(home)?.raw ?? .object(["id": .string(home), "workspace_id": .string(project), "provider": .string(draft.provider), "status": .string("idle"), "agent": .object(["model_id": .string(draft.modelID)])])
            upsertTask(homeRaw.setting("title", mutation["name"]).setting("is_pinned", .bool(false)).setting("is_pinned_in_project", .bool(false)))
            return saved
        }
        let response = try await relay.call("bots.mutate", params: mutation)
        guard current == connectionID else { throw CancellationError() }
        let saved = NativeBot(raw: response["bot"])
        guard !saved.id.isEmpty, !saved.taskID.isEmpty, !saved.projectID.isEmpty else { throw PilotError("The computer returned an incomplete bot. Refresh before trying again.") }
        setBotProfile(saved, replacing: before, creatingAt: bot == nil ? revision : nil)
        return saved
    }

    func stopBot(_ bot: NativeBot) async throws {
        let current = connectionID
        if demo {
            let ids = Set([bot.taskID] + delegatedTasks(for: bot).map(\.id))
            for row in tasks where ids.contains(row.id) {
                upsertTask(row.raw.setting("status", .string("idle")).setting("queued_turns", .array([])))
            }
            return
        }
        let response = try await relay.call("bots.mutate", params: .object(["action": .string("stop"), "id": .string(bot.id)]))
        guard current == connectionID else { throw CancellationError() }
        guard response["ok"].bool else { throw PilotError("The bot could not be stopped. Refresh and try again.") }
        await relay.refresh()
    }

    func deleteBot(_ bot: NativeBot) async throws {
        let current = connectionID, before = bots.first { $0.id == bot.id }?.raw
        if !demo {
            let response = try await relay.call("bots.mutate", params: .object(["action": .string("delete"), "id": .string(bot.id)]))
            guard current == connectionID else { throw CancellationError() }
            guard response["ok"].bool else { throw PilotError("The bot could not be removed. Refresh and try again.") }
        } else if let home = task(bot.taskID) { upsertTask(home.raw.setting("is_archived", .bool(true))) }
        if bots.first(where: { $0.id == bot.id })?.raw == before {
            preferences = preferences.setting("bots", .array(preferences["bots"].array.filter { $0["id"].string != bot.id }))
        }
        if selection == .task(bot.taskID) { selection = .projects }
    }

    func botDocuments(_ bot: NativeBot) async throws -> [String] {
        let current = connectionID
        if demo { return demoBotDocuments(bot).map { $0["name"].string }.sorted() }
        let response = try await relay.call("bots.documents", params: .object(["id": .string(bot.id)]))
        guard current == connectionID else { throw CancellationError() }
        guard case .array(let names) = response, names.allSatisfy({ if case .string = $0 { true } else { false } }) else { throw PilotError("Couldn't load this bot's documents. Refresh and try again.") }
        return names.map(\.string)
    }

    func readBotDocument(_ bot: NativeBot, name: String) async throws -> NativeBotDocument {
        try NativeBotDocument.validate(name: name)
        let current = connectionID
        let response: JSON
        if demo {
            guard let document = demoBotDocuments(bot).first(where: { $0["name"].string == name }) else { throw PilotError("Document no longer exists. Refresh the list.") }
            response = document
        } else { response = try await relay.call("bots.document.read", params: .object(["id": .string(bot.id), "name": .string(name)])) }
        guard current == connectionID else { throw CancellationError() }
        let document = NativeBotDocument(raw: response)
        guard document.name == name, !document.version.isEmpty, case .string = response["content"] else { throw PilotError("Couldn't load this document. Refresh and try again.") }
        return document
    }

    func writeBotDocument(_ bot: NativeBot, name: String, content: String, expectedVersion: String? = nil) async throws {
        try NativeBotDocument.validate(name: name, content: content)
        let mutation = JSON.object(["action": .string("write"), "name": .string(name), "content": .string(content), "expected_version": expectedVersion.map(JSON.string) ?? .null])
        try await mutateBotDocument(bot, mutation: mutation)
    }

    func deleteBotDocument(_ bot: NativeBot, name: String, expectedVersion: String) async throws {
        try NativeBotDocument.validate(name: name)
        guard !expectedVersion.isEmpty else { throw PilotError("Reload this document before deleting it.") }
        try await mutateBotDocument(bot, mutation: .object(["action": .string("delete"), "name": .string(name), "expected_version": .string(expectedVersion)]))
    }

    private func setBotProfile(_ bot: NativeBot, replacing before: JSON?, creatingAt revision: Int? = nil) {
        // A newer preference event wins over an older in-flight mutation reply.
        let current = bots.first { $0.id == bot.id }?.raw
        guard current == before || current == bot.raw else { return }
        // A bot created and then removed by newer events must stay removed.
        if before == nil, current == nil, let revision, revision != preferencesRevision { return }
        var values = preferences["bots"].array
        if let index = values.firstIndex(where: { $0["id"].string == bot.id }) { values[index] = bot.raw }
        else { values.append(bot.raw) }
        preferences = preferences.setting("bots", .array(values))
    }

    private func demoBotDocuments(_ bot: NativeBot) -> [JSON] {
        bots.first { $0.id == bot.id }?.raw["native_demo_documents"].array ?? []
    }

    private func mutateBotDocument(_ bot: NativeBot, mutation: JSON) async throws {
        let current = connectionID
        if demo {
            var documents = demoBotDocuments(bot)
            let name = mutation["name"].string, previous = documents.first { $0["name"].string == name }
            let expected = mutation["expected_version"]
            if expected == .null {
                guard previous == nil else { throw PilotError("A document with that name already exists; open it before editing.") }
            } else {
                guard let previous, previous["version"] == expected else { throw PilotError("Document changed; reload before saving or deleting.") }
            }
            documents.removeAll { $0["name"].string == name }
            if mutation["action"].string == "write" { documents.append(mutation.setting("version", .string(UUID().uuidString))) }
            guard let original = bots.first(where: { $0.id == bot.id }) else { throw PilotError("This bot no longer exists.") }
            setBotProfile(NativeBot(raw: original.raw.setting("native_demo_documents", .array(documents))), replacing: original.raw)
            return
        }
        let response = try await relay.call("bots.document.mutate", params: .object(["id": .string(bot.id), "mutation": mutation]))
        guard current == connectionID else { throw CancellationError() }
        guard response["ok"].bool else { throw PilotError("The document could not be updated. Reload and try again.") }
    }
}
