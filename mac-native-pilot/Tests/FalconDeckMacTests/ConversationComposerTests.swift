import XCTest
@testable import FalconDeckMac

final class ConversationComposerTests: XCTestCase {
    func testSkillAliasMatchesWholeSlashTokenOnce() {
        let skill = JSON.object(["id": .string("review-id"), "alias": .string("review" )])
        XCTAssertEqual(ConversationCatalog.selectedSkills("/review check /review", skills: [skill]).count, 1)
        XCTAssertTrue(ConversationCatalog.selectedSkills("/review/docs /reviewer /tmp/review", skills: [skill]).isEmpty)
    }

    func testRestoredPermissionsRequireLiveProviderCapability() {
        let project = Project(.object(["id": .string("p"), "default_provider": .string("a"), "agents": .array([
            .object(["provider": .string("a"), "capabilities": .object(["permission_modes": .array([.string("default")]), "sandbox_modes": .array([.string("read-only")])])])
        ])]))
        let selection = NativeComposerSelection(fields: ["permission_mode": .string("bypassPermissions"), "approval_policy": .string("never"), "sandbox_mode": .string("danger-full-access")])
        let validated = selection.validated(project: project, provider: "a")
        XCTAssertNil(validated.fields["permission_mode"])
        XCTAssertNil(validated.fields["approval_policy"])
        XCTAssertNil(validated.fields["sandbox_mode"])
    }

    func testChangingModelResetsEffortAndSpeed() {
        var selection = NativeComposerSelection(fields: ["reasoning_effort": .string("high"), "service_tier": .string("fast")])
        selection.select("model_id", value: "different", provider: "agent")
        XCTAssertEqual(selection.fields["model_id"], .string("different"))
        XCTAssertEqual(selection.fields["reasoning_effort"], .null)
        // Omitting the field leaves an existing task's speed unchanged.
        XCTAssertEqual(selection.fields["service_tier"], .null)
    }

    func testExistingTaskDoesNotInheritNewTaskPermissionAndModelPicks() {
        let project = Project(.object(["id": .string("p")]))
        let task = AgentTask(.object(["id": .string("existing"), "agent": .object([
            "model_id": .string("task-model"), "permission_mode": .string("default"), "sandbox_mode": .string("read-only")
        ])]))
        let stored = NativeComposerSelection(fields: ["model_id": .string("preferred-model"), "permission_mode": .string("never"), "sandbox_mode": .string("danger-full-access")])
        let restored = NativeComposerSelection.restored(stored, task: task, project: project, provider: "codex")
        XCTAssertTrue(restored.fields.isEmpty)
        XCTAssertEqual(restored.value("model_id", task: task), "task-model")
        XCTAssertEqual(restored.value("permission_mode", task: task), "default")
        XCTAssertEqual(restored.value("sandbox_mode", task: task), "read-only")
        XCTAssertEqual(NativeComposerSelection.restored(NativeComposerSelection(fields: ["model_id": .string("preferred-model")]), task: nil, project: project, provider: "codex").fields["model_id"], .string("preferred-model"))
    }

    func testEffortValidationUsesExistingTaskModelInsteadOfProviderDefault() {
        func model(_ id: String, effort: String, isDefault: Bool) -> JSON {
            .object(["id": .string(id), "is_default": .bool(isDefault), "supported_reasoning_efforts": .array([
                .object(["reasoning_effort": .string(effort)])
            ])])
        }
        let project = Project(.object(["id": .string("p"), "default_provider": .string("codex"), "models": .array([
            model("default-model", effort: "low", isDefault: true), model("task-model", effort: "high", isDefault: false)
        ])]))
        let task = AgentTask(.object(["id": .string("t"), "agent": .object(["model_id": .string("task-model")])]))
        let selection = NativeComposerSelection(fields: ["reasoning_effort": .string("high")])
        XCTAssertEqual(selection.validated(project: project, provider: "codex", task: task).fields["reasoning_effort"], .string("high"))
        XCTAssertNil(selection.validated(project: project, provider: "codex").fields["reasoning_effort"])
    }

    func testSavedPromptInsertionKeepsArgumentsAndEarlierLines() {
        let prompt = ConversationSlashItem(raw: .object(["id": .string("test"), "alias": .string("/test"), "body": .string("Run tests for $ARGUMENTS")]), isPrompt: true)
        XCTAssertEqual(ConversationSlash.insert(prompt, into: "Earlier text\n/test networking"), "Earlier text\nRun tests for networking")
        XCTAssertEqual(ConversationSlash.expandPrompt("Review this code", arguments: "networking"), "Review this code\n\nnetworking")
        XCTAssertNil(ConversationSlash.query("/Users/James/project"))
    }

    func testExportPreservesEmbeddedFencesAndMarksPartialHistory() {
        let message = Message(.object(["id": .string("tool"), "kind": .string("tool_call"), "output": .string("```nested```"), "title": .string("Run test")]))
        let export = ConversationExport.markdown([message], title: "Example", partial: true)
        XCTAssertTrue(export.contains("Partial export"))
        XCTAssertTrue(export.contains("````text\n```nested```\n````"))
    }
}
