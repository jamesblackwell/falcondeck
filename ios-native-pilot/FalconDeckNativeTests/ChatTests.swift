import XCTest
@testable import FalconDeckNative

final class ChatTests: XCTestCase {
    func testUTF16DeltasDeduplicateOverlapAndDetectGaps() {
        var transcript = Transcript(items: [Message(.object(["id": .string("a"), "kind": .string("assistant_message"), "text": .string("Hi 🦅")]))])
        func delta(_ text: String, _ start: Int, _ end: Int) -> JSON {
            .object(["type": .string("text"), "item_id": .string("a"), "delta": .string(text), "start_offset": .number(Double(start)), "end_offset": .number(Double(end))])
        }
        transcript.apply(delta("!", 5, 6))
        transcript.apply(delta("!", 5, 6))
        XCTAssertEqual(transcript.items[0].text, "Hi 🦅!")
        transcript.apply(delta("🦅! nice", 3, 11))
        XCTAssertEqual(transcript.items[0].text, "Hi 🦅! nice")
        transcript.apply(delta("?", 20, 21))
        XCTAssertTrue(transcript.needsRecovery)
        XCTAssertEqual(transcript.items[0].text, "Hi 🦅! nice")
    }

    func testAuthoritativeEchoReplacesOptimisticRowAndOlderPageDoesNotOverwriteLiveText() {
        var transcript = Transcript()
        transcript.upsert(Message(.object(["id": .string("user-test"), "kind": .string("user_message"), "text": .string("Hello"), "pending": .bool(true)])))
        transcript.apply(.object(["type": .string("conversation-item-added"), "item": .object(["id": .string("user-test"), "kind": .string("user_message"), "text": .string("Hello")])]))
        XCTAssertEqual(transcript.items.count, 1)
        XCTAssertFalse(transcript.items[0].raw["pending"].bool)
        transcript.prepend([Message(.object(["id": .string("older"), "kind": .string("assistant_message"), "text": .string("Previous answer")])), Message(.object(["id": .string("user-test"), "kind": .string("user_message"), "text": .string("stale")]))])
        XCTAssertEqual(transcript.items.map(\.id), ["older", "user-test"])
        XCTAssertEqual(transcript.items.last?.text, "Hello")
    }

    func testStreamingTargetsAndTurnCompletion() {
        var transcript = Transcript()
        transcript.apply(.object(["type": .string("text"), "item_id": .string("thought"), "target": .string("reasoning_summary"), "delta": .string("Considering options"), "start_offset": .number(0), "end_offset": .number(19)]))
        transcript.apply(.object(["type": .string("tool-call-start"), "item_id": .string("tool"), "kind": .string("execute"), "title": .string("Run tests")]))
        transcript.apply(.object(["type": .string("text"), "item_id": .string("tool"), "target": .string("tool_output"), "delta": .string("passed")]))
        transcript.apply(.object(["type": .string("tool-call-end"), "item_id": .string("tool"), "status": .string("succeeded")]))
        transcript.apply(.object(["type": .string("turn-end")]))
        XCTAssertEqual(transcript.items[0].kind, "reasoning")
        XCTAssertEqual(transcript.items[1].kind, "tool_call")
        XCTAssertEqual(transcript.items[1].text, "passed")
        XCTAssertEqual(transcript.items[1].raw["status"].string, "succeeded")
        XCTAssertFalse(transcript.items.contains(where: \.streaming))
    }

    func testChatRequestPreservesTaskPermissions() {
        let task = AgentTask(.object(["id": .string("task"), "workspace_id": .string("project"), "provider": .string("codex")]))
        let params = NativeRequest.turn(task: task, text: "Hello", itemID: "user-local", modelID: "model", effort: "high")
        XCTAssertEqual(params["inputs"].array.first?["text"].string, "Hello")
        XCTAssertEqual(params["user_item_id"].string, "user-local")
        XCTAssertEqual(params["model_id"].string, "model")
        XCTAssertEqual(params["approval_policy"], .null)
        XCTAssertEqual(params["sandbox_mode"], .null)
        XCTAssertEqual(params["permission_mode"], .null)
    }

    func testApprovalScopesAndExplicitlyUnsupportedChoices() {
        let legacy = ApprovalChoice.choices(for: .object([:]))
        XCTAssertEqual(legacy.map(\.id), ["allow", "deny"])
        XCTAssertTrue(ApprovalChoice.choices(for: .object(["approval_decisions": .array([])])).isEmpty)
        let scoped = ApprovalChoice.choices(for: .object(["approval_options": .array([.object(["option_id": .string("opaque-once"), "label": .string("Allow command once"), "decision": .string("allow")])])]))
        XCTAssertEqual(scoped.first?.response["option_id"].string, "opaque-once")
        XCTAssertEqual(scoped.first?.response["kind"].string, "approval_option")
        XCTAssertEqual(scoped.first?.label, "Allow command once")
    }

    func testBothDaemonEventEnvelopeForms() {
        let event = JSON.object(["seq": .number(2), "event": .object(["type": .string("turn-end")])])
        XCTAssertEqual(NativeRequest.events(.object(["kind": .string("daemon-event"), "event": event])), [event])
        XCTAssertEqual(NativeRequest.events(.object(["kind": .string("daemon-events"), "events": .array([event])])), [event])
        XCTAssertTrue(NativeRequest.events(.object(["kind": .string("unrelated"), "events": .array([event])])).isEmpty)
    }
}
