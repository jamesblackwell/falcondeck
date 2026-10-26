#if DEBUG
import Foundation

@MainActor enum BotPreview {
    static func start(in model: AppModel) {
        guard model.demo, ProcessInfo.processInfo.arguments.contains("--bots-preview") else { return }
        let projectID = Demo.projects[0].id
        let home = JSON.object(["id": .string("preview-bot-home"), "workspace_id": .string(projectID), "title": .string("Concierge"), "provider": .string("codex"), "status": .string("idle"), "is_pinned": .bool(true)])
        let bot = JSON.object(["id": .string("preview-bot"), "name": .string("Concierge"), "workspace_id": .string(projectID), "thread_id": .string("preview-bot-home"), "instructions": .string("Help coordinate my projects and keep useful notes."), "can_start_threads": .bool(true), "dedicated_workspace": .bool(false), "space_path": .string("Demo bot documents")])
        model.preferences = model.preferences.setting("bots", .array([bot]))
        model.upsertTask(home)
    }
}
#endif
