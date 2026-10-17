import XCTest

@MainActor final class NativeSmokeTests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func launchDemo() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo"]
        app.launch(); return app
    }
    private func sidebar(_ app: XCUIApplication) {
        if !app.buttons["Connection settings"].exists, app.buttons["BackButton"].exists { app.buttons["BackButton"].tap() }
        XCTAssertTrue(app.buttons["Connection settings"].waitForExistence(timeout: 5))
    }
    func testAutomationCanSaveAndDismissInLandscape() {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = launchDemo()
        sidebar(app)
        app.buttons["Connection settings"].tap()
        app.buttons["Automations"].tap()
        app.buttons["New automation"].tap()
        let name = app.textFields["automation-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5)); name.tap(); name.typeText("Native UI regression")
        let instruction = app.textFields["automation-instruction"]
        instruction.tap(); instruction.typeText("Review the native demo.")
        app.buttons["save-automation"].tap()
        XCTAssertTrue(app.staticTexts["Native UI regression"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.state, .runningForeground)
        capture("Landscape automation saved", app: app)
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
        XCTAssertTrue(app.buttons["Task options"].waitForExistence(timeout: 5))
        let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "A native place for your work")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertEqual(app.state, .runningForeground)
        capture("Native first reply", app: app)
    }
}
