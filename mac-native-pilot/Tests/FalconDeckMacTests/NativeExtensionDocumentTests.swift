import XCTest
@testable import FalconDeckMac

final class NativeExtensionDocumentTests: XCTestCase {
    private func document(_ root: JSON) -> JSON { .object(["version": .number(1), "root": root]) }
    private let divider: JSON = .object(["type": .string("divider")])
    private func select(_ count: Int) -> JSON {
        .object([
            "type": .string("select"), "id": .string("stages"), "label": .string("Stages"),
            "options": .array((0..<count).map { .object(["value": .string("stage-\($0)"), "label": .string("Stage \($0)")]) }),
            "binding": .object(["view": .string("thread-stages"), "path": .array([.string("stageIds")]), "operator": .string("includes_any")])
        ])
    }

    func testSharedNodeAndDepthBoundaries() {
        let atNodeLimit = document(.object(["type": .string("stack"), "children": .array(Array(repeating: divider, count: 255))]))
        let overNodeLimit = document(.object(["type": .string("stack"), "children": .array(Array(repeating: divider, count: 256))]))
        XCTAssertTrue(NativeExtensionDocument.valid(atNodeLimit))
        XCTAssertFalse(NativeExtensionDocument.valid(overNodeLimit))
        var nested = divider
        for _ in 1..<32 { nested = .object(["type": .string("row"), "children": .array([nested])]) }
        XCTAssertTrue(NativeExtensionDocument.valid(document(nested)))
        XCTAssertFalse(NativeExtensionDocument.valid(document(.object(["type": .string("stack"), "children": .array([nested])]))))
    }

    func testSharedOptionBoundaryAndMalformedSelectFallback() {
        XCTAssertTrue(NativeExtensionDocument.valid(document(select(256))))
        XCTAssertFalse(NativeExtensionDocument.valid(document(select(257))))
        for invalid in [
            select(1).setting("options", .array([.object(["value": .number(1), "label": .string("Stage")])])),
            select(1).setting("options", .array([select(1)["options"].array[0], select(1)["options"].array[0]])),
            select(1).setting("multiple", .string("yes")),
            select(1).setting("binding", select(1)["binding"].setting("path", .array([.string("__proto__")]))),
            select(1).setting("binding", .null)
        ] { XCTAssertFalse(NativeExtensionDocument.valid(document(invalid))) }
    }

    func testTextLimitCountsUnicodeScalarsLikeTheSharedContract() {
        func text(_ value: String) -> JSON { document(.object(["type": .string("text"), "text": .string(value)])) }
        XCTAssertTrue(NativeExtensionDocument.valid(text(String(repeating: "😀", count: 4096))))
        XCTAssertFalse(NativeExtensionDocument.valid(text(String(repeating: "😀", count: 4097))))
        XCTAssertFalse(NativeExtensionDocument.valid(text(String(repeating: "e\u{301}", count: 2049))))
        XCTAssertTrue(NativeExtensionDocument.valid(text("")))
    }

    func testMalformedAndNewerNodesFailClosed() {
        XCTAssertFalse(NativeExtensionDocument.valid(document(divider).setting("version", .number(2))))
        XCTAssertFalse(NativeExtensionDocument.valid(document(divider).setting("extra", .bool(true))))
        for root: JSON in [
            .object(["type": .string("stack")]),
            .object(["type": .string("text"), "text": .number(42)]),
            .object(["type": .string("badge"), "text": .string("Badge"), "tone": .string("unknown")]),
            .object(["type": .string("state"), "state": .string("empty"), "title": .string(" ")]),
            .object(["type": .string("divider"), "children": .array([])]),
            .object(["type": .string("form")])
        ] { XCTAssertFalse(NativeExtensionDocument.valid(document(root))) }
    }

    func testMalformedPublishedDocumentDoesNotRestoreManifestUI() {
        let fallback = document(divider)
        for published in [fallback.setting("version", .null), fallback.setting("root", .null), fallback.setting("version", .number(2))] {
            let resolved = NativeExtensionDocument.resolve(published: published, fallback: fallback)
            XCTAssertEqual(resolved, published)
            XCTAssertFalse(NativeExtensionDocument.valid(resolved))
        }
        XCTAssertEqual(NativeExtensionDocument.resolve(published: .object(["count": .number(1)]), fallback: fallback), fallback)
    }

    func testActionInputByteLimitAndTypedBindings() {
        func button(_ action: JSON) -> JSON {
            document(.object(["type": .string("button"), "label": .string("Run"), "action": action]))
        }
        let action: JSON = .object(["actionId": .string("run"), "input": .string(String(repeating: "x", count: 65534))])
        XCTAssertTrue(NativeExtensionDocument.valid(button(action)))
        XCTAssertFalse(NativeExtensionDocument.valid(button(action.setting("input", .string(String(repeating: "x", count: 65535))))))
        XCTAssertTrue(NativeExtensionDocument.valid(button(action.setting("input", .string(String(repeating: "/", count: 40000))))))
        XCTAssertFalse(NativeExtensionDocument.valid(button(action.setting("target", .object(["kind": .string("thread"), "id": .number(42)])))))
        XCTAssertFalse(NativeExtensionDocument.valid(button(action.setting("actionId", .string("invalid action")))))
    }
}
