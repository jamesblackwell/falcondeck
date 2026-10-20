import XCTest
@testable import FalconDeckMac

final class ComposerSuggestionsTests: XCTestCase {
    private let extensionID = "falcondeck.follow-up-suggestions"
    private let threadID = "thread-1"

    private func action(_ id: String = "run-tests", label: String = "Run tests", prompt: String = "Run the tests.", description: String? = nil) -> JSON {
        var fields: [String: JSON] = ["id": .string(id), "label": .string(label), "prompt": .string(prompt)]
        if let description { fields["description"] = .string(description) }
        return .object(fields)
    }

    private func summary(_ id: String? = nil, enabled: Bool = true, status: String = "active", views: [String] = ["follow-ups"]) -> JSON {
        .object([
            "id": .string(id ?? extensionID), "enabled": .bool(enabled), "status": .string(status),
            "contributes": .object(["composerSuggestions": .array(views.map {
                .object(["id": .string($0), "view": .string($0)])
            })])
        ])
    }

    private func view(_ actions: [JSON], extensionID: String? = nil, viewID: String = "follow-ups", scopeKind: String = "thread", scopeID: String? = nil, preferred: String? = nil, updatedAt: String = "2026-08-20T10:00:00.000Z") -> JSON {
        var value: [String: JSON] = ["actions": .array(actions)]
        if let preferred { value["preferredActionId"] = .string(preferred) }
        return .object([
            "extension_id": .string(extensionID ?? self.extensionID), "view_id": .string(viewID),
            "scope": .object(["kind": .string(scopeKind), "id": .string(scopeID ?? threadID)]),
            "value": .object(value), "updated_at": .string(updatedAt)
        ])
    }

    private func snapshot(_ actions: [JSON]? = nil, enabled: Bool = true, status: String = "active", declaredViews: [String] = ["follow-ups"]) -> JSON {
        .object([
            "catalog": .array([summary(enabled: enabled, status: status, views: declaredViews)]),
            "views": .array([view(actions ?? [action(), action("ship", label: "Ship it", prompt: "Open a pull request.")])])
        ])
    }

    private func derive(_ extensions: JSON, threadID: String? = "thread-1", status: String? = "idle", draft: String = "", pendingRequests: Bool = false, pendingSubmission: Bool = false) -> NativeComposerSuggestionOffer? {
        NativeComposerSuggestionProjection.derive(
            extensions: extensions, threadID: threadID, threadStatus: status, draft: draft,
            hasPendingRequests: pendingRequests, hasPendingSubmission: pendingSubmission
        )
    }

    func testIdleThreadReceivesPublishedActions() throws {
        let offer = try XCTUnwrap(derive(snapshot()))
        XCTAssertEqual(offer.extensionID, extensionID)
        XCTAssertEqual(offer.primary.id, "run-tests")
        XCTAssertEqual(offer.actions.map(\.id), ["run-tests", "ship"])
    }

    func testOnlyIdleThreadsWithAnIDReceiveOffers() {
        for status in [nil, "running", "waiting_for_input", "error", "stopped", "unknown"] as [String?] {
            XCTAssertNil(derive(snapshot(), status: status), "Unexpected offer for \(status ?? "nil")")
        }
        XCTAssertNil(derive(snapshot(), threadID: nil))
        XCTAssertNil(derive(snapshot(), threadID: ""))
    }

    func testDraftAndPendingWorkWithholdOffers() {
        XCTAssertNil(derive(snapshot(), draft: "My next instruction"))
        XCTAssertNil(derive(snapshot(), draft: " \n\t "))
        XCTAssertNil(derive(snapshot(), pendingRequests: true))
        XCTAssertNil(derive(snapshot(), pendingSubmission: true))
    }

    func testPublisherMustBeEnabledAndActive() {
        XCTAssertNil(derive(snapshot(enabled: false)))
        for status in ["inactive", "disabled", "error", "starting", ""] {
            XCTAssertNil(derive(snapshot(status: status)), "Unexpected offer from \(status) publisher")
        }
        XCTAssertNil(derive(.object(["catalog": .array([]), "views": .array([view([action()])])])))
    }

    func testScopeMustMatchTheExactThread() {
        let catalog: JSON = .array([summary()])
        for invalidView in [
            view([action()], scopeID: "another-thread"),
            view([action()], scopeKind: "workspace"),
            view([action()], scopeKind: "global")
        ] {
            XCTAssertNil(derive(.object(["catalog": catalog, "views": .array([invalidView])])))
        }
    }

    func testOnlyThePublishersOwnDeclaredViewIsAuthorized() {
        XCTAssertNil(derive(snapshot(declaredViews: [])))
        let extensions: JSON = .object([
            "catalog": .array([summary(views: ["another-view"]), summary("other.publisher")]),
            "views": .array([view([action()])])
        ])
        XCTAssertNil(derive(extensions), "Another extension's declaration cannot authorize this publisher")
        XCTAssertNil(derive(.object([
            "catalog": .array([summary()]), "views": .array([view([action()], viewID: "undeclared")])
        ])))
    }

    func testMalformedAndEmptyActionsAreRemovedBeforeTheFiveActionLimit() throws {
        let malformed: [JSON] = [
            .null, .string("not an action"), .array([]),
            .object(["id": .string("missing-prompt"), "label": .string("Broken")]),
            .object(["id": .number(12), "label": .string("Broken"), "prompt": .string("x")]),
            action(" "), action("blank-label", label: " \n "), action("blank-prompt", prompt: "\t ")
        ]
        let valid = (0..<7).map { action("valid-\($0)") }
        let offer = try XCTUnwrap(derive(snapshot(malformed + valid)))
        XCTAssertEqual(offer.actions.map(\.id), (0..<5).map { "valid-\($0)" })
        XCTAssertNil(derive(snapshot(malformed)))
        XCTAssertNil(derive(snapshot([])))
    }

    func testDuplicateAndOversizedActionIDsCannotConsumeOfferSlots() throws {
        let actions = [
            action(String(repeating: "😀", count: 65)),
            action("same", label: "First"), action(" same ", label: "Duplicate"),
            action(String(repeating: "😀", count: 64), label: "Bounded ID"), action("last")
        ]
        let offer = try XCTUnwrap(derive(snapshot(actions)))
        XCTAssertEqual(offer.actions.count, 3)
        XCTAssertEqual(offer.actions.first?.label, "First")
        XCTAssertEqual(offer.actions[1].id.unicodeScalars.count, 64)
        XCTAssertEqual(offer.actions.last?.id, "last")
    }

    func testOversizedPublisherAndViewMetadataIsRejected() {
        let oversized = String(repeating: "x", count: 257)
        XCTAssertNil(derive(.object([
            "catalog": .array([summary(oversized)]),
            "views": .array([view([action()], extensionID: oversized)])
        ])))
        XCTAssertNil(derive(.object([
            "catalog": .array([summary(views: [oversized])]),
            "views": .array([view([action()], viewID: oversized)])
        ])))
    }

    func testUntrustedSnapshotScansAreBounded() {
        XCTAssertNil(derive(snapshot(Array(repeating: .null, count: 128) + [action()])))
        XCTAssertNil(derive(.object([
            "catalog": .array(Array(repeating: .null, count: 256) + [summary()]),
            "views": .array([view([action()])])
        ])))
        XCTAssertNil(derive(.object([
            "catalog": .array([summary()]),
            "views": .array(Array(repeating: .null, count: 4096) + [view([action()])])
        ])))
    }

    func testPreferredActionIsPromotedWithoutChangingTheOthersOrder() throws {
        let actions = [action("a"), action("b"), action("c")]
        let extensions: JSON = .object([
            "catalog": .array([summary()]), "views": .array([view(actions, preferred: " c ")])
        ])
        let offer = try XCTUnwrap(derive(extensions))
        XCTAssertEqual(offer.primary.id, "c")
        XCTAssertEqual(offer.actions.map(\.id), ["c", "a", "b"])

        let missingPreferred: JSON = .object([
            "catalog": .array([summary()]), "views": .array([view(actions, preferred: "missing")])
        ])
        XCTAssertEqual(derive(missingPreferred)?.primary.id, "a")
    }

    func testTrimmingAndDescriptionWhitespaceNormalization() throws {
        let offer = try XCTUnwrap(derive(snapshot([
            action(" a ", label: "  Ship it \n", prompt: "\n Ship. \t", description: " first\n\n second\tthird "),
            action("b", description: " \n\t ")
        ])))
        XCTAssertEqual(offer.primary.id, "a")
        XCTAssertEqual(offer.primary.label, "Ship it")
        XCTAssertEqual(offer.primary.prompt, "Ship.")
        XCTAssertEqual(offer.primary.description, "first second third")
        XCTAssertNil(offer.actions[1].description)
    }

    func testBoundsUseUnicodeScalarsAndPreserveCompleteEmoji() throws {
        // A combining sequence distinguishes Unicode scalar bounds from Swift Character bounds.
        let combining = "e\u{301}"
        let label = String(repeating: combining, count: 20)
        let description = String(repeating: "😀", count: 121)
        let prompt = String(repeating: "a", count: 511) + "😀ignored"
        let offer = try XCTUnwrap(derive(snapshot([action("unicode", label: label, prompt: prompt, description: description)])))
        XCTAssertEqual(offer.primary.label.unicodeScalars.count, 30)
        XCTAssertEqual(offer.primary.label, String(String.UnicodeScalarView(label.unicodeScalars.prefix(29))) + "…")
        XCTAssertEqual(offer.primary.description?.unicodeScalars.count, 120)
        XCTAssertEqual(offer.primary.description, String(repeating: "😀", count: 119) + "…")
        XCTAssertEqual(offer.primary.prompt.unicodeScalars.count, 512)
        XCTAssertEqual(offer.primary.prompt, String(repeating: "a", count: 511) + "😀")
    }

    func testPublisherSelectionIsAlphabeticalRegardlessOfArrivalOrder() throws {
        let catalog = [summary(), summary("aaa.publisher")]
        let views = [view([action()]), view([action("other")], extensionID: "aaa.publisher")]
        for candidates in [views, views.reversed().map { $0 }] {
            let offer = try XCTUnwrap(derive(.object(["catalog": .array(catalog), "views": .array(candidates)])))
            XCTAssertEqual(offer.extensionID, "aaa.publisher")
            XCTAssertEqual(offer.primary.id, "other")
        }
        let emptyFirst: JSON = .object([
            "catalog": .array(catalog),
            "views": .array([view([], extensionID: "aaa.publisher"), views[0]])
        ])
        XCTAssertEqual(derive(emptyFirst)?.extensionID, extensionID)
    }

    func testOfferKeyIsStableAndChangesWithPublishedContent() throws {
        let original = snapshot([action("same-id", label: "Run tests", prompt: "Run all tests.")])
        let key = try XCTUnwrap(derive(original)?.key)
        XCTAssertFalse(key.isEmpty)
        XCTAssertEqual(derive(original)?.key, key)
        for changed in [
            snapshot([action("same-id", label: "Run selected tests", prompt: "Run all tests.")]),
            snapshot([action("same-id", label: "Run tests", prompt: "Run the focused tests.")]),
            snapshot([action("same-id", label: "Run tests", prompt: "Run all tests.", description: "Focused validation")]),
            snapshot([action("different-id", label: "Run tests", prompt: "Run all tests.")])
        ] {
            XCTAssertNotEqual(derive(changed)?.key, key)
        }
    }
}
