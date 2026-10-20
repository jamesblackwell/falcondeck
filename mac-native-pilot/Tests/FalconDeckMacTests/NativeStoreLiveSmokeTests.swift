import Foundation
import XCTest
@testable import FalconDeckMac

/// Delegates the real daemon protocol while keeping AppStore's production-only
/// Keychain, notification, remote-host and UserDefaults hooks out of this smoke.
private actor LiveSmokeDaemon: DaemonServing {
    struct Request: Sendable {
        let path: [String]
        let method: String
    }

    private let client: DaemonClient
    private(set) var requests: [Request] = []
    private(set) var eventTypes: Set<String> = []

    init(endpoint: URL?) { client = DaemonClient(baseURL: endpoint) }
    func snapshot() async throws -> JSON { try await client.snapshot() }
    func threadDetail(projectID: String, threadID: String, before: String?) async throws -> JSON {
        try await client.threadDetail(projectID: projectID, threadID: threadID, before: before)
    }
    func connectProject(path: String) async throws -> Project { try await client.connectProject(path: path) }
    func startThread(projectID: String, provider: String?, modelID: String?) async throws -> AgentTask {
        try await client.startThread(projectID: projectID, provider: provider, modelID: modelID)
    }
    func sendTurn(projectID: String, threadID: String, text: String, userItemID: String?) async throws -> JSON {
        try await client.sendTurn(projectID: projectID, threadID: threadID, text: text, userItemID: userItemID)
    }
    func interrupt(projectID: String, threadID: String) async throws {
        try await client.interrupt(projectID: projectID, threadID: threadID)
    }
    func respond(projectID: String, requestID: String, response: JSON) async throws {
        try await client.respond(projectID: projectID, requestID: requestID, response: response)
    }
    func markRead(projectID: String, threadID: String, readSeq: Int) async throws {
        try await client.markRead(projectID: projectID, threadID: threadID, readSeq: readSeq)
    }
    func disconnect() async { await client.disconnect() }
    func requestJSON(_ path: [String], method: String, query: [URLQueryItem], body: JSON?) async throws -> JSON {
        requests.append(.init(path: path, method: method))
        return try await client.requestJSON(path, method: method, query: query, body: body)
    }
    func events() async throws -> AsyncThrowingStream<JSON, Error> {
        let upstream = try await client.events()
        return AsyncThrowingStream { continuation in
            let reader = Task {
                do {
                    for try await envelope in upstream {
                        self.recordEvent(envelope)
                        continuation.yield(envelope)
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in reader.cancel() }
        }
    }
    private func recordEvent(_ envelope: JSON) { eventTypes.insert(envelope["event"]["type"].string) }
}

final class NativeStoreLiveSmokeTests: XCTestCase {
    @MainActor func testRealProjectCreateSendReceiveContinueAndArchive() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["FALCONDECK_NATIVE_LIVE_SMOKE"] == "1" else {
            throw XCTSkip("Set FALCONDECK_NATIVE_LIVE_SMOKE=1 to create one live no-tool smoke task.")
        }
        let endpoint = environment["FALCONDECK_DAEMON_URL"].flatMap(URL.init(string:))
        if let endpoint {
            guard endpoint.scheme == "http", ["127.0.0.1", "localhost", "::1"].contains(endpoint.host ?? "") else {
                throw PilotError("The native live smoke requires a loopback daemon endpoint.")
            }
        }
        let daemon = LiveSmokeDaemon(endpoint: endpoint)
        let snapshot = try await daemon.snapshot()
        let project = try XCTUnwrap(snapshot["workspaces"].array.map(Project.init).first {
            $0.raw["kind"].string == "project" && $0.path == "/Users/James/www/sites/falcondeck"
        }, "This opt-in smoke only uses the already-connected FalconDeck project.")
        let existingIDs = Set(snapshot["threads"].array.map { $0["id"].string })
        let store = AppStore(client: daemon)
        var createdID: String?
        var archived = false
        do {
            await store.reconnect()
            try await wait(until: Date().addingTimeInterval(20), context: "initial event-stream snapshot") {
                store.isConnected && store.allProjects.contains { $0.id == project.id }
            }
            // Selecting a project normally opens its newest task asynchronously.
            // Finish that read first so it cannot steal the new-task selection
            // while the create request is awaiting its HTTP response.
            if let existing = store.tasks.first(where: { $0.projectID == project.id }) {
                await store.selectTask(existing.id)
            } else { store.selectProject(project.id) }
            store.newTask()
            store.provider = "codex"
            let firstPrompt = "Reply exactly NATIVE_PARITY_SMOKE_OK. Do not use tools or change files."
            store.draft = firstPrompt
            let firstDeadline = Date().addingTimeInterval(120)
            await store.sendInputs([.object(["type": .string("text"), "text": .string(firstPrompt)])], settings: [:])
            createdID = store.selectedTaskID
            let taskID = try XCTUnwrap(createdID, store.errorMessage ?? "The native composer did not create a task.")
            XCTAssertFalse(existingIDs.contains(taskID), "The smoke must never send into an existing task.")
            guard !existingIDs.contains(taskID) else { throw PilotError("The smoke unexpectedly selected an existing task.") }
            XCTAssertEqual(store.selectedProjectID, project.id)
            try await waitForReply("NATIVE_PARITY_SMOKE_OK", store: store, deadline: firstDeadline)
            XCTAssertNil(store.pendingSubmission, "A confirmed live send must clear its recovery record.")
            XCTAssertEqual(store.draft, "")
            XCTAssertTrue(store.messages.contains { $0.kind == "user_message" && $0.text == firstPrompt })

            // Exercise the same scoped PATCH used by native task actions.
            let title = "Native parity smoke \(UUID().uuidString.prefix(8))"
            let firstTask = try XCTUnwrap(store.selectedTask)
            try await store.updateTask(firstTask, patch: .object(["title": .string(title)]))
            XCTAssertEqual(store.selectedTask?.title, title)

            let firstAssistantIDs = Set(store.messages.filter { $0.kind == "assistant_message" }.map(\.id))
            let followUp = "Reply exactly NATIVE_PARITY_CONTINUED_OK. Do not use tools or change files."
            store.draft = followUp
            let secondDeadline = Date().addingTimeInterval(120)
            await store.sendInputs([.object(["type": .string("text"), "text": .string(followUp)])], settings: [:])
            XCTAssertEqual(store.selectedTaskID, taskID, "A follow-up must continue the same native task.")
            try await waitForReply("NATIVE_PARITY_CONTINUED_OK", store: store, deadline: secondDeadline,
                                   excluding: firstAssistantIDs)
            XCTAssertNil(store.pendingSubmission)
            XCTAssertEqual(store.draft, "")
            XCTAssertTrue(store.messages.contains { $0.kind == "user_message" && $0.text == followUp })
            let agentToolCalls = store.messages.filter {
                $0.kind == "tool_call" && !$0.title.hasPrefix("Hook · ")
            }
            XCTAssertTrue(agentToolCalls.isEmpty, "The smoke forbids agent tools; automatic harness hooks are separate.")

            let ownTask = try XCTUnwrap(store.tasks.first { $0.id == taskID })
            XCTAssertEqual(ownTask.status, "idle")
            try await NativeTaskActions.archive(ownTask, store: store)
            let archivedDetail = try await daemon.threadDetail(projectID: project.id, threadID: taskID, before: nil)
            XCTAssertTrue(archivedDetail["thread"]["is_archived"].bool, "Verify archive through a fresh daemon read.")
            guard archivedDetail["thread"]["is_archived"].bool else { throw PilotError("The smoke task was not archived.") }
            archived = true
            let requests = await daemon.requests
            XCTAssertEqual(requests.filter { $0.method == "POST" && $0.path == ["api", "workspaces", project.id, "threads"] }.count, 1)
            XCTAssertEqual(requests.filter { $0.method == "POST" && $0.path == ["api", "workspaces", project.id, "threads", taskID, "turns"] }.count, 2)
            XCTAssertEqual(requests.filter { $0.method == "PATCH" && $0.path == ["api", "workspaces", project.id, "threads", taskID] }.count, 1)
            XCTAssertEqual(requests.filter { $0.method == "POST" && $0.path == ["api", "workspaces", project.id, "threads", taskID, "archive"] }.count, 1)
            let events = await daemon.eventTypes
            XCTAssertTrue(events.contains("snapshot"))
            XCTAssertTrue(events.contains("conversation-item-added"), "Replies must arrive through the real event stream.")
            print("Native AppStore live smoke task \(taskID): received two acknowledgments, patched title, verified own idle task archived through a fresh daemon read.")
            await store.prepareForQuit()
        } catch {
            // Clean up only the task this test created, and only once it is idle.
            if let createdID, !existingIDs.contains(createdID), !archived {
                if let task = store.tasks.first(where: { $0.id == createdID }), task.status == "idle" {
                    try? await NativeTaskActions.archive(task, store: store)
                } else {
                    print("Native smoke left its own task \(createdID) visible because it was not idle; no automatic stop or resend was attempted.")
                }
            }
            await store.prepareForQuit()
            throw error
        }
    }

    @MainActor private func waitForReply(_ expected: String, store: AppStore, deadline: Date,
                                        excluding: Set<String> = []) async throws {
        try await wait(until: deadline, context: "assistant acknowledgment \(expected)") {
            if store.selectedTask?.awaitingInput == true || store.selectedTask?.status == "error" {
                throw PilotError("The smoke task needs attention: \(store.selectedTask?.status ?? "unknown"). \(store.errorMessage ?? "")")
            }
            if store.pendingSubmission != nil, !store.isSending {
                throw PilotError(store.errorMessage ?? "The live send was not confirmed; it was not retried.")
            }
            return store.selectedTask?.status == "idle" && store.messages.contains {
                $0.kind == "assistant_message" && !excluding.contains($0.id) &&
                $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == expected && !$0.streaming
            }
        }
    }

    @MainActor private func wait(until deadline: Date, context: String,
                                 condition: @MainActor () throws -> Bool) async throws {
        while Date() < deadline {
            if try condition() { return }
            try await Task.sleep(for: .milliseconds(200))
        }
        throw PilotError("Timed out waiting for \(context). No mutation was retried.")
    }
}
