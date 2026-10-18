import XCTest

@MainActor final class PerformanceUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    func testLongHistoryRemainsEditableAndNavigableWhileTwelveConversationsStream() {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launchArguments = ["--demo", "--performance-preview"]; app.launch()
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["stop-task"].exists)
        input.tap(); input.typeText("Keep this draft while other conversations stream.")
        XCTAssertEqual(input.value as? String, "Keep this draft while other conversations stream.")
        let transcript = app.descendants(matching: .any).matching(identifier: "conversation-transcript").firstMatch
        transcript.swipeDown()
        let jump = app.buttons["Jump to latest message"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Long history and editable draft during twelve local streams"; screenshot.lifetime = .keepAlways; add(screenshot)
        jump.tap()
        XCTAssertEqual(input.value as? String, "Keep this draft while other conversations stream.")
        if app.buttons["BackButton"].exists { app.buttons["BackButton"].tap() }
        let second = app.buttons["sidebar-task-perf-1"]
        XCTAssertTrue(second.waitForExistence(timeout: 5)); second.tap()
        XCTAssertTrue(app.textFields["chat-input"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Words 👋'")).firstMatch.waitForExistence(timeout: 5))
        let secondShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        secondShot.name = "Switch to another cached streaming conversation"; secondShot.lifetime = .keepAlways; add(secondShot)
    }
}
