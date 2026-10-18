#if DEBUG
import Foundation

/// Heavy local-only UI workload: 1,000 tasks, twelve concurrent streams and a
/// 200-row history. No relay calls, credentials or underlying harness turns.
@MainActor enum PerformancePreview {
    static func start(in model: AppModel) async {
        guard model.demo, ProcessInfo.processInfo.arguments.contains("--performance-preview") else { return }
        let scope = model.sessionScope
        let history = await Task.detached {
            (0..<100).flatMap { index in [
                Message(.object(["id": .string("u-\(index)"), "kind": .string("user_message"), "text": .string("<environment_context>" + String(repeating: "Local harness instructions. ", count: 100) + "</environment_context><user_query>Review change \(index) carefully.</user_query>")])),
                Message(.object(["id": .string("a-\(index)"), "kind": .string("assistant_message"), "text": .string("Reviewed change \(index). The response preserves the existing behavior and includes a focused regression check.")]))
            ] }
        }.value
        guard model.demo, model.sessionScope == scope else { return }
        model.projects = (0..<20).map { index in Project(Demo.projects[0].raw.setting("id", .string("perf-p-\(index)")).setting("path", .string("/local/performance-\(index + 1)"))) }
        model.tasks = (0..<1000).map { index in
            AgentTask(.object(["id": .string("perf-\(index)"), "workspace_id": .string("perf-p-\(index % 20)"), "title": .string("Performance conversation \(index + 1)"), "provider": .string("codex"), "status": .string(index < 12 ? "running" : "idle"), "is_pinned": .bool(index < 2), "updated_at": .string("2026-10-18T00:00:00Z")]))
        }
        model.requests = []; model.selection = .task("perf-0")
        let chats = model.tasks.prefix(12).map { task in
            let chat = model.chat(for: task); chat.loaded = true; chat.transcript = Transcript(items: history); return chat
        }
        Task { @MainActor [weak model] in
            do {
                for round in 0..<600 {
                    guard let model, model.demo, model.sessionScope == scope else { return }
                    for chat in chats {
                        chat.transcript.apply(.object(["type": .string("text"), "item_id": .string("live"), "target": .string("assistant_message"), "delta": .string("Words 👋 "), "start_offset": .number(Double(round * 9)), "end_offset": .number(Double((round + 1) * 9))]))
                    }
                    try await Task.sleep(for: .milliseconds(30))
                }
                guard let model, model.demo, model.sessionScope == scope else { return }
                for chat in chats { chat.transcript.apply(.object(["type": .string("turn-end")])) }
                model.tasks = model.tasks.map { AgentTask($0.raw.setting("status", .string("idle"))) }
            } catch { }
        }
    }
}
#endif
