import XCTest

@MainActor final class ConversationLoadingQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func launch() -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launchArguments = ["--demo", "--loading-preview=settling", "--settling-slow"]; app.launch()
        return app
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testCachedTailStaysInPlaceWhenFullHistoryArrives() {
        let app = launch()
        let latest = app.staticTexts["Latest response. This should appear in its final position immediately."]
        XCTAssertTrue(latest.waitForExistence(timeout: 5)); XCTAssertTrue(latest.isHittable)
        let y = latest.frame.minY
        let pill = app.descendants(matching: .any).matching(identifier: "loading-pill").firstMatch
        XCTAssertTrue(pill.exists, "Measure cached content before the authoritative history arrives")
        capture("Cached conversation opens at the latest response")
        XCTAssertTrue(pill.waitForNonExistence(timeout: 12))
        let measured = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            latest.exists && latest.frame.minY.isFinite && latest.frame.height > 0
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [measured], timeout: 3), .completed, "Wait for the current accessibility row to finish materializing")
        XCTAssertTrue(latest.isHittable); XCTAssertEqual(latest.frame.minY, y, accuracy: 2)
        XCTAssertLessThan(latest.frame.maxY, app.textFields["chat-input"].frame.minY)
        capture("Fresh history retains the cached response position")
    }
    func testReadingDuringRefreshKeepsTheVisibleMessageInPlace() {
        let app = launch()
        let latest = app.staticTexts["Latest response. This should appear in its final position immediately."]
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        let transcript = app.descendants(matching: .any).matching(identifier: "conversation-transcript").firstMatch
        transcript.swipeDown()
        let top = app.navigationBars.firstMatch.frame.maxY, bottom = app.textFields["chat-input"].frame.minY
        let candidate = transcript.staticTexts.allElementsBoundByIndex.first {
            $0.isHittable && $0.label.hasPrefix("Review change") && $0.frame.minY > top + 8 && $0.frame.maxY < bottom - 8
        }
        XCTAssertNotNil(candidate); guard let candidate else { return }
        // Index-bound queries can resolve a different row after history inserts.
        let label = candidate.label, anchor = transcript.staticTexts[candidate.label]
        let y = anchor.frame.minY
        let pill = app.descendants(matching: .any).matching(identifier: "loading-pill").firstMatch
        XCTAssertTrue(pill.exists, "Read cached content while the authoritative history is still pending")
        capture("Reading cached history while refresh is pending")
        XCTAssertTrue(pill.waitForNonExistence(timeout: 12))
        XCTAssertTrue(anchor.isHittable); XCTAssertEqual(anchor.label, label); XCTAssertEqual(anchor.frame.minY, y, accuracy: 3)
        XCTAssertTrue(app.buttons["Jump to latest message"].exists)
        capture("Reading anchor retained after refresh")
    }
}
