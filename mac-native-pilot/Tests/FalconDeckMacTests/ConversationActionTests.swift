import XCTest
@testable import FalconDeckMac

final class ConversationActionTests: XCTestCase {
    func testBareCodexCompactionOmitsUnsupportedInstructions() throws {
        let capabilities: JSON = .object(["supports_compaction": .bool(true), "supports_compaction_instructions": .bool(false)])
        XCTAssertEqual(try ConversationActionSemantics.compactionBody(instructions: " \n", capabilities: capabilities), .object([:]))
        XCTAssertThrowsError(try ConversationActionSemantics.compactionBody(instructions: "Keep the plan", capabilities: capabilities))
        XCTAssertThrowsError(try ConversationActionSemantics.compactionBody(instructions: "", capabilities: .null))
        XCTAssertEqual(try ConversationActionSemantics.compactionBody(instructions: " Keep the plan \n", capabilities: capabilities.setting("supports_compaction_instructions", .bool(true)))["instructions"], .string("Keep the plan"))
    }

    func testBranchControlsRespectProviderIsolationAndPendingRequests() {
        let capabilities: JSON = .object(["supports_forking": .bool(true)])
        let raw: JSON = .object(["id": .string("t"), "status": .string("idle")])
        XCTAssertTrue(ConversationActionSemantics.canBranch(task: AgentTask(raw), capabilities: capabilities))
        for task in [raw.setting("variant", .object(["path": .string("/worktree")])), raw.setting("status", .string("running")), raw.setting("status", .string("waiting_for_input")), raw.setting("attention", .object(["pending_approval_count": .number(1)]))] {
            XCTAssertFalse(ConversationActionSemantics.canBranch(task: AgentTask(task), capabilities: capabilities))
        }
        XCTAssertFalse(ConversationActionSemantics.canBranch(task: AgentTask(raw), capabilities: .null))
    }

    func testRetryDoesNotBranchCommentaryOrSteeringMessages() {
        let user = Message(.object(["id": .string("user"), "kind": .string("user_message"), "turn_id": .string("turn-1")]))
        let answer = Message(.object(["id": .string("answer"), "kind": .string("assistant_message"), "phase": .string("final_answer")]))
        let commentary = Message(answer.raw.setting("id", .string("progress")).setting("phase", .string("commentary")))
        let steer = Message(user.raw.setting("id", .string("steer")).setting("turn_id", .null))
        XCTAssertEqual(ConversationActionSemantics.retrySource(for: answer, messages: [user, answer]), user)
        XCTAssertNil(ConversationActionSemantics.retrySource(for: commentary, messages: [user, commentary]))
        XCTAssertNil(ConversationActionSemantics.retrySource(for: answer, messages: [user, steer, answer]))
        XCTAssertTrue(ConversationActionSemantics.retrySources(messages: [user, steer, answer]).isEmpty)
        XCTAssertEqual(ConversationActionSemantics.retrySources(messages: [user, commentary, answer])[answer.id], user)
        XCTAssertNil(ConversationActionSemantics.retrySource(for: answer, messages: [answer]))
        let streaming = Message(answer.raw.setting("lifecycle", .string("streaming")))
        XCTAssertNil(ConversationActionSemantics.retrySource(for: streaming, messages: [user, streaming]))
    }

    func testFirstMessageBranchPreservesSourcePermissionsAndTurnSettings() {
        let agent: JSON = .object([
            "model_id": .string("task-model"), "approval_policy": .string("untrusted"),
            "permission_mode": .string("untrusted"), "sandbox_mode": .string("read-only"),
            "reasoning_effort": .string("high"), "service_tier": .string("priority"),
            "collaboration_mode_id": .string("plan")
        ])
        let task = AgentTask(.object(["id": .string("t"), "workspace_id": .string("p"), "provider": .string("codex"), "agent": agent]))
        let create = ConversationActionSemantics.newBranchBody(task)
        for key in ["model_id", "approval_policy", "permission_mode", "sandbox_mode", "collaboration_mode_id"] {
            XCTAssertEqual(create[key], agent[key])
        }
        XCTAssertEqual(create["isolation"], .string("project_folder"))
        XCTAssertEqual(ConversationActionSemantics.branchSettings(task)["reasoning_effort"], .string("high"))
        XCTAssertEqual(ConversationActionSemantics.branchSettings(task)["service_tier"], .string("priority"))
    }

    func testOnlyCodexGoalsOfferStatusUpdates() {
        let raw: JSON = .object(["provider": .string("codex"), "goal": .object(["status": .string("active")])])
        XCTAssertTrue(ConversationActionSemantics.canSetGoalStatus(AgentTask(raw)))
        XCTAssertTrue(ConversationActionSemantics.canSetGoalStatus(AgentTask(raw.setting("goal", .object(["status": .string("blocked")])))))
        XCTAssertFalse(ConversationActionSemantics.canSetGoalStatus(AgentTask(raw.setting("provider", .string("claude")))))
        XCTAssertFalse(ConversationActionSemantics.canSetGoalStatus(AgentTask(raw.setting("goal", .object(["status": .string("complete")])))))
    }
}
