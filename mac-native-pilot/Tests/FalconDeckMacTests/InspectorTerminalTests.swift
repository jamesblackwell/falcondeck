import Foundation
import XCTest
@testable import FalconDeckMac

private func terminalInfo(_ id: String) -> JSON {
    .object(["id": .string(id), "workspace_id": .string("project"), "title": .string("Fixture"), "cwd": .string("/fixture")])
}

private actor TerminalLifecycleDaemon: DaemonServing {
    var heldList: CheckedContinuation<JSON, Error>?
    var heldCreate: CheckedContinuation<JSON, Error>?
    var listWaiter: CheckedContinuation<Void, Never>?
    var createWaiter: CheckedContinuation<Void, Never>?

    func snapshot() async throws -> JSON { .null }
    func threadDetail(projectID: String, threadID: String, before: String?) async throws -> JSON { .null }
    func connectProject(path: String) async throws -> Project { Project(.null) }
    func startThread(projectID: String, provider: String?, modelID: String?) async throws -> AgentTask { AgentTask(.null) }
    func sendTurn(projectID: String, threadID: String, text: String, userItemID: String?) async throws -> JSON { .null }
    func interrupt(projectID: String, threadID: String) async throws {}
    func respond(projectID: String, requestID: String, response: JSON) async throws {}
    func markRead(projectID: String, threadID: String, readSeq: Int) async throws {}
    func events() async throws -> AsyncThrowingStream<JSON, Error> { AsyncThrowingStream { $0.finish() } }
    func disconnect() async {}
    func requestJSON(_ path: [String], method: String, query: [URLQueryItem], body: JSON?) async throws -> JSON {
        if path.last == "terminals", method == "GET" {
            return try await withCheckedThrowingContinuation { heldList = $0; listWaiter?.resume(); listWaiter = nil }
        }
        if path.last == "terminals", method == "POST" {
            return try await withCheckedThrowingContinuation { heldCreate = $0; createWaiter?.resume(); createWaiter = nil }
        }
        return .null
    }
    func waitForList() async { if heldList != nil { return }; await withCheckedContinuation { listWaiter = $0 } }
    func waitForCreate() async { if heldCreate != nil { return }; await withCheckedContinuation { createWaiter = $0 } }
    func finishList(_ infos: [JSON]) { heldList?.resume(returning: .object(["sessions": .array(infos)])); heldList = nil }
    func finishCreate(_ id: String) { heldCreate?.resume(returning: .object(["session": terminalInfo(id)])); heldCreate = nil }
}

final class InspectorTerminalTests: XCTestCase {
    @MainActor func testOlderListDoesNotMarkNewlyCreatedTerminalExited() async {
        let daemon = TerminalLifecycleDaemon(), store = AppStore(client: daemon), model = NativeTerminalPanelModel()
        model.workspaceID = "project"
        let create = Task { await model.create(store: store) }
        await daemon.waitForCreate()
        let load = Task { await model.load("project", store: store) }
        await daemon.waitForList()
        await daemon.finishCreate("new")
        await create.value
        await daemon.finishList([])
        await load.value
        XCTAssertEqual(model.tabs.map(\.id), ["new"])
        XCTAssertNotEqual(model.active?.status, .exited)
        model.detach()
    }

    @MainActor func testOlderListDoesNotReopenTerminalClosedDuringLoad() async throws {
        let daemon = TerminalLifecycleDaemon(), store = AppStore(client: daemon), model = NativeTerminalPanelModel()
        let session = NativeTerminalSession(info: try XCTUnwrap(NativeTerminalInfo(terminalInfo("closed"))))
        model.workspaceID = "project"; model.sessions["project"] = [session]
        store.terminalCreationRequest = UUID()
        let load = Task { await model.load("project", store: store) }
        await daemon.waitForList()
        await model.close(session, store: store)
        await daemon.finishList([terminalInfo("closed")])
        await load.value
        XCTAssertTrue(model.tabs.isEmpty)
        model.detach()
    }

    @MainActor func testCreationFinishingAfterHideDoesNotRestoreActiveScope() async {
        let daemon = TerminalLifecycleDaemon(), store = AppStore(client: daemon), model = NativeTerminalPanelModel()
        model.workspaceID = "project"
        let create = Task { await model.create(store: store) }
        await daemon.waitForCreate()
        model.detach()
        await daemon.finishCreate("new")
        await create.value
        XCTAssertNil(model.workspaceID)
        XCTAssertNil(model.active)
        XCTAssertEqual(model.sessions["project"]?.map(\.id), ["new"], "The daemon shell remains available for a later attach")
    }

    @MainActor func testOlderListDoesNotReopenNewTerminalClosedDuringLoad() async throws {
        let daemon = TerminalLifecycleDaemon(), store = AppStore(client: daemon), model = NativeTerminalPanelModel()
        model.workspaceID = "project"
        store.terminalCreationRequest = UUID()
        let create = Task { await model.create(store: store) }
        await daemon.waitForCreate()
        let load = Task { await model.load("project", store: store) }
        await daemon.waitForList()
        await daemon.finishCreate("new")
        await create.value
        await model.close(try XCTUnwrap(model.active), store: store)
        await daemon.finishList([terminalInfo("new")])
        await load.value
        XCTAssertTrue(model.tabs.isEmpty)
        model.detach()
    }

    @MainActor func testListFinishingAfterHideCannotAttachSessions() async {
        let daemon = TerminalLifecycleDaemon(), store = AppStore(client: daemon), model = NativeTerminalPanelModel()
        let load = Task { await model.load("project", store: store) }
        await daemon.waitForList()
        model.detach()
        await daemon.finishList([terminalInfo("late")])
        await load.value
        XCTAssertNil(model.workspaceID)
        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertFalse(model.loading)
    }

    func testBinaryOutputPreservesEscapeSequencesAndNonUTF8Bytes() {
        let payload = Data([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xf0, 0x9f, 0xff])
        var frame = Data([2, 8, 7, 6, 5, 4, 3, 2, 1])
        frame.append(payload)

        let result = NativeTerminalOutput.decode(frame)
        XCTAssertEqual(result?.sequence, 0x0102030405060708)
        XCTAssertEqual(result?.bytes, payload)
        XCTAssertEqual(result?.replay, false)
        frame[0] = 1
        XCTAssertEqual(NativeTerminalOutput.decode(frame)?.replay, true)
    }

    func testMalformedAndInputFramesCannotBecomeOutput() {
        XCTAssertNil(NativeTerminalOutput.decode(Data()))
        XCTAssertNil(NativeTerminalOutput.decode(Data([1, 0, 0])))
        XCTAssertNil(NativeTerminalOutput.decode(Data([0x10, 0, 0, 0, 0, 0, 0, 0, 0])))
        let payload = Data([0x00, 0x1b, 0xff])
        XCTAssertEqual(NativeTerminalOutput.input(payload), Data([0x10]) + payload)
    }

    func testReconnectCursorDropsDuplicateReplayAndDetectsPrunedOutput() {
        var sequence = NativeTerminalSequence()
        XCTAssertEqual(sequence.resumeFrom, 0)
        XCTAssertEqual(sequence.accept(0), .append)
        XCTAssertEqual(sequence.accept(1), .append)
        XCTAssertEqual(sequence.resumeFrom, 2)
        XCTAssertEqual(sequence.accept(1), .duplicate)
        XCTAssertEqual(sequence.accept(0), .duplicate)
        XCTAssertEqual(sequence.resumeFrom, 2)
        XCTAssertEqual(sequence.accept(5), .gap)
        XCTAssertEqual(sequence.resumeFrom, 6)
        XCTAssertEqual(sequence.accept(6), .append)
    }

    func testFreshAttachMayStartAtRetainedReplayAndCursorCannotOverflow() {
        var sequence = NativeTerminalSequence()
        XCTAssertEqual(sequence.accept(127), .append)
        XCTAssertEqual(sequence.resumeFrom, 128)
        XCTAssertEqual(sequence.accept(UInt64.max), .gap)
        XCTAssertEqual(sequence.resumeFrom, UInt64.max)
        XCTAssertEqual(sequence.accept(UInt64.max), .duplicate)
    }
}
