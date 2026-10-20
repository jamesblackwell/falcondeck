import XCTest
@testable import FalconDeckMac

final class NativeHostProjectionTests: XCTestCase {
    private let host = "server-a"
    private func scoped(_ id: String) -> JSON { .string("remote:\(host):\(id)") }

    func testSnapshotProjectsRelationshipsWithoutChangingProviderValues() {
        let request: JSON = .object(["request_id": .string("approval"), "workspace_id": .string("project"), "thread_id": .string("thread"), "item_id": .string("item"), "turn_id": .string("turn")])
        let value: JSON = .object([
            "workspaces": .array([.object(["id": .string("project"), "current_thread_id": .string("thread"), "models": .array([.object(["id": .string("model")])])])]),
            "threads": .array([.object(["id": .string("thread"), "workspace_id": .string("project"), "latest_turn_id": .string("turn"), "native_session_id": .string("session"), "agent": .object(["model_id": .string("model")]), "queued_turns": .array([.object(["id": .string("queue")])])])]),
            "interactive_requests": .array([request]), "thread_token_usage": .object(["thread": .object(["total_tokens": .number(42)])])
        ])
        let result = NativeHostProjection.snapshot(value, host: host)
        XCTAssertEqual(result["workspaces"].array[0]["current_thread_id"], scoped("thread"))
        XCTAssertEqual(result["workspaces"].array[0]["models"].array[0]["id"], .string("model"))
        let thread = result["threads"].array[0]
        XCTAssertEqual(thread["id"], scoped("thread"))
        XCTAssertEqual(thread["workspace_id"], scoped("project"))
        XCTAssertEqual(thread["latest_turn_id"], .string("turn"))
        XCTAssertEqual(thread["native_session_id"], .string("session"))
        XCTAssertEqual(thread["queued_turns"].array[0]["id"], .string("queue"))
        XCTAssertEqual(result["interactive_requests"].array[0]["request_id"], scoped("approval"))
        XCTAssertEqual(result["interactive_requests"].array[0]["item_id"], .string("item"))
        XCTAssertEqual(result["thread_token_usage"][scoped("thread").string]["total_tokens"], .number(42))
    }

    func testPreferencesRoundTripMapKeysAndFolderIDs() throws {
        let preferences: JSON = .object([
            "workspace_order": .array([.string("project")]), "workspace_colors": .object(["project": .string("blue")]),
            "workspace_icons": .object(["project": .object(["kind": .string("emoji"), "value": .string("🦅")])]),
            "project_folders": .array([.object(["id": .string("folder"), "workspace_id": .string("project"), "thread_ids": .array([.string("thread")]), "name": .string("remote:server-b:user-written")])])
        ])
        let projected = NativeHostProjection.preferences(preferences, host: host)
        XCTAssertEqual(projected["workspace_colors"][scoped("project").string], .string("blue"))
        XCTAssertEqual(projected["project_folders"].array[0]["id"], scoped("folder"))
        XCTAssertEqual(try NativeHostProjection.rawIDs(projected, host: host), preferences)
    }

    func testCrossHostBodyRelationshipsAndMapKeysAreRejected() {
        for value: JSON in [
            .object(["workspace_id": .string("remote:server-b:project")]),
            .object(["project_folders": .array([.object(["id": .string("remote:server-b:folder")])])]),
            .object(["workspace_icons": .object(["remote:server-b:project": .object([:])])]),
            .object(["target": .object(["kind": .string("thread"), "id": .string("remote:server-b:thread")])]),
            .object(["thread_ids": .array([.string("remote:server-b:thread")])])
        ] { XCTAssertThrowsError(try NativeHostProjection.rawIDs(value, host: host)) }
    }

    func testQueryRelationshipsRejectForeignHostsBeforeStrippingEveryAlias() throws {
        let aliases = ["workspace_id", "workspaceId", "thread_id", "threadId", "request_id", "requestId", "folder_id", "folderId", "current_thread_id", "currentThreadId", "parent_thread_id", "parentThreadId", "before_thread_id", "beforeThreadId", "after_thread_id", "afterThreadId", "task_id", "taskId", "automation_id", "automationId"]
        for key in aliases {
            let owned = URLQueryItem(name: key, value: scoped("same-id").string)
            XCTAssertEqual(try NativeHostProjection.rawQuery([owned], host: host), [URLQueryItem(name: key, value: "same-id")])
            XCTAssertThrowsError(try NativeHostProjection.rawQuery([URLQueryItem(name: key, value: "remote:other-server:same-id")], host: host), key)
        }
        let opaque = [URLQueryItem(name: "path", value: "remote:other-server:file"), URLQueryItem(name: "query", value: "remote:other-server:text"), URLQueryItem(name: "thread_id", value: nil), URLQueryItem(name: "thread_id", value: "plain-id")]
        XCTAssertEqual(try NativeHostProjection.rawQuery(opaque, host: host), opaque, "Opaque values, nil values, and duplicate query items retain their HTTP semantics")
    }

    func testOpaqueInputIDsAndTextSurviveUnprojection() throws {
        let opaque: JSON = .object(["id": .string("remote:server-b:item"), "thread_id": .string("remote:server-b:user-field"), "text": .string("remote:server-b:text")])
        let value: JSON = .object([
            "workspace_id": scoped("project"), "model_id": .string("remote:server-b:model"),
            "user_item_id": .string("remote:server-b:item"), "id": .string("remote:server-b:provider-id"),
            "inputs": .array([opaque]), "input": opaque, "payload": opaque, "value": opaque,
            "target": .object(["kind": .string("custom"), "id": .string("remote:server-b:custom")])
        ])
        let result = try NativeHostProjection.rawIDs(value, host: host)
        XCTAssertEqual(result, value.setting("workspace_id", .string("project")))
    }

    func testDetailAndSearchResponsesProjectEmbeddedRequests() {
        let request: JSON = .object(["request_id": .string("approval"), "workspace_id": .string("project"), "thread_id": .string("thread")])
        let value: JSON = .object([
            "items": .array([.object(["kind": .string("interactive_request"), "id": .string("item"), "request": request]), .object(["kind": .string("tool_call"), "id": .string("tool"), "detail": .object(["id": .string("provider")])])]),
            "matches": .array([.object(["thread_id": .string("thread"), "workspace_id": .string("project"), "snippet": .string("remote:server-b:literal")])]), "oldest_item_id": .string("item")
        ])
        let result = NativeHostProjection.response(value, host: host, path: ["api", "workspaces", "project", "threads", "thread"])
        XCTAssertEqual(result["items"].array[0]["request"]["request_id"], scoped("approval"))
        XCTAssertEqual(result["items"].array[0]["id"], .string("item"))
        XCTAssertEqual(result["items"].array[1], value["items"].array[1])
        XCTAssertEqual(result["matches"].array[0]["thread_id"], scoped("thread"))
        XCTAssertEqual(result["matches"].array[0]["snippet"], value["matches"].array[0]["snippet"])
        XCTAssertEqual(result["oldest_item_id"], .string("item"))
    }

    func testSingleItemEndpointRetainsProviderItemIdentity() {
        let value: JSON = .object(["kind": .string("interactive_request"), "id": .string("item"), "request": .object(["request_id": .string("approval"), "workspace_id": .string("project"), "thread_id": .string("thread")])])
        let result = NativeHostProjection.response(value, host: host, path: ["api", "workspaces", "project", "threads", "thread", "items", "item"])
        XCTAssertEqual(result["id"], .string("item"))
        XCTAssertEqual(result["request"]["request_id"], scoped("approval"))
        XCTAssertEqual(result["host_id"], .null)
    }

    func testRemoteChatCreationReturnsScopedCasualWorkspace() {
        let value: JSON = .object(["id": .string("chat"), "kind": .string("casual"), "current_thread_id": .string("thread")])
        let result = NativeHostProjection.response(value, host: host, path: ["api", "chats"])
        XCTAssertEqual(result["id"], scoped("chat"))
        XCTAssertEqual(result["current_thread_id"], scoped("thread"))
        XCTAssertEqual(result["kind"], .string("casual"))
    }

    func testThreadProvenanceProjectsOnlyRecognizedOrigins() {
        let base: JSON = .object(["id": .string("thread"), "workspace_id": .string("project"), "handoff_from": .object(["thread_id": .string("source"), "provider": .string("codex")])])
        for (kind, key) in [("agent_spawn", "parent_thread_id"), ("scheduled_task", "task_id"), ("automation", "automation_id")] {
            let result = NativeHostProjection.task(base.setting("origin", .object(["kind": .string(kind), key: .string("source"), "title": .string("literal")])), host: host)
            XCTAssertEqual(result["origin"][key], scoped("source"))
            XCTAssertEqual(result["handoff_from"]["thread_id"], scoped("source"))
        }
    }

    func testScheduledEntitiesAndExtensionScopeProjectWithoutOpaqueStateChanges() {
        let run: JSON = .object(["id": .string("run"), "task_id": .string("schedule"), "workspace_id": .string("project"), "thread_id": .string("thread")])
        let task: JSON = .object(["id": .string("schedule"), "workspace_id": .string("project"), "last_run": run, "model_id": .string("model")])
        let result = NativeHostProjection.response(.array([task]), host: host, path: ["api", "scheduled-tasks"])
        XCTAssertEqual(result.array[0]["last_run"]["task_id"], scoped("schedule"))
        XCTAssertEqual(result.array[0]["last_run"]["id"], scoped("run"))
        let view: JSON = .object(["extension_id": .string("notes"), "view_id": .string("panel"), "scope": .object(["kind": .string("thread"), "id": .string("thread")]), "value": .object(["id": .string("note"), "thread_id": .string("opaque")])])
        let extensions = NativeHostProjection.extensions(.object(["views": .array([view]), "catalog": .array([.object(["id": .string("notes")])])]), host: host)
        XCTAssertEqual(extensions["views"].array[0]["scope"]["id"], scoped("thread"))
        XCTAssertEqual(extensions["views"].array[0]["value"], view["value"])
        XCTAssertEqual(extensions["catalog"].array[0]["id"], .string("notes"))
    }

    func testReducerRetainsUnresolvedRequestsOnTurnEndAndRemovesOnlyResolvedRequest() {
        let pending: JSON = .object(["request_id": .string("approval"), "thread_id": .string("thread")])
        let snapshot: JSON = .object(["interactive_requests": .array([pending])])
        let end: JSON = .object(["thread_id": .string("thread"), "event": .object(["type": .string("turn-end")])])
        XCTAssertEqual(NativeHostProjection.reduce(snapshot, envelope: end), snapshot)
        let resolved: JSON = .object(["event": .object(["type": .string("conversation-item-updated"), "item": .object(["kind": .string("interactive_request"), "resolved": .bool(true), "request": pending])])])
        XCTAssertEqual(NativeHostProjection.reduce(snapshot, envelope: resolved)["interactive_requests"], .array([]))
    }

    func testReducerUpdatesSchedulesUsageAndExtensionViewDeletion() {
        let scope: JSON = .object(["kind": .string("thread"), "id": .string("thread")])
        let view: JSON = .object(["extension_id": .string("notes"), "view_id": .string("panel"), "scope": scope, "value": .object([:])])
        var snapshot: JSON = .object(["scheduled_tasks": .array([.object(["id": .string("schedule")])]), "extensions": .object(["views": .array([view])])])
        let run: JSON = .object(["id": .string("run"), "task_id": .string("schedule")])
        snapshot = NativeHostProjection.reduce(snapshot, envelope: .object(["event": .object(["type": .string("scheduled-task-run-updated"), "task_id": .string("schedule"), "run": run])]))
        XCTAssertEqual(snapshot["scheduled_tasks"].array[0]["last_run"], run)
        snapshot = NativeHostProjection.reduce(snapshot, envelope: .object(["thread_id": .string("thread"), "event": .object(["type": .string("thread-token-usage-updated"), "usage": .object(["total_tokens": .number(42)])])]))
        XCTAssertEqual(snapshot["thread_token_usage"]["thread"]["total_tokens"], .number(42))
        snapshot = NativeHostProjection.reduce(snapshot, envelope: .object(["event": .object(["type": .string("extension-view-updated"), "extension_id": .string("notes"), "view_id": .string("panel"), "scope": scope, "view": .null])]))
        XCTAssertEqual(snapshot["extensions"]["views"], .array([]))
    }

    func testOlderThreadSummaryCannotReplaceNewerCachedSummary() {
        let current: JSON = .object(["id": .string("thread"), "updated_at": .string("2026-10-20T12:00:00Z"), "title": .string("New")])
        let snapshot: JSON = .object(["threads": .array([current])])
        let old = current.setting("updated_at", .string("2026-10-19T12:00:00Z")).setting("title", .string("Old"))
        XCTAssertEqual(NativeHostProjection.reduce(snapshot, envelope: .object(["event": .object(["type": .string("thread-updated"), "thread": old])]))["threads"], .array([current]))
    }

    func testEqualTimestampReplayPreservesReadAndActivityWatermarks() {
        func summary(activity: Int, read: Int) -> JSON {
            .object(["id": .string("thread"), "updated_at": .string("2026-10-20T12:00:00Z"), "status": .string("idle"),
                     "attention": .object(["last_agent_activity_seq": .number(Double(activity)), "last_read_seq": .number(Double(read)), "unread": .bool(activity > read), "level": .string(activity > read ? "unread" : "none")])])
        }
        let current = summary(activity: 12, read: 12)
        let replay = summary(activity: 10, read: 8)
        let result = NativeHostProjection.reduce(.object(["threads": .array([current])]), envelope: .object(["event": .object(["type": .string("thread-updated"), "thread": replay])]))
        XCTAssertEqual(result["threads"].array[0]["attention"], current["attention"])

        let unread = summary(activity: 12, read: 0).setting("updated_at", .string("2026-10-20T12:00:01Z"))
        let markedUnread = NativeHostProjection.reduce(result, envelope: .object(["event": .object(["type": .string("thread-updated"), "thread": unread])]))
        XCTAssertEqual(markedUnread["threads"].array[0]["attention"]["last_read_seq"], .number(0), "An explicit newer mark-unread may lower the read watermark")
    }

    func testEqualTimestampReplayCannotReviveSettledThread() {
        let current = JSON.object(["id": .string("thread"), "status": .string("idle"), "updated_at": .string("2026-10-20T12:00:00Z")])
        let replay = current.setting("status", .string("running"))
        let result = NativeHostProjection.reduce(.object(["threads": .array([current])]), envelope: .object(["event": .object(["type": .string("thread-updated"), "thread": replay])]))
        XCTAssertEqual(result["threads"], .array([current]))
    }
}
