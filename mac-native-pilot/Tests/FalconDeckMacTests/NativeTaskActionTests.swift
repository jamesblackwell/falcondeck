import Foundation
import XCTest
@testable import FalconDeckMac

private func actionTask(_ id: String = "source", provider: String = "codex", status: String = "idle", isolated: Bool = false) -> JSON {
    .object([
        "id": .string(id), "workspace_id": .string("project"), "title": .string("Fix login"),
        "provider": .string(provider), "status": .string(status), "latest_turn_id": .string("last-turn"),
        "updated_at": .string("2026-10-20T08:00:00Z"),
        "variant": isolated ? .object(["path": .string("/tmp/isolated")]) : .null
    ])
}

private func actionProject(nativeFork: Bool = true) -> Project {
    Project(.object([
        "id": .string("project"), "path": .string("/tmp/project"), "default_provider": .string("codex"),
        "agents": .array([.object([
            "provider": .string("codex"), "capabilities": .object(["supports_forking": .bool(nativeFork)])
        ])])
    ]))
}

private actor ActionDaemon: DaemonServing {
    private(set) var snapshotReads = 0
    private(set) var requestedPaths: [[String]] = []
    private let nativeFork: Bool
    private let failRename: Bool
    private var destination: JSON?

    init(nativeFork: Bool = true, failRename: Bool = false) {
        self.nativeFork = nativeFork
        self.failRename = failRename
    }

    // The stream/snapshot deliberately has no destination: the action must
    // adopt its response without waiting for a relay event to deliver it.
    func snapshot() async throws -> JSON {
        snapshotReads += 1
        return .object([
            "workspaces": .array([actionProject(nativeFork: nativeFork).raw]),
            "threads": .array([actionTask()]), "interactive_requests": .array([])
        ])
    }
    func events() async throws -> AsyncThrowingStream<JSON, Error> { AsyncThrowingStream { $0.finish() } }
    func disconnect() async {}
    func connectProject(path: String) async throws -> Project { actionProject(nativeFork: nativeFork) }
    func startThread(projectID: String, provider: String?, modelID: String?) async throws -> AgentTask { AgentTask(actionTask("copy")) }
    func threadDetail(projectID: String, threadID: String, before: String?) async throws -> JSON {
        .object(["thread": destination ?? actionTask(threadID), "items": .array([]), "has_older": .bool(false)])
    }
    func sendTurn(projectID: String, threadID: String, text: String, userItemID: String?) async throws -> JSON { .null }
    func interrupt(projectID: String, threadID: String) async throws {}
    func respond(projectID: String, requestID: String, response: JSON) async throws {}
    func markRead(projectID: String, threadID: String, readSeq: Int) async throws {}
    func requestJSON(_ path: [String], method: String, query: [URLQueryItem], body: JSON?) async throws -> JSON {
        requestedPaths.append(path)
        if method == "GET" {
            return .object(["items": .array([.object([
                "id": .string("user"), "kind": .string("user_message"), "text": .string("Fix login")
            ])])])
        }
        if method == "PATCH", failRename { throw PilotError("Rename failed") }
        // JSON's absent-key subscript returns .null, even when the optional
        // body exists. A create request has no title until the later rename.
        let title = body?["title"] ?? .null
        let thread = actionTask("copy").setting("title", title == .null ? .string("Copied task") : title)
        destination = thread
        return .object(["workspace": actionProject(nativeFork: nativeFork).raw, "thread": thread])
    }
}

final class NativeTaskActionTests: XCTestCase {
    func testCreateFixtureUsesDefaultTitleWhenPayloadHasNoTitle() async throws {
        let daemon = ActionDaemon(nativeFork: false, failRename: true)
        let created = try await daemon.requestJSON(["api", "workspaces", "project", "threads"], method: "POST", query: [], body: .object(["provider": .string("codex")]))
        XCTAssertEqual(created["thread"]["title"], .string("Copied task"))
        let detail = try await daemon.threadDetail(projectID: "project", threadID: "copy", before: nil)
        XCTAssertEqual(detail["thread"], created["thread"])
    }

    func testRunningAndWaitingSourcesCanHandOffButCannotNativeFork() {
        for status in ["running", "waiting_for_input"] {
            let task = AgentTask(actionTask(status: status))
            XCTAssertNotNil(NativeTaskActions.forkBlockedReason(task, provider: "codex", project: actionProject()))
            XCTAssertNil(NativeTaskActions.forkBlockedReason(task, provider: "claude", project: actionProject()))
            XCTAssertNil(NativeTaskActions.forkBlockedReason(task, provider: "codex", project: actionProject(nativeFork: false)))
        }
    }

    func testIsolatedSourceCanOnlyForkOntoAnotherProvider() {
        let task = AgentTask(actionTask(isolated: true))
        XCTAssertNotNil(NativeTaskActions.forkBlockedReason(task, provider: "codex", project: actionProject()))
        XCTAssertNil(NativeTaskActions.forkBlockedReason(task, provider: "claude", project: actionProject()))
    }

    @MainActor func testForkAdoptsResponseWithoutWaitingForSnapshotOrEvent() async throws {
        let daemon = ActionDaemon(), store = AppStore(client: daemon)
        store.allProjects = [actionProject()]
        store.tasks = [AgentTask(actionTask())]

        try await NativeTaskActions.fork(store.tasks[0], provider: "codex", store: store)

        XCTAssertEqual(store.selectedTaskID, "copy")
        XCTAssertTrue(store.tasks.contains { $0.id == "copy" })
        let reads = await daemon.snapshotReads
        XCTAssertEqual(reads, 0)
    }

    @MainActor func testSuccessfulFallbackRemainsSelectedWhenRenameFails() async throws {
        let daemon = ActionDaemon(nativeFork: false, failRename: true), store = AppStore(client: daemon)
        store.allProjects = [actionProject(nativeFork: false)]
        store.tasks = [AgentTask(actionTask())]

        try await NativeTaskActions.fork(store.tasks[0], provider: "codex", store: store)

        XCTAssertEqual(store.selectedTaskID, "copy")
        XCTAssertEqual(store.selectedTask?.title, "Copied task")
    }

    func testHandoffRetainsToolsFileChangesAndPlans() {
        let messages = [
            JSON.object(["id": .string("u"), "kind": .string("user_message"), "text": .string("Fix login")]),
            .object(["id": .string("t"), "kind": .string("tool_call"), "title": .string("npm test"), "output": .string("All tests passed")]),
            .object(["id": .string("f"), "kind": .string("file_change"), "changes": .array([
                .object(["path": .string("src/login.ts"), "diff": .string("+ fixed login")])
            ])]),
            .object(["id": .string("p"), "kind": .string("plan"), "plan": .object(["steps": .array([
                .object(["step": .string("Verify login"), "status": .string("completed")])
            ])])])
        ].map(Message.init)
        let context = NativeTaskActions.boundedContext(messages)
        for evidence in ["Fix login", "npm test", "All tests passed", "src/login.ts", "+ fixed login", "[x] Verify login"] {
            XCTAssertTrue(context.contains(evidence), "Missing retained evidence: \(evidence)")
        }
    }

    func testContextBudgetRetainsOpeningAndRecentWorkWithinLimit() {
        let messages = [Message(.object([
            "id": .string("u"), "kind": .string("user_message"),
            "text": .string("OBJECTIVE " + String(repeating: "middle ", count: 100) + " RECENT WORK")
        ]))]
        let context = NativeTaskActions.boundedContext(messages, limit: 200)
        XCTAssertLessThanOrEqual(context.count, 200)
        XCTAssertTrue(context.contains("OBJECTIVE"))
        XCTAssertTrue(context.contains("RECENT WORK"))
        XCTAssertTrue(context.contains("Middle of transcript omitted"))
        XCTAssertEqual(NativeTaskActions.boundedContext([]), "")
        XCTAssertEqual(NativeTaskActions.boundedContext([Message(.object(["kind": .string("user_message")]))]), "")
    }
}
