#if DEBUG
import Foundation

/// Delayed, entirely local acceptance/echo fixtures exercise the actual send
/// path. They never load credentials, open sockets, or start an agent turn.
actor SendPreviewRelay: RelayServing {
    private var sink: AsyncStream<RelayUpdate>.Continuation?
    private var connectionID = UUID()
    private var sequence = 0
    private var attempts = 0
    private let mode: String
    init(mode: String) { self.mode = mode }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { sink = $0 } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { self.connectionID = connectionID; return true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .object(["thread": task.raw, "items": .array(SendPreview.history.map(\.raw))]) }
    func call(_ method: String, params: JSON) async throws -> JSON {
        if method == "thread.start" {
            try await Task.sleep(for: .seconds(5))
            return .object(["thread": Self.task(id: "created-preview", project: params["workspace_id"].string, status: "idle").raw])
        }
        if method == "turn.start" {
            attempts += 1
            try await Task.sleep(for: .seconds(5))
            if mode == "failure", attempts == 1 { throw PilotError("Local test delivery failed. Your input has been restored.") }
            if mode == "queued" { return .object(["ok": .bool(true), "message": .string("queued")]) }
            let item = JSON.object(["id": params["user_item_id"], "kind": .string("user_message"), "text": params["inputs"].array.first?["text"] ?? .string("")])
            let task = Self.task(id: params["thread_id"].string, project: params["workspace_id"].string, status: "running")
            let current = connectionID
            Task {
                try? await Task.sleep(for: .seconds(2))
                guard current == connectionID else { return }
                publish(task, .object(["type": .string("conversation-item-added"), "item": item]))
                publish(task, .object(["type": .string("thread-updated"), "thread": task.raw]))
            }
            return .object(["ok": .bool(true), "message": .string("started")])
        }
        if method == "workspace.skills" { return .object(["skills": .array([])]) }
        if method == "workspace.prompts" { return .object(["prompts": .array([])]) }
        return .object(["ok": .bool(true)])
    }
    private func publish(_ task: AgentTask, _ event: JSON) {
        sequence += 1
        sink?.yield(.init(connectionID: connectionID, event: .events([.object(["seq": .number(Double(sequence)), "thread_id": .string(task.id), "event": event])])))
    }
    static func task(id: String, project: String, status: String) -> AgentTask {
        AgentTask(.object(["id": .string(id), "workspace_id": .string(project), "title": .string("Local send preview"), "provider": .string("codex"), "status": .string(status)]))
    }
}

@MainActor enum SendPreview {
    nonisolated static let history = [
        Message(.object(["id": .string("preview-question"), "kind": .string("user_message"), "text": .string("Keep the conversation steady while I send a message.")])),
        Message(.object(["id": .string("preview-answer"), "kind": .string("assistant_message"), "text": .string("Messages should feel immediate, with a clear delivery state.")]))
    ]
    static func start(in model: AppModel) async {
        guard let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--send-preview=") }) else { return }
        let mode = String(argument.dropFirst("--send-preview=".count)), project = Demo.projects[0]
        let task = mode == "new" ? model.draftTask(project: project, folderID: nil) : SendPreviewRelay.task(id: "local-send-preview", project: project.id, status: mode == "queued" ? "running" : "idle")
        model.tasks = task.isDraft ? [] : [task]; model.requests = []; model.selection = task.isDraft ? .draft(project.id, nil) : .task(task.id)
        let chat = model.chat(for: task); chat.loaded = true; chat.transcript.items = task.isDraft ? [] : history
        if mode == "voice" {
            model.voice.preview("ready", ownerID: task.id); chat.voiceInputOpen = true
            _ = await model.finishVoiceInput("A clear native transcript.", ownerID: task.id, chat: chat)
        } else if mode == "handoff" {
            model.voice.preview("ready", ownerID: task.id); chat.voiceInputOpen = true
            model.voice.acceptingTranscript = true
        }
        _ = try? await model.relay.restore(connectionID: model.connectionID)
        model.demo = false; model.hasSession = true; model.connected = true; model.hasLiveSnapshot = true
    }
}
#endif
