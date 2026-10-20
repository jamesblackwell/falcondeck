import XCTest
@testable import FalconDeckMac

final class WorkspacePayloadTests: XCTestCase {
    func testExtensionBridgeKeepsRemoteIDsConsistentWithOpaqueActionResults() throws {
        let scope = NativeExtensionBridgeScope(hostID: "host")
        let threadID = NativeHostManager.namespace(hostID: "host", id: "task")
        let opaque: JSON = .object(["threadStages": .object(["task": .string("in_progress")]), "id": .string("remote:other:literal")])
        let view = scope.appView(.object([
            "view_id": .string("thread-tags"),
            "scope": .object(["kind": .string("thread"), "id": .string(threadID)]),
            "value": opaque
        ]))
        XCTAssertEqual(scope.localID(threadID), "task")
        XCTAssertEqual(view["scope"]["id"], .string("task"))
        XCTAssertEqual(view["value"], opaque)
        XCTAssertEqual(try scope.appID("task"), threadID)
        XCTAssertEqual(try scope.appID(threadID), threadID)
        XCTAssertThrowsError(try scope.appID(NativeHostManager.namespace(hostID: "other", id: "task")))
        XCTAssertThrowsError(try NativeExtensionBridgeScope(hostID: nil).appID(threadID))
        XCTAssertEqual(try NativeExtensionBridgeScope(hostID: nil).appID("task"), "task")
    }

    func testConnectorEditPreservesEmptyArgumentsAndExactEnvironmentValues() throws {
        let arguments: JSON = .array([.string(""), .string("value"), .string("")])
        let environment: JSON = .object(["SPACES": .string(" value "), "MULTILINE": .string("first\nsecond")])
        var draft = NativePluginConnectorDraft(scope: "global", name: "example", entry: .object([
            "command": .string("example"), "args": arguments, "env": environment,
            "future_option": .bool(true)
        ]))
        draft.enabled = false
        let saved = try draft.entry()
        XCTAssertEqual(saved["args"], arguments)
        XCTAssertEqual(saved["env"], environment)
        XCTAssertEqual(saved["enabled"], .bool(false))
        XCTAssertEqual(saved["future_option"], .bool(true))
    }

    func testConnectorEditPreservesSingleEmptyArgumentAndHeaderValues() throws {
        let emptyArgument: JSON = .array([.string("")])
        var command = NativePluginConnectorDraft(scope: "global", name: "command", entry: .object([
            "command": .string("example"), "args": emptyArgument
        ]))
        command.name = "renamed"
        XCTAssertEqual(try command.entry()["args"], emptyArgument)

        let headers: JSON = .object(["X-Custom": .string(" value ")])
        var http = NativePluginConnectorDraft(scope: "global", name: "http", entry: .object([
            "url": .string("https://example.com/mcp"), "headers": headers
        ]))
        http.providers = "claude"
        XCTAssertEqual(try http.entry()["headers"], headers)
    }

    func testConnectorArgumentEditsRetainEmptyPositionsAndCanClearArguments() throws {
        var draft = NativePluginConnectorDraft(scope: "global", name: "example", entry: .object([
            "command": .string("example"), "args": .array([.string("old")])
        ]))
        draft.arguments = "first\n\nlast\n"
        XCTAssertEqual(try draft.entry()["args"], .array([.string("first"), .string(""), .string("last"), .string("")]))
        draft.arguments = ""
        XCTAssertEqual(try draft.entry()["args"], .array([]))
    }
}
