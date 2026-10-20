import Foundation
import XCTest
@testable import FalconDeckMac

private func inspectorDocument(_ path: String, text: String = "Original", version: String = "opaque:1") -> JSON {
    .object(["path": .string(path), "content": .string(text), "version": .string(version), "is_binary": .bool(false), "truncated": .bool(false)])
}

private actor InspectorDaemon: DaemonServing {
    struct Write: Sendable { let path: [String]; let query: [URLQueryItem]; let body: JSON? }
    var writes: [Write] = []
    var reads: [String] = []
    var failWrites = false
    var heldPath: String?
    var held: CheckedContinuation<JSON, Error>?
    var waiting: CheckedContinuation<Void, Never>?
    var holdWrites = false
    var heldWrite: CheckedContinuation<Void, Never>?
    var writeWaiter: CheckedContinuation<Void, Never>?

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
        let file = query.first { $0.name == "path" }?.value ?? ""
        if method == "PUT" {
            writes.append(Write(path: path, query: query, body: body))
            if failWrites { throw PilotError("file changed on disk; reload it before saving") }
            if holdWrites {
                await withCheckedContinuation { continuation in heldWrite = continuation; writeWaiter?.resume(); writeWaiter = nil }
            }
            return inspectorDocument(file, text: body?["content"].string ?? "", version: "opaque:2")
        }
        if path.suffix(2) == ["files", "content"] {
            reads.append(file)
            if file == heldPath {
                return try await withCheckedThrowingContinuation { continuation in
                    held = continuation; waiting?.resume(); waiting = nil
                }
            }
            return inspectorDocument(file, text: "Contents of \(file)")
        }
        if path.last == "status" { return .object(["branch": .string("main"), "entries": .array([])]) }
        if path.last == "files" { return .object(["files": .array([]), "truncated": .bool(false)]) }
        return .null
    }
    func hold(_ path: String) { heldPath = path }
    func waitForRead() async { if held != nil { return }; await withCheckedContinuation { waiting = $0 } }
    func finishRead() { held?.resume(returning: inspectorDocument(heldPath ?? "", text: "Stale file")); held = nil }
    func rejectWrites() { failWrites = true }
    func delayWrites() { holdWrites = true }
    func waitForWrite() async { if heldWrite != nil { return }; await withCheckedContinuation { writeWaiter = $0 } }
    func finishWrite() { heldWrite?.resume(); heldWrite = nil }
    func capturedWrites() -> [Write] { writes }
    func capturedReads() -> [String] { reads }
}

final class InspectorTests: XCTestCase {
    func testTreeOnlyIncludesExpandedDescendantsAndSearchRevealsAncestors() {
        let paths = ["src/deep/main.swift", "src/main.swift", "README.md", "assets/icon.png"]
        let collapsed = InspectorFileTree.rows(paths: paths, expanded: [])
        XCTAssertEqual(collapsed.map(\.path), ["assets", "src", "README.md"])
        let expanded = InspectorFileTree.rows(paths: paths, expanded: ["src"])
        XCTAssertEqual(expanded.map(\.path), ["assets", "src", "src/deep", "src/main.swift", "README.md"])
        XCTAssertEqual(InspectorFileTree.rows(paths: ["src/deep/main.swift"], expanded: [], search: true).map(\.path), ["src", "src/deep", "src/deep/main.swift"])
    }

    @MainActor func testSaveUsesOpaqueVersionAndThreadScopedDaemonPath() async throws {
        let daemon = InspectorDaemon(), store = AppStore(client: daemon), model = NativeInspectorModel()
        model.projectID = "project"; model.threadID = "task"; model.scope = "project:task"
        await model.select(path: "src/My file.swift", store: store, tab: .files)
        model.file?.text = "Edited"
        await model.save(store: store)
        let writes = await daemon.capturedWrites()
        let write = try XCTUnwrap(writes.first)
        XCTAssertEqual(write.path, ["api", "workspaces", "project", "files", "content"])
        XCTAssertEqual(write.query.first { $0.name == "path" }?.value, "src/My file.swift")
        XCTAssertEqual(write.query.first { $0.name == "thread_id" }?.value, "task")
        XCTAssertEqual(write.body?["expected_version"], .string("opaque:1"))
        XCTAssertEqual(write.body?["content"], .string("Edited"))
        XCTAssertEqual(model.file?.raw["version"], .string("opaque:2"))
        XCTAssertEqual(model.file?.dirty, false)
    }

    @MainActor func testConflictKeepsEditsAndOldVersionForExplicitRecovery() async {
        let daemon = InspectorDaemon(), store = AppStore(client: daemon), model = NativeInspectorModel()
        model.projectID = "project"; model.threadID = "task"; model.scope = "project:task"
        await model.select(path: "file.swift", store: store, tab: .files)
        model.file?.text = "Unsaved correction"
        await daemon.rejectWrites()
        await model.save(store: store)
        XCTAssertEqual(model.file?.text, "Unsaved correction")
        XCTAssertEqual(model.file?.raw["version"], .string("opaque:1"))
        XCTAssertEqual(model.file?.dirty, true)
        XCTAssertFalse(model.saving)
        XCTAssertTrue(model.fileError?.contains("changed on disk") == true)
    }

    @MainActor func testSwitchingFilesPreservesOnlyDirtyDraftAndDoesNotReloadIt() async {
        let daemon = InspectorDaemon(), store = AppStore(client: daemon), model = NativeInspectorModel()
        model.projectID = "project"; model.scope = "project:task"
        await model.select(path: "a.swift", store: store, tab: .files)
        model.file?.text = "Pending edits"
        await model.select(path: "b.swift", store: store, tab: .files)
        await model.select(path: "a.swift", store: store, tab: .files)
        XCTAssertEqual(model.file?.text, "Pending edits")
        let reads = await daemon.capturedReads()
        XCTAssertEqual(reads.filter { $0 == "a.swift" }.count, 1)
    }

    @MainActor func testLateReadCannotOverwriteNewFileSelection() async {
        let daemon = InspectorDaemon(), store = AppStore(client: daemon), model = NativeInspectorModel()
        model.projectID = "project"; model.scope = "project:task"
        await daemon.hold("a.swift")
        let first = Task { await model.select(path: "a.swift", store: store, tab: .files) }
        await daemon.waitForRead()
        await model.select(path: "b.swift", store: store, tab: .files)
        await daemon.finishRead()
        await first.value
        XCTAssertEqual(model.selectedPath, "b.swift")
        XCTAssertEqual(model.file?.text, "Contents of b.swift")
        XCTAssertFalse(model.loadingFile)
    }

    @MainActor func testSaveFinishingAfterNavigationKeepsLaterEditsWithoutBlockingOtherFiles() async {
        let daemon = InspectorDaemon(), store = AppStore(client: daemon), model = NativeInspectorModel()
        model.projectID = "project"; model.scope = "project:task"
        await model.select(path: "a.swift", store: store, tab: .files)
        model.file?.text = "Sent to disk"
        await daemon.delayWrites()
        let save = Task { await model.save(store: store) }
        await daemon.waitForWrite()
        model.file?.text = "Typed while saving"
        await model.select(path: "b.swift", store: store, tab: .files)
        XCTAssertFalse(model.saving)
        await daemon.finishWrite()
        await save.value
        await model.select(path: "a.swift", store: store, tab: .files)
        XCTAssertEqual(model.file?.text, "Typed while saving")
        XCTAssertEqual(model.file?.original, "Sent to disk")
        XCTAssertEqual(model.file?.raw["version"], .string("opaque:2"))
        XCTAssertEqual(model.file?.dirty, true)
        XCTAssertFalse(model.saving)
    }

    @MainActor func testRefreshDoesNotEraseTypingThatStartedWhileReadWasInFlight() async {
        let daemon = InspectorDaemon(), store = AppStore(client: daemon), model = NativeInspectorModel()
        model.projectID = "project"; model.scope = "project:task"
        await model.select(path: "a.swift", store: store, tab: .files)
        await daemon.hold("a.swift")
        let refresh = Task { await model.loadSelection(store: store, tab: .files) }
        await daemon.waitForRead()
        model.file?.editing = true
        model.file?.text = "Typed during refresh"
        await daemon.finishRead()
        await refresh.value
        XCTAssertEqual(model.file?.text, "Typed during refresh")
        XCTAssertEqual(model.file?.dirty, true)
        XCTAssertEqual(model.file?.editing, true)
        XCTAssertFalse(model.loadingFile)
    }

    func testMissingVersionAndBinaryOrTruncatedFilesAreNotEditable() {
        XCTAssertFalse(InspectorDocument(inspectorDocument("a").setting("version", .null)).editable)
        XCTAssertFalse(InspectorDocument(inspectorDocument("a").setting("content", .null).setting("is_binary", .bool(true))).editable)
        XCTAssertFalse(InspectorDocument(inspectorDocument("a").setting("truncated", .bool(true))).editable)
        XCTAssertTrue(InspectorDocument(inspectorDocument("a", text: "")).editable)
    }
}
