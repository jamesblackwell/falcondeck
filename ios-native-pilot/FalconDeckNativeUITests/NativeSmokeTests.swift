import XCTest

@MainActor final class NativeSmokeTests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func launchDemo() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo"]
        app.launch(); return app
    }
    private func sidebar(_ app: XCUIApplication) {
        if !app.buttons["sidebar-settings"].exists, app.buttons["BackButton"].exists { app.buttons["BackButton"].tap() }
        XCTAssertTrue(app.buttons["sidebar-settings"].waitForExistence(timeout: 5))
    }
    func testAutomationCanSaveAndDismissInLandscape() {
        let app = launchDemo()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let landscape = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.frame.width > app.frame.height }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [landscape], timeout: 5), .completed)
        sidebar(app)
        app.buttons["sidebar-settings"].tap()
        app.buttons["Automations"].tap()
        app.buttons["New automation"].tap()
        let name = app.textFields["automation-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5)); name.tap(); name.typeText("Native UI regression")
        let instruction = app.textFields["automation-instruction"]
        instruction.tap(); instruction.typeText("Review the native demo.")
        app.buttons["save-automation"].tap()
        XCTAssertTrue(app.staticTexts["Native UI regression"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.state, .runningForeground)
        capture("Landscape automation saved")
    }
    func testFirstSendCreatesTaskAndRendersMarkdown() {
        XCUIDevice.shared.orientation = .portrait
        let app = launchDemo()
        sidebar(app)
        app.buttons["New chat"].tap()
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        input.typeText("Native UI smoke")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.buttons["task-menu"].waitForExistence(timeout: 5))
        let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "A native place for your work")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertEqual(app.state, .runningForeground)
        capture("Native first reply")
    }

    func testPairingMatchesScanOrEnterFlowAndShowsInlineErrors() {
        XCUIDevice.shared.orientation = .portrait
        let app = launchDemo()
        sidebar(app)
        app.buttons["sidebar-settings"].tap()
        app.buttons["Connections"].tap()
        app.buttons["Pair a computer"].tap()
        XCTAssertTrue(app.buttons["pair-scan"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Connect to your desktop agent"].exists)
        XCTAssertFalse(app.staticTexts["This pilot"].exists)
        XCTAssertFalse(app.buttons["pair-connect"].isEnabled)
        let input = app.textFields["pairing-input"]
        input.tap(); input.typeText("incomplete")
        app.buttons["pair-connect"].tap()
        XCTAssertTrue(app.staticTexts["pairing-error"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["pair-scan"].exists)
        XCTAssertFalse(app.otherElements["pairing-progress"].exists)
        capture("Native scan or enter pairing")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Pair a computer"].waitForExistence(timeout: 5))
    }
}
