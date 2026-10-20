import XCTest
@testable import FalconDeckMac

final class NativeSidebarExtensionTests: XCTestCase {
    func testFilterSupportsTheSharedOptionLimit() {
        for count in [101, 256] {
            let options = (0..<count).map { option("value-\($0)") }
            let extensions = NativeSidebarExtensions(snapshot(published: document(options: options)))
            XCTAssertTrue(extensions.filters.first?.supported == true, "\(count) options should be supported")
            XCTAssertTrue(extensions.matches(taskID: "task", selections: ["example.filter:choices": ["value-0"]]))
        }
        let options = (0..<257).map { option("value-\($0)") }
        XCTAssertFalse(NativeSidebarExtensions(snapshot(published: document(options: options))).filters[0].supported)
    }

    func testMalformedPublishedOptionsRemainUnsupportedWithoutHidingTasks() {
        let invalidOptions: [[JSON]] = [
            [.object(["value": .number(1), "label": .string("Numeric")])],
            [option("duplicate"), option("duplicate")],
            [option("")],
            [option(String(repeating: "v", count: 257))],
            [option("value-0").setting("label", .string("  \n"))],
            [option("value-0").setting("label", .number(1))],
            [option("value-0").setting("label", .string(String(repeating: "x", count: 4097)))],
            [option("value-0").setting("tone", .string("unknown"))],
            [option("value-0").setting("extra", .bool(true))]
        ]
        for options in invalidOptions {
            let extensions = NativeSidebarExtensions(snapshot(published: document(options: options)))
            XCTAssertFalse(extensions.filters[0].supported, "Malformed options: \(options)")
            XCTAssertTrue(extensions.matches(taskID: "task", selections: ["example.filter:choices": ["missing"]]))
        }
    }

    func testMalformedPublishedSelectDoesNotRestoreManifestFilter() {
        let valid = document()
        let invalid: [JSON] = [
            valid.setting("root", .null),
            valid.setting("version", .null),
            valid.setting("root", valid["root"].setting("id", .string("Bad ID"))),
            valid.setting("root", valid["root"].setting("label", .string(" "))),
            valid.setting("root", valid["root"].setting("multiple", .string("true"))),
            valid.setting("root", valid["root"].setting("options", .object([:]))),
            valid.setting("root", valid["root"].setting("binding", valid["root"]["binding"].setting("path", .array([.number(1)])))),
            valid.setting("root", valid["root"].setting("binding", valid["root"]["binding"].setting("path", .array([.string(String(repeating: "x", count: 129))]))))
        ]
        for published in invalid {
            let extensions = NativeSidebarExtensions(snapshot(published: published))
            XCTAssertEqual(extensions.filters[0].document, published)
            XCTAssertFalse(extensions.filters[0].supported, "Malformed publication: \(published)")
        }
    }

    func testOrdinaryProjectionDataKeepsManifestUI() {
        let extensions = NativeSidebarExtensions(snapshot(published: .object(["version": .number(1), "values": .array([])])))
        XCTAssertEqual(extensions.filters[0].document, document())
        XCTAssertTrue(extensions.filters[0].supported)
    }

    func testOnlyStringProjectionValuesCanMatchASelection() {
        let extensions = NativeSidebarExtensions(snapshot(published: document(), values: [.number(1), .null]))
        XCTAssertFalse(extensions.matches(taskID: "task", selections: ["example.filter:choices": [""]]))
    }

    private func option(_ value: String) -> JSON {
        .object(["value": .string(value), "label": .string(value)])
    }

    private func document(options: [JSON]? = nil) -> JSON {
        .object(["version": .number(1), "root": .object([
            "type": .string("select"), "id": .string("choices"), "label": .string("Choices"), "multiple": .bool(true),
            "options": .array(options ?? [option("value-0")]),
            "binding": .object(["view": .string("thread-values"), "operator": .string("includes_any"), "path": .array([.string("values")])])
        ])])
    }

    private func snapshot(published: JSON, values: [JSON] = [.string("value-0")]) -> JSON {
        .object(["catalog": .array([.object([
            "id": .string("example.filter"), "enabled": .bool(true),
            "contributes": .object(["sidebarFilters": .array([.object([
                "id": .string("choices"), "view": .string("choices-ui"), "ui": document()
            ])])])
        ])]), "views": .array([
            .object(["extension_id": .string("example.filter"), "view_id": .string("choices-ui"), "scope": .null, "value": published]),
            .object(["extension_id": .string("example.filter"), "view_id": .string("thread-values"), "scope": .object(["kind": .string("thread"), "id": .string("task")]), "value": .object(["values": .array(values)])])
        ])])
    }
}
