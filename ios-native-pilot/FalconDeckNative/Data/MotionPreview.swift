#if DEBUG
import Foundation

/// Local motion fixtures; no microphone, agent turn or relay traffic.
@MainActor enum MotionPreview {
    static func start(in model: AppModel) {
        guard model.demo, let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--motion-preview=") }),
              let first = model.tasks.first else { return }
        let mode = String(argument.dropFirst("--motion-preview=".count)), scope = model.sessionScope
        let goal: JSON = .object(["objective": .string("Keep the native app polished and responsive."), "status": .string("active")])
        let task = AgentTask(first.raw.setting("goal", goal).setting("status", .string(mode == "goal" ? "idle" : "running")))
        model.upsertTask(task.raw); model.requests = []; model.selection = .task(task.id)
        let chat = model.chat(for: task)
        chat.loaded = true; chat.transcript.items = [Message(.object([
            "id": .string("motion-request"), "kind": .string("user_message"), "text": .string("Keep the familiar layout and polish the native feedback.")
        ]))]
        if mode == "recording" {
            model.voice.preview("recording", ownerID: task.id)
            chat.voiceInputOpen = true; chat.draft = "Keep my existing draft."
            Task { @MainActor [weak model] in
                for tick in 0..<600 {
                    do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                    guard let model, model.demo, model.sessionScope == scope, model.voice.recording else { return }
                    model.voice.levels = (0..<100).map { index in
                        Float(abs(sin(Double(index + tick) * 0.23)) * (0.25 + 0.65 * abs(sin(Double(index + tick) * 0.07))))
                    }
                    model.voice.elapsed = 42 + Double(tick) / 10
                }
            }
        } else if mode == "goal" {
            Task { @MainActor [weak model] in
                do { try await Task.sleep(for: .seconds(4)) } catch { return }
                guard let model, model.demo, model.sessionScope == scope else { return }
                model.upsertTask(task.raw.setting("goal", goal.setting("status", .string("complete"))))
            }
        }
    }
}
#endif
