import XCTest
@testable import FalconDeckNative

private actor ReviewRelay: RelayServing {
    typealias Handler = @Sendable (String, JSON) throws -> JSON
    private var handler: Handler
    private(set) var calls: [(String, JSON)] = []
    init(_ handler: @escaping Handler) { self.handler = handler }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) throws -> JSON { calls.append((method, params)); return try handler(method, params) }
    func count(_ method: String) -> Int { calls.filter { $0.0 == method }.count }
    func last(_ method: String) -> JSON? { calls.last { $0.0 == method }?.1 }
}

private enum Fixture {
    static func review(id: String = "R-12", status: String = "open", items: [JSON]? = nil, extra: [String: JSON] = [:]) -> JSON {
        var fields: [String: JSON] = [
            "id": .string(id), "title": .string("Pricing page"), "ask": .string("Ship the new hero?"), "recommendation": .string("Ship it."),
            "going_ahead_at": .string("2026-11-01T17:00:00Z"), "body": .string("**Context**"), "status": .string(status),
            "items": .array(items ?? [item("i1"), item("i2")]),
            "source_thread_id": .string("thread-1"), "source_workspace_id": .string("ws-1"), "bot": .string("Juno"),
            "created_by": .object(["name": .string("Juno"), "context": .object([:])]),
            "created_at": .string("2026-11-01T09:00:00.123456789Z"), "updated_at": .string("2026-11-01T09:00:00Z"),
            "folder": .null, "responded_at": .null, "overall_decision": .null, "overall_note": .null, "delivery": .null,
        ]
        for (key, value) in extra { fields[key] = value }
        return .object(fields)
    }
    static func item(_ id: String, decision: String? = nil, feedback: String? = nil, evidence: [JSON] = []) -> JSON {
        .object(["id": .string(id), "title": .string("Item \(id)"), "note": .string("Look here"), "evidence": .array(evidence),
                 "decision": decision.map(JSON.string) ?? .null, "feedback": feedback.map(JSON.string) ?? .null])
    }
    static func evidence(_ id: String, kind: String, path: String? = "/state/reviews/R-12/evidence/a.png", url: String? = nil) -> JSON {
        .object(["id": .string(id), "kind": .string(kind), "title": .null, "caption": .string("Check the header"), "open_path": path.map(JSON.string) ?? .null,
                 "original_path": .string("~/a.png"), "snapshotted": .bool(true), "url": url.map(JSON.string) ?? .null,
                 "content_type": .string("image/png"), "size_bytes": .number(2048)])
    }
    @MainActor static func model(_ relay: ReviewRelay, enabled: Bool? = true) -> AppModel {
        let model = AppModel.testing(relay: relay)
        model.connected = true
        if let enabled { model.preferences = .object(["review_inbox_enabled": .bool(enabled)]) }
        return model
    }
    static func session() -> SavedSession {
        SavedSession(relay: URL(string: "https://review.test")!, sessionID: "s", deviceID: "d", token: "t", secret: Data(repeating: 9, count: 32), daemonKey: "k", daemonIdentity: "i")
    }
    static func wait(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<200 { if await condition() { return }; try? await Task.sleep(for: .milliseconds(10)) }
    }
}

@MainActor final class ReviewTests: XCTestCase {
    // MARK: Decoding

    func testEveryStatusDecodes() {
        let expected: [(String, ReviewStatus)] = [("open", .open), ("approved", .approved), ("changes_requested", .changesRequested), ("rejected", .rejected), ("withdrawn", .withdrawn)]
        for (wire, status) in expected {
            XCTAssertEqual(ReviewDecoding.review(Fixture.review(status: wire))?.status, status, wire)
        }
        XCTAssertEqual(ReviewStatus.allCases.count, expected.count)
        XCTAssertNil(ReviewDecoding.review(Fixture.review(status: "archived")), "An unknown status is not guessed")
    }

    func testRecordFieldsAndDatesDecode() throws {
        let review = try XCTUnwrap(ReviewDecoding.review(Fixture.review()))
        XCTAssertEqual(review.id, "R-12"); XCTAssertEqual(review.bot, "Juno"); XCTAssertEqual(review.botName, "Juno")
        XCTAssertEqual(review.sourceThreadID, "thread-1"); XCTAssertEqual(review.sourceWorkspaceID, "ws-1")
        XCTAssertEqual(review.items.map(\.id), ["i1", "i2"]); XCTAssertEqual(review.itemCountLabel, "2 items")
        XCTAssertNotNil(review.goingAheadAt); XCTAssertNil(review.respondedAt)
        // Nanosecond fractions, as chrono writes them, and plain seconds both parse.
        XCTAssertEqual(review.createdAt.timeIntervalSince1970, 1_793_523_600.123, accuracy: 0.01)
        XCTAssertNotNil(ReviewDecoding.date("2026-11-01T09:00:00Z"))
        XCTAssertNotNil(ReviewDecoding.date("2026-11-01T09:00:00.5+00:00"))
    }

    func testDeliveryIsTaggedByState() throws {
        let delivered = try XCTUnwrap(ReviewDecoding.review(Fixture.review(status: "approved", extra: ["delivery": .object(["state": .string("delivered"), "at": .string("2026-11-01T10:00:00Z")])])))
        guard case .delivered = delivered.delivery else { return XCTFail("delivered") }
        XCTAssertFalse(delivered.deliveryFailed)
        let failed = try XCTUnwrap(ReviewDecoding.review(Fixture.review(status: "approved", extra: ["delivery": .object(["state": .string("failed"), "at": .string("2026-11-01T10:00:00Z"), "error": .string("thread gone")])])))
        guard case .failed(_, let error) = failed.delivery else { return XCTFail("failed") }
        XCTAssertEqual(error, "thread gone"); XCTAssertTrue(failed.deliveryFailed)
        let unknown = try XCTUnwrap(ReviewDecoding.review(Fixture.review(status: "approved", extra: ["delivery": .object(["state": .string("queued")])])))
        XCTAssertNil(unknown.delivery, "A delivery state from a newer daemon is shown as no news, not a broken review")
    }

    func testEvidenceKinds() throws {
        let review = try XCTUnwrap(ReviewDecoding.review(Fixture.review(items: [Fixture.item("i1", evidence: [
            Fixture.evidence("e1", kind: "image"), Fixture.evidence("e2", kind: "file", path: "/state/reviews/R-12/evidence/r.md"),
            Fixture.evidence("e3", kind: "url", path: nil, url: "https://example.com/preview"), Fixture.evidence("e4", kind: "hologram"),
        ])])))
        let evidence = review.items[0].evidence
        XCTAssertEqual(evidence.map(\.kind), [.image, .file, .url, .file], "An unknown kind opens as a file")
        XCTAssertEqual(evidence[0].reference(workspaceID: "ws-1", threadID: "thread-1")?.path, "/state/reviews/R-12/evidence/a.png")
        XCTAssertEqual(evidence[0].reference(workspaceID: "ws-1", threadID: nil)?.workspaceID, "ws-1")
        XCTAssertNil(evidence[2].reference(workspaceID: nil, threadID: nil), "A link is not a file")
        XCTAssertEqual(evidence[2].linkURL?.host, "example.com"); XCTAssertNil(evidence[0].linkURL)
        XCTAssertEqual(evidence[1].displayName, "r.md"); XCTAssertEqual(evidence[2].displayName, "example.com")
        XCTAssertTrue(FileLink.isLoopback(URL(string: "http://localhost:3000")!), "Loopback links are the Mac's, not the phone's")
        XCTAssertNil(ReviewEvidence(id: "x", kind: .url, url: "javascript:alert(1)").linkURL, "Only web links open")
    }

    func testAnUnreadableRecordNeverHidesTheOthers() {
        let list = JSON.array([Fixture.review(id: "R-1"), .object(["id": .string("R-2")]), Fixture.review(id: "R-3", status: "mystery"), Fixture.review(id: "R-4")])
        XCTAssertEqual(ReviewDecoding.reviews(list).map(\.id), ["R-1", "R-4"])
    }

    func testOutcomeSummaryCountsDecisions() throws {
        let review = try XCTUnwrap(ReviewDecoding.review(Fixture.review(status: "changes_requested", items: [
            Fixture.item("i1", decision: "approve"), Fixture.item("i2", decision: "request_changes", feedback: "Make it blue"), Fixture.item("i3", decision: "approve")])))
        XCTAssertEqual(review.outcomeSummary, "2 approved, 1 change requested")
        XCTAssertEqual(review.items[1].feedback, "Make it blue"); XCTAssertEqual(review.items[1].decision, .requestChanges)
    }

    // MARK: Drafts and requests

    private func twoItems() throws -> Review { try XCTUnwrap(ReviewDecoding.review(Fixture.review())) }

    func testSubmitIsBlockedUntilEveryItemOrTheWholeReviewIsDecided() throws {
        let review = try twoItems()
        var draft = ReviewDraft()
        XCTAssertFalse(draft.isComplete(for: review)); XCTAssertNil(draft.request(for: review))
        XCTAssertEqual(draft.awaiting(in: review).map(\.id), ["i1", "i2"])
        XCTAssertEqual(draft.statusLine(for: review), "Needs a decision on Item i1, Item i2")
        draft.choose(.approve, for: "i1")
        XCTAssertEqual(draft.awaiting(in: review).map(\.id), ["i2"]); XCTAssertEqual(draft.decidedCount(in: review), 1)
        XCTAssertFalse(draft.isComplete(for: review))
        draft.choose(.reject, for: "i2")
        XCTAssertTrue(draft.isComplete(for: review)); XCTAssertEqual(draft.statusLine(for: review), "Ready to send")
        // The overall answer alone is enough.
        var overall = ReviewDraft(); overall.chooseOverall(.approve)
        XCTAssertTrue(overall.isComplete(for: review)); XCTAssertEqual(overall.effectiveDecision(for: "i1"), .approve)
        XCTAssertEqual(overall.statusLine(for: review), "Ready · approved for the rest")
        // A closed review never accepts one.
        var closed = review; closed.status = .withdrawn
        XCTAssertFalse(overall.isComplete(for: closed))
    }

    func testTappingTheChosenDecisionAgainTakesItBack() {
        var draft = ReviewDraft()
        draft.choose(.approve, for: "i1"); XCTAssertEqual(draft.decision(for: "i1"), .approve)
        draft.choose(.reject, for: "i1"); XCTAssertEqual(draft.decision(for: "i1"), .reject)
        draft.choose(.reject, for: "i1"); XCTAssertNil(draft.decision(for: "i1"))
        draft.chooseOverall(.approve); draft.chooseOverall(.approve); XCTAssertNil(draft.overallDecision)
        XCTAssertTrue(draft.isEmpty, "Only typed words or a choice make a draft worth keeping")
        draft.setFeedback("  ", for: "i1"); XCTAssertTrue(draft.isEmpty)
        draft.setFeedback("Warmer", for: "i1"); XCTAssertFalse(draft.isEmpty)
    }

    func testRespondRequestCarriesPerItemDecisionsAndTrimmedFeedback() throws {
        let review = try twoItems()
        var draft = ReviewDraft()
        draft.choose(.approve, for: "i1"); draft.choose(.requestChanges, for: "i2")
        draft.setFeedback("  Make the annual toggle default.\n", for: "i2"); draft.setFeedback("   ", for: "i1")
        let request = try XCTUnwrap(draft.request(for: review))
        XCTAssertEqual(request, ReviewResponseRequest(reviewID: "R-12", items: [
            .init(itemID: "i1", decision: .approve, feedback: nil), .init(itemID: "i2", decision: .requestChanges, feedback: "Make the annual toggle default.")], decision: nil, note: nil))
        XCTAssertEqual(request.json, .object([
            "review_id": .string("R-12"),
            "items": .array([
                .object(["item_id": .string("i1"), "decision": .string("approve")]),
                .object(["item_id": .string("i2"), "decision": .string("request_changes"), "feedback": .string("Make the annual toggle default.")]),
            ]),
        ]))
    }

    func testRespondRequestForTheWholeReview() throws {
        let review = try twoItems()
        var draft = ReviewDraft()
        draft.chooseOverall(.approve); draft.overallNote = " Otherwise good. "
        XCTAssertEqual(draft.request(for: review)?.json, .object(["review_id": .string("R-12"), "decision": .string("approve"), "note": .string("Otherwise good.")]))
        // Words on an item with no verdict of its own travel with the overall one, which is
        // the only way the daemon keeps them; the item that has its own verdict keeps that.
        draft.choose(.reject, for: "i1"); draft.setFeedback("Wrong logo", for: "i1"); draft.setFeedback("Love it", for: "i2")
        let request = try XCTUnwrap(draft.request(for: review))
        XCTAssertEqual(request.items, [.init(itemID: "i1", decision: .reject, feedback: "Wrong logo"), .init(itemID: "i2", decision: .approve, feedback: "Love it")])
        XCTAssertEqual(request.decision, .approve)
    }

    func testPruningDropsItemsTheReviewNoLongerHas() throws {
        var draft = ReviewDraft()
        draft.choose(.approve, for: "i1"); draft.choose(.approve, for: "gone"); draft.setFeedback("x", for: "gone")
        XCTAssertEqual(Set(draft.pruned(to: try twoItems()).items.keys), ["i1"])
    }

    func testDictationAppendsAfterWhatIsTyped() {
        XCTAssertEqual(ReviewDictation.append("make it blue", to: ""), "make it blue")
        XCTAssertEqual(ReviewDictation.append(" and bigger ", to: "Warmer"), "Warmer and bigger")
        XCTAssertEqual(ReviewDictation.append("Second", to: "First line\n"), "First line\nSecond")
        XCTAssertEqual(ReviewDictation.append("  ", to: "Keep"), "Keep")
    }

    // MARK: Visibility

    func testTheEntryIsHiddenUnlessTheDaemonSaysTheInboxIsOn() {
        XCTAssertTrue(ReviewStore.isEnabled(preferences: .object(["review_inbox_enabled": .bool(true)]), demo: false))
        XCTAssertFalse(ReviewStore.isEnabled(preferences: .object(["review_inbox_enabled": .bool(false)]), demo: false))
        XCTAssertFalse(ReviewStore.isEnabled(preferences: .object([:]), demo: false), "An older daemon omits the flag")
        XCTAssertTrue(ReviewStore.isEnabled(preferences: .object([:]), demo: true), "The demo has no daemon to ask")
        XCTAssertFalse(ReviewStore.isEnabled(preferences: .object(["review_inbox_enabled": .bool(false)]), demo: true))
        for (flag, visible) in [(true as Bool?, true), (false, false), (nil, false)] {
            let model = Fixture.model(ReviewRelay { _, _ in .null }, enabled: flag)
            XCTAssertEqual(model.reviews.entryVisible(model: model), visible, "\(String(describing: flag))")
        }
    }

    func testADisabledInboxFetchesNothing() async {
        let relay = ReviewRelay { _, _ in .object(["data": .array([])]) }
        let model = Fixture.model(relay, enabled: false)
        await model.reviews.refresh(model: model)
        let calls = await relay.count("reviews.list")
        XCTAssertEqual(calls, 0)
    }

    // MARK: Fetching and the badge

    private func listing(open: [JSON], closed: [JSON] = []) -> ReviewRelay.Handler {
        { method, params in
            guard method == "reviews.list" else { throw PilotError("unexpected \(method)") }
            let includeClosed = params["filters"]["include_closed"].bool
            return .object(["data": .array(includeClosed ? open + closed : open)])
        }
    }

    func testBadgeCountsOpenReviewsOnly() async throws {
        let relay = ReviewRelay(listing(open: [Fixture.review(id: "R-1"), Fixture.review(id: "R-2")], closed: [Fixture.review(id: "R-0", status: "approved")]))
        let model = Fixture.model(relay)
        XCTAssertEqual(model.reviews.openCount, 0)
        await model.reviews.refresh(model: model)
        XCTAssertEqual(model.reviews.openCount, 2)
        XCTAssertEqual(model.reviews.openReviews.map(\.id).sorted(), ["R-1", "R-2"])
        XCTAssertEqual(model.reviews.answeredReviews.map(\.id), ["R-0"])
        let first = await relay.last("reviews.list")
        XCTAssertNotNil(first?["limit"])
    }

    func testAnOlderDaemonQuietlyHidesTheEntry() async {
        let relay = ReviewRelay { method, _ in throw PilotError("unknown method: \(method)") }
        let model = Fixture.model(relay)
        XCTAssertTrue(model.reviews.entryVisible(model: model))
        await model.reviews.refresh(model: model)
        XCTAssertTrue(model.reviews.unsupported); XCTAssertFalse(model.reviews.entryVisible(model: model))
        XCTAssertNil(model.reviews.refreshError, "No error is shown for a feature that is simply absent")
    }

    func testATransientFailureKeepsTheEntryAndWhatWasLoaded() async throws {
        let failing = LockedFlag()
        let relay = ReviewRelay { method, params in
            if failing.value { throw PilotError("The relay timed out.") }
            return .object(["data": .array([Fixture.review(id: "R-1")])])
        }
        let model = Fixture.model(relay)
        await model.reviews.refresh(model: model)
        failing.value = true
        await model.reviews.refresh(model: model)
        XCTAssertEqual(model.reviews.openCount, 1, "A failed refresh does not empty the inbox")
        XCTAssertTrue(model.reviews.entryVisible(model: model))
    }

    func testOnlyReviewEventsTriggerARefresh() async {
        let relay = ReviewRelay(listing(open: [Fixture.review()]))
        let model = Fixture.model(relay)
        model.reviews.controlStateChanged(.object(["type": .string("control-state-changed"), "change": .object(["store_revision": .number(3), "domains": .array([.string("automations"), .string("audit")])])]), model: model)
        try? await Task.sleep(for: .milliseconds(450))
        var calls = await relay.count("reviews.list")
        XCTAssertEqual(calls, 0, "Automation changes are not review changes")
        model.reviews.controlStateChanged(.object(["type": .string("control-state-changed"), "change": .object(["store_revision": .number(4), "domains": .array([.string("tickets"), .string("reviews")])])]), model: model)
        await Fixture.wait { model.reviews.openCount == 1 }
        calls = await relay.count("reviews.list")
        XCTAssertGreaterThanOrEqual(calls, 1); XCTAssertEqual(model.reviews.openCount, 1)
    }

    // MARK: Responding

    private func ready(_ relay: ReviewRelay) async -> AppModel {
        let model = Fixture.model(relay)
        await model.reviews.refresh(model: model)
        return model
    }

    func testRespondClosesTheReviewAndClearsTheDraft() async throws {
        let relay = ReviewRelay { method, params in
            switch method {
            case "reviews.list": return .object(["data": .array([Fixture.review()])])
            case "review.respond":
                return .object(["ok": .bool(true), "data": Fixture.review(status: "changes_requested", items: [Fixture.item("i1", decision: "approve"), Fixture.item("i2", decision: "request_changes", feedback: "Bluer")],
                    extra: ["responded_at": .string("2026-11-01T10:00:00Z"), "delivery": .object(["state": .string("delivered"), "at": .string("2026-11-01T10:00:01Z")])])])
            default: throw PilotError("unexpected \(method)")
            }
        }
        let model = await ready(relay), store = model.reviews
        store.edit("R-12", model: model) { $0.choose(.approve, for: "i1"); $0.choose(.requestChanges, for: "i2"); $0.setFeedback("Bluer", for: "i2") }
        let closed = try await store.respond("R-12", model: model)
        XCTAssertEqual(closed.status, .changesRequested); XCTAssertEqual(store.review("R-12")?.status, .changesRequested)
        XCTAssertEqual(store.openCount, 0); XCTAssertTrue(store.draft(for: "R-12").isEmpty, "A sent review keeps no draft")
        XCTAssertEqual(closed.items[1].feedback, "Bluer")
        let sent = await relay.last("review.respond")
        XCTAssertEqual(sent, .object(["review_id": .string("R-12"), "items": .array([
            .object(["item_id": .string("i1"), "decision": .string("approve")]),
            .object(["item_id": .string("i2"), "decision": .string("request_changes"), "feedback": .string("Bluer")])])]))
    }

    func testAnIncompleteDraftNeverReachesTheComputer() async throws {
        let relay = ReviewRelay(listing(open: [Fixture.review()]))
        let model = await ready(relay)
        model.reviews.edit("R-12", model: model) { $0.choose(.approve, for: "i1") }
        do { _ = try await model.reviews.respond("R-12", model: model); XCTFail("Sent an incomplete answer") } catch { }
        let calls = await relay.count("review.respond")
        XCTAssertEqual(calls, 0)
    }

    func testAWithdrawnReviewShowsItsClosedStateAndKeepsTheTypedFeedback() async throws {
        let relay = ReviewRelay { method, _ in
            switch method {
            case "reviews.list": return .object(["data": .array([Fixture.review()])])
            case "review.respond": return .object(["ok": .bool(false), "error": .object(["code": .string("review_closed"), "message": .string("R-12 is already withdrawn.")])])
            case "review.get": return .object(["data": Fixture.review(status: "withdrawn")])
            default: throw PilotError("unexpected \(method)")
            }
        }
        let model = await ready(relay), store = model.reviews
        store.edit("R-12", model: model) { $0.chooseOverall(.approve); $0.setFeedback("Keep the Pro badge", for: "i1") }
        do { _ = try await store.respond("R-12", model: model); XCTFail("Expected review_closed") }
        catch let failure as ReviewFailure { XCTAssertEqual(failure, .closed("R-12 is already withdrawn.")) }
        XCTAssertEqual(store.review("R-12")?.status, .withdrawn)
        XCTAssertEqual(store.draft(for: "R-12").feedback(for: "i1"), "Keep the Pro badge", "Typed feedback survives a withdrawal")
        XCTAssertEqual(store.closedWhileAnswering["R-12"], "R-12 is already withdrawn.")
    }

    func testAFailedSendKeepsEverythingTypedAndAllowsRetry() async throws {
        let failing = LockedFlag(); failing.value = true
        let relay = ReviewRelay { method, _ in
            if method == "reviews.list" { return .object(["data": .array([Fixture.review()])]) }
            if failing.value { throw PilotError("The relay timed out.") }
            return .object(["ok": .bool(true), "data": Fixture.review(status: "approved", items: [Fixture.item("i1", decision: "approve"), Fixture.item("i2", decision: "approve")])])
        }
        let model = await ready(relay), store = model.reviews
        store.edit("R-12", model: model) { $0.chooseOverall(.approve); $0.overallNote = "Looks right" }
        do { _ = try await store.respond("R-12", model: model); XCTFail("Expected failure") } catch { XCTAssertEqual(error.localizedDescription, "The relay timed out.") }
        XCTAssertEqual(store.draft(for: "R-12").overallNote, "Looks right"); XCTAssertEqual(store.review("R-12")?.status, .open)
        XCTAssertTrue(store.submitting.isEmpty)
        failing.value = false
        let closed = try await store.respond("R-12", model: model)
        XCTAssertEqual(closed.status, .approved)
    }

    func testARejectedResponseSurfacesTheDaemonsReason() async throws {
        let relay = ReviewRelay { method, _ in
            if method == "reviews.list" { return .object(["data": .array([Fixture.review()])]) }
            return .object(["ok": .bool(false), "error": .object(["code": .string("review_forbidden"), "message": .string("Only James can respond."), "suggested_action": .string("Wait for James.")])])
        }
        let model = await ready(relay)
        model.reviews.edit("R-12", model: model) { $0.chooseOverall(.reject) }
        do { _ = try await model.reviews.respond("R-12", model: model); XCTFail("Expected failure") } catch { XCTAssertEqual(error.localizedDescription, "Wait for James.") }
        XCTAssertFalse(model.reviews.draft(for: "R-12").isEmpty)
    }

    func testDraftsSurviveLeavingTheScreen() async throws {
        let model = await ready(ReviewRelay(listing(open: [Fixture.review()])))
        model.reviews.edit("R-12", model: model) { $0.choose(.reject, for: "i1"); $0.setFeedback("Too loud", for: "i1") }
        // Navigation only changes which view reads the store; the store holds the draft.
        await model.reviews.refresh(model: model)
        XCTAssertEqual(model.reviews.draft(for: "R-12").decision(for: "i1"), .reject)
        XCTAssertEqual(model.reviews.draft(for: "R-12").feedback(for: "i1"), "Too loud")
    }

    func testAListFetchedBeforeAnAnswerCannotReopenTheReview() async throws {
        let relay = GatedReviewRelay()
        // Seed the review through a normal refresh against a relay that answers at once.
        let seeded = AppModel.testing(relay: relay)
        seeded.connected = true; seeded.preferences = .object(["review_inbox_enabled": .bool(true)])
        await relay.open()
        await seeded.reviews.refresh(model: seeded)
        await relay.close()
        let stale = Task { await seeded.reviews.refresh(model: seeded) }
        await relay.waitUntilHeld()
        seeded.reviews.edit("R-12", model: seeded) { $0.chooseOverall(.approve) }
        _ = try await seeded.reviews.respond("R-12", model: seeded)
        await relay.open()
        await stale.value
        XCTAssertEqual(seeded.reviews.review("R-12")?.status, .approved, "A list captured before the answer must not undo it")
    }

    // MARK: Persistence

    func testNotesSurviveARelaunchAndAreRemovedWhenSent() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ReviewDraftTests-\(UUID())", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let vault = try XCTUnwrap(ReviewDraftVault(session: Fixture.session(), root: root))
        var draft = ReviewDraft(); draft.choose(.requestChanges, for: "i2"); draft.setFeedback("Make the annual toggle default.", for: "i2"); draft.overallNote = "Otherwise good."
        try await vault.save(draft, reviewID: "R-12")
        let relaunched = try XCTUnwrap(ReviewDraftVault(session: Fixture.session(), root: root))
        let loaded = await relaunched.load()
        XCTAssertEqual(loaded["R-12"], draft)
        let raw = try Data(contentsOf: XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL }.first { $0.pathExtension == "draft" }))
        XCTAssertNil(String(data: raw, encoding: .utf8)?.range(of: "annual toggle"), "Notes are encrypted on disk")
        try await vault.save(ReviewDraft(), reviewID: "R-12")
        let cleared = await relaunched.load()
        XCTAssertTrue(cleared.isEmpty)
        ReviewDraftVault.purge(root: root)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }

    func testTheStoreRestoresSavedNotesWhenItLoads() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ReviewRestoreTests-\(UUID())", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        var draft = ReviewDraft(); draft.setFeedback("Warmer", for: "i1")
        try await XCTUnwrap(ReviewDraftVault(session: Fixture.session(), root: root)).save(draft, reviewID: "R-12")
        let model = AppModel.testing(relay: ReviewRelay(listing(open: [Fixture.review()])), sessionLoader: { Fixture.session() })
        model.connected = true; model.preferences = .object(["review_inbox_enabled": .bool(true)])
        let store = ReviewStore(draftRoot: root)
        await store.refresh(model: model)
        XCTAssertEqual(store.draft(for: "R-12").feedback(for: "i1"), "Warmer")
        // Forgetting the computer removes them.
        store.reset(clearData: true, forgotten: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertTrue(store.draft(for: "R-12").isEmpty)
    }

    func testAReconnectKeepsTheInboxButANewPairingClearsIt() async {
        let model = await ready(ReviewRelay(listing(open: [Fixture.review()])))
        model.reviews.edit("R-12", model: model) { $0.chooseOverall(.approve) }
        model.reviews.reset(clearData: false, forgotten: false)
        XCTAssertEqual(model.reviews.openCount, 1); XCTAssertFalse(model.reviews.draft(for: "R-12").isEmpty)
        model.reviews.reset(clearData: true, forgotten: false)
        XCTAssertEqual(model.reviews.openCount, 0); XCTAssertTrue(model.reviews.draft(for: "R-12").isEmpty)
    }

    // MARK: Demo

    func testDemoFixtureHasEverythingTheScreensNeed() throws {
        let now = Date(timeIntervalSince1970: 1_793_523_600)
        let reviews = ReviewDemo.reviews(now: now)
        let open = reviews.filter(\.isOpen)
        XCTAssertEqual(open.map(\.id), ["R-12", "R-11"])
        let pricing = try XCTUnwrap(open.first)
        XCTAssertEqual(pricing.items.count, 3); XCTAssertEqual(pricing.botName, "Juno"); XCTAssertFalse(pricing.body.isEmpty); XCTAssertNotNil(pricing.goingAheadAt)
        XCTAssertTrue(pricing.items.flatMap(\.evidence).contains { $0.kind == .url })
        let images = pricing.items.flatMap(\.evidence).filter { $0.kind == .image }
        XCTAssertGreaterThanOrEqual(images.count, 3)
        for evidence in images + pricing.items.flatMap(\.evidence).filter({ $0.kind == .file }) {
            let path = try XCTUnwrap(evidence.openPath)
            XCTAssertTrue(FileManager.default.fileExists(atPath: path), "\(path) was not generated")
        }
        let image = try XCTUnwrap(UIImage(contentsOfFile: XCTUnwrap(images.first?.openPath)))
        XCTAssertGreaterThan(image.size.width, 300)
        XCTAssertTrue(reviews.contains { $0.deliveryFailed }, "The demo shows a reply that could not be delivered")
        XCTAssertTrue(reviews.contains { $0.status == .approved })
    }

    func testDemoResponseDerivesTheStatusLikeTheDaemon() throws {
        let review = try twoItems()
        var draft = ReviewDraft(); draft.choose(.approve, for: "i1"); draft.choose(.reject, for: "i2")
        XCTAssertEqual(ReviewDemo.respond(review, try XCTUnwrap(draft.request(for: review)), now: .now).status, .rejected)
        draft.choose(.requestChanges, for: "i1")
        XCTAssertEqual(ReviewDemo.respond(review, try XCTUnwrap(draft.request(for: review)), now: .now).status, .changesRequested)
        var all = ReviewDraft(); all.chooseOverall(.approve)
        let closed = ReviewDemo.respond(review, try XCTUnwrap(all.request(for: review)), now: .now)
        XCTAssertEqual(closed.status, .approved); XCTAssertEqual(closed.items.map(\.decision), [.approve, .approve]); XCTAssertEqual(closed.overallDecision, .approve)
    }

    func testDemoRefreshAndRespondRunWithoutAComputer() async throws {
        let model = AppModel.testing(relay: ReviewRelay { _, _ in throw PilotError("no computer") })
        model.demo = true
        XCTAssertTrue(model.reviews.entryVisible(model: model))
        await model.reviews.refresh(model: model)
        XCTAssertEqual(model.reviews.openCount, 2)
        model.reviews.edit("R-11", model: model) { $0.chooseOverall(.approve) }
        let closed = try await model.reviews.respond("R-11", model: model)
        XCTAssertEqual(closed.status, .approved); XCTAssertEqual(model.reviews.openCount, 1)
    }

    func testAnUnknownBotGetsAStableMark() {
        XCTAssertEqual(ReviewBotMarks.fallback(for: "Juno"), ReviewBotMarks.fallback(for: "juno"))
        XCTAssertTrue(NativeBotIcon.shapes.contains(ReviewBotMarks.fallback(for: "Atlas").shape))
        XCTAssertNotEqual(ReviewBotMarks.fallback(for: "Atlas"), ReviewBotMarks.fallback(for: "Moneta"))
    }

    func testFormatting() {
        let now = Date(timeIntervalSince1970: 1_793_523_600)
        XCTAssertEqual(ReviewFormat.age(now.addingTimeInterval(-20), now: now), "now")
        XCTAssertEqual(ReviewFormat.age(now.addingTimeInterval(-25 * 60), now: now), "25m")
        XCTAssertEqual(ReviewFormat.age(now.addingTimeInterval(-3 * 3600), now: now), "3h")
        XCTAssertEqual(ReviewFormat.age(now.addingTimeInterval(-2 * 86_400), now: now), "2d")
        XCTAssertEqual(ReviewFormat.goingAhead(now.addingTimeInterval(-5), now: now), "Going ahead now")
        XCTAssertTrue(ReviewFormat.goingAhead(now.addingTimeInterval(60), now: now, calendar: .current).hasPrefix("Going ahead"))
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool { get { lock.withLock { flag } } set { lock.withLock { flag = newValue } } }
}

private actor GatedReviewRelay: RelayServing {
    private var held: [CheckedContinuation<Void, Never>] = []
    private var isOpen = true
    func open() { isOpen = true; let waiting = held; held = []; for waiter in waiting { waiter.resume() } }
    func close() { isOpen = false }
    func waitUntilHeld() async { while held.isEmpty { try? await Task.sleep(for: .milliseconds(5)) } }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async throws -> JSON {
        switch method {
        case "reviews.list":
            if !isOpen { await withCheckedContinuation { held.append($0) } }
            return .object(["data": .array([Fixture.review()])])
        case "review.respond":
            return .object(["ok": .bool(true), "data": Fixture.review(status: "approved", items: [Fixture.item("i1", decision: "approve"), Fixture.item("i2", decision: "approve")])])
        default: throw PilotError("unexpected \(method)")
        }
    }
}
