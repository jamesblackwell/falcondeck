import Foundation
import XCTest
@testable import FalconDeckNative

/// Repeatable local workload benchmarks. Times are evidence, not brittle CI
/// pass/fail thresholds; each workload also checks the resulting state.
@MainActor final class PerformanceTests: XCTestCase {
    private func report(_ name: String, since start: ContinuousClock.Instant, operations: Int) {
        let elapsed = start.duration(to: .now)
        let seconds = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
        print("NATIVE_PERF \(name) ms=\(String(format: "%.3f", seconds * 1000)) operations=\(operations)")
    }
    private func row(_ index: Int) -> AgentTask {
        AgentTask(.object(["id": .string("task-\(index)"), "workspace_id": .string("p-\(index % 25)"), "provider": .string("codex"), "title": .string("Task \(index)"), "status": .string("running"), "updated_at": .string("2026-10-18T00:00:00.000Z")]))
    }
    func testBenchmarkSummaryBursts() {
        let model = AppModel.testing(relay: UnavailablePreviewRelay())
        model.tasks = (0..<3000).map(row)
        let updates = (0..<10).map { batch in (0..<20).map { offset in row(batch * 20 + offset).raw.setting("last_message_preview", .string("New activity")) } }
        let start = ContinuousClock.now
        for batch in updates { model.upsertTasks(batch) }
        report("summary-bursts", since: start, operations: 200)
        XCTAssertEqual(model.tasks.count, 3000)
        XCTAssertEqual(model.task("task-199")?.preview, "New activity")
    }
    func testBenchmarkUnicodeStreaming() {
        let history = (0..<1000).map { Message(.object(["id": .string("old-\($0)"), "kind": .string("assistant_message"), "text": .string("Earlier response")])) }
        let seed = String(repeating: "Text 👋 ", count: 2000)
        var transcript = Transcript(items: history + [Message(.object(["id": .string("live"), "kind": .string("assistant_message"), "text": .string(seed)]))])
        let delta = "more 👩🏽‍💻 text "
        let count = 600, length = delta.utf16.count, initial = seed.utf16.count
        let events = (0..<count).map { JSON.object(["type": .string("text"), "item_id": .string("live"), "target": .string("assistant_message"), "delta": .string(delta), "start_offset": .number(Double(initial + $0 * length)), "end_offset": .number(Double(initial + ($0 + 1) * length))]) }
        let start = ContinuousClock.now
        for event in events { transcript.apply(event) }
        report("unicode-stream", since: start, operations: count)
        XCTAssertFalse(transcript.needsRecovery)
        XCTAssertEqual(transcript.items.last?.text, seed + String(repeating: delta, count: count))
    }
    func testBenchmarkSnapshotDecode() throws {
        let payload = JSON.object(["workspaces": .array(HarnessPreview.project.raw["agents"].array), "threads": .array((0..<1500).map { row($0).raw })])
        let bytes = try payload.data()
        let start = ContinuousClock.now
        var count = 0
        for _ in 0..<5 { count += try JSON.decode(bytes)["threads"].array.count }
        report("snapshot-json", since: start, operations: bytes.count * 5)
        XCTAssertEqual(count, 7500)
    }
    func testBenchmarkPresentation() {
        let messages = (0..<600).flatMap { index in [
            Message(.object(["id": .string("u-\(index)"), "kind": .string("user_message"), "text": .string("Please review the code in this project, keeping the original behavior.")])),
            Message(.object(["id": .string("a-\(index)"), "kind": .string("assistant_message"), "text": .string("This is a settled response.")]))
        ] }
        let start = ContinuousClock.now
        var total = 0
        for _ in 0..<10 {
            total += TranscriptBlock.build(messages, preferences: ConversationPreferences(raw: .null), running: true).count
            total += TranscriptBlock.actionMessageIDs(messages).count
        }
        report("presentation", since: start, operations: 10)
        XCTAssertEqual(total, 18000)
    }
    func testBenchmarkCachedPresentation() {
        let chat = ChatSession()
        chat.transcript = Transcript(items: (0..<1200).map { Message(.object(["id": .string("m-\($0)"), "kind": .string($0.isMultiple(of: 2) ? "user_message" : "assistant_message"), "text": .string("A settled response or typed prompt")])) })
        let preferences = ConversationPreferences(raw: .null)
        _ = chat.presentation(preferences: preferences, running: true)
        let start = ContinuousClock.now
        var count = 0
        for _ in 0..<1000 { count += chat.presentation(preferences: preferences, running: true).blocks.count }
        report("cached-presentation", since: start, operations: 1000)
        XCTAssertEqual(count, 1_200_000)
    }
    func testBenchmarkTwelveConcurrentConversations() {
        let model = AppModel.testing(relay: UnavailablePreviewRelay())
        model.tasks = (0..<3000).map(row)
        let history = (0..<200).map { Message(.object(["id": .string("old-\($0)"), "kind": .string("assistant_message"), "text": .string("Earlier settled response")])) }
        let chats = model.tasks.prefix(12).map { task in
            let chat = model.chat(for: task); chat.loaded = true; chat.transcript = Transcript(items: history); return chat
        }
        let start = ContinuousClock.now
        for round in 0..<200 {
            for (index, task) in model.tasks.prefix(12).enumerated() {
                model.applyEnvelope(.object(["seq": .number(Double(round * 12 + index + 1)), "thread_id": .string(task.id), "event": .object(["type": .string("text"), "item_id": .string("live"), "target": .string("assistant_message"), "delta": .string("Words 👋 "), "start_offset": .number(Double(round * 9)), "end_offset": .number(Double((round + 1) * 9))])]))
            }
            _ = chats[0].presentation(preferences: ConversationPreferences(raw: .null), running: true)
        }
        report("twelve-conversations", since: start, operations: 2400)
        for chat in chats {
            XCTAssertFalse(chat.transcript.needsRecovery)
            XCTAssertEqual(chat.transcript.items.last?.text, String(repeating: "Words 👋 ", count: 200))
        }
    }

}
