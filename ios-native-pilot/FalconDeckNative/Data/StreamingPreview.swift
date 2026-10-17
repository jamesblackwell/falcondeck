#if DEBUG
import Foundation

/// A repeatable local stream for visual QA; it never contacts an agent.
@MainActor enum StreamingPreview {
    static let reply = """
    ## A steadier conversation

    Streaming text should remain easy to read as a response grows. Existing lines
    stay in place until a new line is needed, and incoming words do not restart a
    scrolling animation. The conversation follows the latest text quietly.

    You can still scroll back to read an earlier message. New content continues
    arriving below without pulling you away from your reading position. Jump to
    latest returns to the live response when you are ready.

    - Keep the familiar navigation and prompt controls.
    - Show one quiet thinking indicator while the agent is preparing its reply.
    - Preserve formatting, Unicode 🦅, and the final words of every response.

    ```swift
    let conversation = "Native and responsive"
    let preservesReadingPosition = true
    ```

    | State | Behavior |
    | --- | --- |
    | Following | Stay with the latest response |
    | Reading | Keep the current position |

    The response is complete. All streamed text has arrived.
    """

    static func start(in model: AppModel) {
        guard ProcessInfo.processInfo.arguments.contains("--streaming-preview"), let first = model.tasks.first else { return }
        let task = AgentTask(first.raw.setting("provider", .string("claude")))
        model.tasks[0] = task; model.requests = []
        let chat = model.chat(for: task), scope = model.sessionScope
        chat.loaded = true; chat.transcript = Transcript(items: Demo.messages)
        model.selection = .task(task.id)
        Task { @MainActor [weak model] in
            do {
                try await Task.sleep(for: .seconds(3))
                guard let model, model.sessionScope == scope else { return }
                let thought = "I’ll keep the existing layout and check how the text behaves while a response arrives."
                for chunk in chunks(thought) {
                    guard model.demo, model.sessionScope == scope else { return }
                    chat.transcript.apply(.object(["type": .string("text"), "item_id": .string("preview-thought"), "target": .string("reasoning_content"), "delta": .string(chunk)]))
                    try await Task.sleep(for: .milliseconds(20))
                }
                try await Task.sleep(for: .seconds(1))
                for chunk in chunks(reply) {
                    guard model.demo, model.sessionScope == scope else { return }
                    chat.transcript.apply(.object(["type": .string("text"), "item_id": .string("preview-answer"), "target": .string("assistant_message"), "delta": .string(chunk)]))
                    try await Task.sleep(for: .milliseconds(20))
                }
                guard model.demo, model.sessionScope == scope else { return }
                chat.transcript.apply(.object(["type": .string("turn-end")]))
                model.upsertTask(task.raw.setting("status", .string("idle")))
            } catch { }
        }
    }

    private static func chunks(_ text: String) -> [String] {
        var result: [String] = [], start = text.startIndex
        while start < text.endIndex {
            let end = text.index(start, offsetBy: 4, limitedBy: text.endIndex) ?? text.endIndex
            result.append(String(text[start..<end])); start = end
        }
        return result
    }
}
#endif
