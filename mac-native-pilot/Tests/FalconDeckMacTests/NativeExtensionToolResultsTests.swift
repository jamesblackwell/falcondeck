import XCTest
@testable import FalconDeckMac

final class NativeExtensionToolResultsTests: XCTestCase {
    private let registration: JSON = .object([
        "extensionId": .string("test.artifacts"),
        "agentToolResults": .array([.object(["toolId": .string("draft-item"), "detail": .object(["title": .string("Draft details")])])])
    ])
    private let extensionItem: JSON = .object([
        "id": .string("test.artifacts"), "enabled": .bool(true), "bundled": .bool(true), "status": .string("active"),
        "granted_permissions": .array([.string("agent-tools:register")]),
        "contributes": .object(["agentTools": .array([.object(["id": .string("draft-item")])])])
    ])
    private func item(_ id: String, title: String = "Draft", server: String = "falcondeck-extensions") -> Message {
        Message(.object(["id": .string(id), "kind": .string("tool_call"), "detail": .object([
            "kind": .string("mcp"), "server": .string(server), "arguments": .object(["objective": .string("Ship")]),
            "result": .object(["structuredContent": .object(["title": .string(title)]), "_meta": .object([
                "falcondeck/extensionTool": .object(["extensionId": .string("test.artifacts"), "toolId": .string("draft-item")])
            ])])
        ])]))
    }

    func testNewestResultRendersOutsideOrdinaryToolGrouping() {
        let matches = NativeExtensionToolResultMatcher.matches(messages: [item("older"), item("newer", title: "Latest")], catalog: [extensionItem], registrations: [registration])
        XCTAssertEqual(matches.count, 1)
        XCTAssertEqual(matches.first?.itemID, "newer")
        XCTAssertEqual(matches.first?.result["title"].string, "Latest")
        XCTAssertEqual(matches.first?.arguments["objective"].string, "Ship")
        XCTAssertEqual(matches.first?.detailTitle, "Draft details")
    }

    func testRevocationDisablementAndUndeclaredToolFailClosed() {
        for catalog in [extensionItem.setting("enabled", .bool(false)),
                        extensionItem.setting("status", .string("error")),
                        extensionItem.setting("bundled", .bool(false)),
                        extensionItem.setting("granted_permissions", .array([])),
                        extensionItem.setting("contributes", .object(["agentTools": .array([])]))] {
            XCTAssertTrue(NativeExtensionToolResultMatcher.matches(messages: [item("tool")], catalog: [catalog], registrations: [registration]).isEmpty)
        }
        XCTAssertTrue(NativeExtensionToolResultMatcher.matches(messages: [item("tool")], catalog: [extensionItem], registrations: []).isEmpty)
    }

    func testModelAuthoredIdentityAndForeignServerCannotSelectFrontend() {
        XCTAssertTrue(NativeExtensionToolResultMatcher.matches(messages: [item("tool", server: "other-server")], catalog: [extensionItem], registrations: [registration]).isEmpty)
        let original = item("tool").raw
        let result = original["detail"]["result"]
        let forged = original.setting("detail", original["detail"].setting("result", result.setting("_meta", .null).setting("structuredContent", .object([
            "falcondeck/extensionTool": .object(["extensionId": .string("test.artifacts"), "toolId": .string("draft-item")])
        ]))))
        XCTAssertTrue(NativeExtensionToolResultMatcher.matches(messages: [Message(forged)], catalog: [extensionItem], registrations: [registration]).isEmpty)
    }
}
