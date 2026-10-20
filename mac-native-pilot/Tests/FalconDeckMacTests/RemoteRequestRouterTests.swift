import Foundation
import XCTest
@testable import FalconDeckMac

final class RemoteRequestRouterTests: XCTestCase {
    func testSnapshotBooleansRemainBooleansForRemotePayload() throws {
        let rpc = try NativeRemoteRequestRouter.route(["api", "snapshot"], query: [
            URLQueryItem(name: "include_archived_threads", value: "false"),
            URLQueryItem(name: "include_thread_plans", value: "false"),
            URLQueryItem(name: "include_agent_skills", value: "true")
        ])
        XCTAssertEqual(rpc.method, "snapshot.current")
        XCTAssertEqual(rpc.params["include_archived_threads"], .bool(false))
        XCTAssertEqual(rpc.params["include_thread_plans"], .bool(false))
        XCTAssertEqual(rpc.params["include_agent_skills"], .bool(true))
    }

    func testPagedHistoryPreservesCursorsAndScopeIdentifiers() throws {
        let rpc = try NativeRemoteRequestRouter.route(threadPath, query: [
            URLQueryItem(name: "mode", value: "before"),
            URLQueryItem(name: "limit", value: "60"),
            URLQueryItem(name: "tool_output_bytes", value: "8192"),
            URLQueryItem(name: "before_item_id", value: "item&x=1"),
            URLQueryItem(name: "inline_images", value: "false"),
            URLQueryItem(name: "strict_limit", value: "true"),
            URLQueryItem(name: "compact_workspace", value: "true")
        ])
        XCTAssertEqual(rpc.method, "thread.detail")
        XCTAssertEqual(rpc.params["workspace_id"], .string("project/a"))
        XCTAssertEqual(rpc.params["thread_id"], .string("thread?#"))
        XCTAssertEqual(rpc.params["before_item_id"], .string("item&x=1"))
        XCTAssertEqual(rpc.params["limit"], .number(60))
        XCTAssertEqual(rpc.params["tool_output_bytes"], .number(8192))
        XCTAssertEqual(rpc.params["strict_limit"], .bool(true))
        XCTAssertEqual(rpc.params["inline_images"], .bool(false))
    }

    func testPathTargetsOverrideBodyAndQueryIncludingCamelCaseAliases() throws {
        let rpc = try NativeRemoteRequestRouter.route(threadPath + ["turns"], method: "POST", query: [
            URLQueryItem(name: "workspace_id", value: "query workspace"),
            URLQueryItem(name: "thread_id", value: "query thread")
        ], body: .object([
            "workspace_id": .string("body workspace"), "workspaceId": .string("camel workspace"),
            "thread_id": .string("body thread"), "threadId": .string("camel thread"),
            "user_item_id": .string("user-123"),
            "inputs": .array([.object(["type": .string("text"), "text": .string("Hello, 👋")])]),
            "resume_interrupted": .bool(true)
        ]))
        XCTAssertEqual(rpc.method, "turn.start")
        XCTAssertEqual(rpc.params["workspace_id"], .string("project/a"))
        XCTAssertEqual(rpc.params["thread_id"], .string("thread?#"))
        XCTAssertEqual(rpc.params["workspaceId"], .null)
        XCTAssertEqual(rpc.params["threadId"], .null)
        XCTAssertEqual(rpc.params["user_item_id"], .string("user-123"))
        XCTAssertEqual(rpc.params["inputs"].array.first?["text"], .string("Hello, 👋"))
        XCTAssertEqual(rpc.params["resume_interrupted"], .bool(true))
        for key in ["model_id", "approval_policy", "sandbox_mode", "permission_mode"] {
            XCTAssertEqual(rpc.params[key], .null, "Omitted thread controls must stay omitted")
        }
    }

    func testFileWritePreservesContentAndUsesQueryFileTarget() throws {
        let rpc = try NativeRemoteRequestRouter.route(["api", "workspaces", "workspace", "files", "content"], method: "PUT", query: [
            URLQueryItem(name: "path", value: "Sources/001"),
            URLQueryItem(name: "thread_id", value: "001")
        ], body: .object([
            "content": .string("new content\n"), "expected_version": .string("v1"),
            "path": .string("other file"), "threadId": .string("other thread")
        ]))
        XCTAssertEqual(rpc.method, "workspace.file.write")
        XCTAssertEqual(rpc.params["path"], .string("Sources/001"))
        XCTAssertEqual(rpc.params["thread_id"], .string("001"))
        XCTAssertEqual(rpc.params["threadId"], .null)
        XCTAssertEqual(rpc.params["content"], .string("new content\n"))
        XCTAssertEqual(rpc.params["expected_version"], .string("v1"))
    }

    func testConversationMutationsMapToExistingRPCs() throws {
        let examples: [(String, [String], String)] = [
            ("PATCH", threadPath, "thread.update"),
            ("DELETE", threadPath, "thread.delete"),
            ("POST", threadPath + ["fork"], "thread.fork"),
            ("POST", threadPath + ["suggest-title"], "thread.suggestTitle"),
            ("POST", threadPath + ["archive"], "thread.archive"),
            ("POST", threadPath + ["unarchive"], "thread.unarchive"),
            ("POST", threadPath + ["read"], "thread.mark_read"),
            ("POST", threadPath + ["unread"], "thread.mark_unread"),
            ("POST", threadPath + ["goal"], "thread.goal.set"),
            ("DELETE", threadPath + ["goal"], "thread.goal.clear"),
            ("POST", threadPath + ["interrupt"], "turn.interrupt"),
            ("POST", threadPath + ["compact"], "thread.compact"),
            ("POST", threadPath + ["ship"], "thread.ship")
        ]
        for (verb, path, expected) in examples {
            let rpc = try NativeRemoteRequestRouter.route(path, method: verb)
            XCTAssertEqual(rpc.method, expected)
            XCTAssertEqual(rpc.params["workspace_id"], .string("project/a"))
            XCTAssertEqual(rpc.params["thread_id"], .string("thread?#"))
        }
    }

    func testQueueAndInteractiveRequestsKeepTheirIdentifiers() throws {
        for (verb, suffix, expected) in [
            ("PATCH", ["queue", "queued/1"], "thread.queue.edit"),
            ("DELETE", ["queue", "queued/1"], "thread.queue.remove"),
            ("POST", ["queue", "queued/1", "steer"], "thread.queue.steer"),
            ("GET", ["queue", "queued/1", "attachment-preview"], "thread.queue.attachment_preview")
        ] {
            let rpc = try NativeRemoteRequestRouter.route(threadPath + suffix, method: verb)
            XCTAssertEqual(rpc.method, expected)
            XCTAssertEqual(rpc.params["queued_id"], .string("queued/1"))
        }
        let reorder = try NativeRemoteRequestRouter.route(threadPath + ["queue", "reorder"], method: "POST", body: .object(["queued_ids": .array([.string("second"), .string("first")])]))
        XCTAssertEqual(reorder.method, "thread.queue.reorder")
        XCTAssertEqual(reorder.params["queued_ids"], .array([.string("second"), .string("first")]))
        let response = JSON.object(["kind": .string("question"), "answers": .object(["question": .array([.string("answer")])])])
        let interactive = try NativeRemoteRequestRouter.route(["api", "workspaces", "workspace", "interactive-requests", "request", "respond"], method: "POST", body: .object(["response": response]))
        XCTAssertEqual(interactive.method, "interactive.respond")
        XCTAssertEqual(interactive.params["request_id"], .string("request"))
        XCTAssertEqual(interactive.params["response"], response)
    }

    func testSettingsAdministrationAndWorkspaceRoutesUseRegisteredNames() throws {
        let examples: [(String, String, String)] = [
            ("GET", "api/preferences", "preferences.read"), ("PATCH", "api/preferences", "preferences.update"),
            ("POST", "api/control/get", "control.get"), ("POST", "api/control/execute", "control.execute"),
            ("GET", "api/connectors", "connectors.read"), ("PUT", "api/connectors", "connectors.update"),
            ("GET", "api/providers", "providers.read"), ("PUT", "api/providers", "providers.update"),
            ("GET", "api/provider-usage", "providers.usage"),
            ("POST", "api/provider-usage/codex/reset-credits/consume", "providers.usage.consumeReset"),
            ("GET", "api/harnesses", "harnesses.read"), ("POST", "api/harnesses/refresh", "harnesses.refresh"),
            ("POST", "api/harnesses/upgrade", "harnesses.upgrade"), ("GET", "api/harnesses/jobs/job", "harnesses.job"),
            ("GET", "api/extensions", "extensions.read"), ("PATCH", "api/extensions/extension", "extensions.update"),
            ("PATCH", "api/extensions/extension/permissions", "extensions.permission.update"),
            ("POST", "api/extensions/extension/actions/action", "extensions.action.invoke"),
            ("GET", "api/scheduled-tasks", "scheduled.list"), ("POST", "api/scheduled-tasks", "scheduled.create"),
            ("GET", "api/scheduled-tasks/task", "scheduled.detail"), ("PATCH", "api/scheduled-tasks/task", "scheduled.update"),
            ("DELETE", "api/scheduled-tasks/task", "scheduled.delete"), ("POST", "api/scheduled-tasks/task/run", "scheduled.run"),
            ("GET", "api/scheduled-tasks/task/runs", "scheduled.runs"),
            ("GET", "api/computer-use", "computerUse.read"), ("POST", "api/computer-use", "computerUse.update"),
            ("POST", "api/computer-use/restart", "computerUse.restart"), ("POST", "api/computer-use/test", "computerUse.test"),
            ("GET", "api/speech/openrouter-key", "speech.status"), ("GET", "api/speech/models", "speech.models"),
            ("POST", "api/speech/transcribe", "speech.transcribe"), ("POST", "api/speech/synthesize", "speech.synthesize"),
            ("GET", "api/skills", "skills.read"), ("GET", "api/skills/registry", "skills.registry.search"),
            ("POST", "api/skills/install", "skills.install"), ("DELETE", "api/skills/skill", "skills.uninstall"),
            ("POST", "api/workspaces/connect", "workspace.connect"), ("DELETE", "api/workspaces/workspace", "workspace.remove"),
            ("POST", "api/workspaces/workspace/close", "workspace.close"), ("GET", "api/workspaces/workspace/skills", "workspace.skills"),
            ("GET", "api/workspaces/workspace/prompts", "workspace.prompts"),
            ("POST", "api/workspaces/workspace/providers/claude/hydrate", "provider.hydrate"),
            ("POST", "api/workspaces/workspace/threads", "thread.start"),
            ("POST", "api/workspaces/workspace/threads/archive", "thread.archiveAll"),
            ("GET", "api/workspace-icons/workspace", "workspace.icon"),
            ("GET", "api/workspaces/workspace/git/status", "git.status"), ("GET", "api/workspaces/workspace/git/diff", "git.diff"),
            ("POST", "api/workspaces/workspace/git/commit", "git.commit"), ("GET", "api/workspaces/workspace/files", "workspace.files"),
            ("GET", "api/workspaces/workspace/files/content", "workspace.file.read")
        ]
        for (verb, path, expected) in examples {
            XCTAssertEqual(try NativeRemoteRequestRouter.route(path.split(separator: "/").map(String.init), method: verb).method, expected, path)
        }
        let chat = try NativeRemoteRequestRouter.route(["api", "chats"], method: "POST")
        XCTAssertEqual(chat.method, "chat.create")
        XCTAssertEqual(chat.params["create"], .bool(true))
    }

    func testMalformedScalarQueriesFailInsteadOfChangingDaemonDefaults() {
        for (key, value) in [("limit", "NaN"), ("limit", "-1"), ("limit", "1.5"), ("limit", "9007199254740992"), ("inline_images", "yes")] {
            XCTAssertThrowsError(try NativeRemoteRequestRouter.route(threadPath, query: [URLQueryItem(name: key, value: value)]), "\(key)=\(value)")
        }
        XCTAssertThrowsError(try NativeRemoteRequestRouter.route(threadPath + ["turns"], method: "POST", body: .array([])))
    }

    func testLocalOnlyOperationsFailBeforeAnyRemoteMutation() {
        let unsupported: [(String, String)] = [
            ("GET", "api/backup"), ("POST", "api/backup/import"),
            ("GET", "api/remote/status"), ("POST", "api/remote/pairing"),
            ("POST", "api/hosts/provision"), ("POST", "api/speech/rewrite"),
            ("PUT", "api/speech/openrouter-key"),
            ("POST", "api/workspaces/workspace/threads/thread/review"),
            ("POST", "api/workspaces/workspace/terminals"),
            ("GET", "api/workspaces/workspace/git/branches")
        ]
        for (verb, path) in unsupported {
            XCTAssertThrowsError(try NativeRemoteRequestRouter.route(path.split(separator: "/").map(String.init), method: verb), path)
        }
        XCTAssertThrowsError(try NativeRemoteRequestRouter.route(["api", "workspaces", "", "threads", "thread"]))
    }

    private let threadPath = ["api", "workspaces", "project/a", "threads", "thread?#"]
}
