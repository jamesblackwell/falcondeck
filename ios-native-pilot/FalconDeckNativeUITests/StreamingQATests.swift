import XCTest

@MainActor final class StreamingQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func launch() -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launchArguments = ["--demo", "--streaming-preview"]; app.launch()
        XCTAssertTrue(app.textFields["chat-input"].waitForExistence(timeout: 5))
        return app
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testStreamingUsesOnePlainThinkingLabelAndFinishesAboveTheComposer() {
        let app = launch()
        XCTAssertTrue(app.staticTexts["Thinking…"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Claude is'")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Codex is'")).firstMatch.exists)
        capture("Plain thinking label during a local stream")
        XCTAssertTrue(app.buttons["stop-task"].waitForNonExistence(timeout: 20))
        let final = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'The response is complete. All streamed text has arrived.'")).firstMatch
        XCTAssertTrue(final.waitForExistence(timeout: 5))
        XCTAssertTrue(final.isHittable)
        XCTAssertLessThanOrEqual(final.frame.maxY, app.textFields["chat-input"].frame.minY - 8)
        XCTAssertFalse(app.staticTexts["Thinking…"].exists)
        XCTAssertFalse(app.buttons["Jump to latest message"].exists)
        capture("Completed streamed Markdown stays above the composer")
    }
    func testReadingEarlierMessagesDuringAStreamKeepsItsPosition() {
        let app = launch()
        let heading = app.staticTexts["A steadier conversation"]
        XCTAssertTrue(heading.waitForExistence(timeout: 10))
        let transcript = app.descendants(matching: .any).matching(identifier: "conversation-transcript").firstMatch
        transcript.swipeDown()
        let jump = app.buttons["Jump to latest message"]
        XCTAssertTrue(jump.waitForExistence(timeout: 3))
        let anchor = transcript.staticTexts.allElementsBoundByIndex.first { $0.isHittable && $0.label.count > 60 }
        XCTAssertNotNil(anchor)
        guard let anchor else { return }
        let y = anchor.frame.minY
        capture("Reading position while the response continues below")
        XCTAssertTrue(app.buttons["stop-task"].waitForNonExistence(timeout: 20))
        XCTAssertTrue(anchor.exists)
        XCTAssertEqual(anchor.frame.minY, y, accuracy: 4)
        jump.tap()
        let final = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'The response is complete. All streamed text has arrived.'")).firstMatch
        XCTAssertTrue(final.waitForExistence(timeout: 5))
        XCTAssertTrue(final.isHittable)
        capture("Jump to latest after a streamed response")
    }
}
