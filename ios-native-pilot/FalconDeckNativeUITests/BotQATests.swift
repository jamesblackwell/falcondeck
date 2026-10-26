import XCTest

@MainActor final class BotQATests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--bots-preview"]
        app.launch()
        sidebar(app)
        XCTAssertTrue(app.buttons["sidebar-bot-preview-bot"].waitForExistence(timeout: 5))
        return app
    }

    private func sidebar(_ app: XCUIApplication) {
        if !app.buttons["sidebar-settings"].isHittable, app.buttons["BackButton"].isHittable {
            app.buttons["BackButton"].tap()
        }
        XCTAssertTrue(app.buttons["sidebar-settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["sidebar-settings"].isHittable)
    }

    private func settings(_ app: XCUIApplication) {
        sidebar(app)
        let options = app.buttons["bot-options-preview-bot"]
        XCTAssertTrue(options.waitForExistence(timeout: 5))
        options.tap()
        XCTAssertTrue(app.textFields["bot-name"].waitForExistence(timeout: 5))
    }

    private func replace(_ element: XCUIElement, with text: String) {
        element.tap()
        element.typeKey("a", modifierFlags: .command)
        element.typeText(text)
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testBotOpensItsHomeConversation() {
        let app = launch()
        XCTAssertFalse(app.buttons["sidebar-task-preview-bot-home"].exists, "A bot home must not also appear as an ordinary project task")
        capture("Bots in the native sidebar")
        app.buttons["sidebar-bot-preview-bot"].tap()
        XCTAssertTrue(app.textFields["chat-input"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["task-menu"].exists)
        capture("Native bot conversation")
    }

    func testCreateBotAndKeepItsSidebarIdentity() {
        let app = launch()
        app.buttons["sidebar-new-bot"].tap()
        let name = app.textFields["bot-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["save-bot"].isEnabled)
        name.tap()
        name.typeText("Travel planner")
        let instructions = app.descendants(matching: .any).matching(identifier: "bot-instructions").firstMatch
        instructions.tap()
        instructions.typeText("Help me plan journeys and keep useful travel notes.")
        app.buttons["save-bot"].tap()
        XCTAssertTrue(name.waitForNonExistence(timeout: 5))
        sidebar(app)
        XCTAssertTrue(app.staticTexts["Travel planner"].waitForExistence(timeout: 5))
        capture("New bot available in the native sidebar")
    }

    func testBotSettingsSaveAndReopen() {
        let app = launch()
        settings(app)
        replace(app.textFields["bot-name"], with: "Research concierge")
        let instructions = app.descendants(matching: .any).matching(identifier: "bot-instructions").firstMatch
        replace(instructions, with: "Coordinate research tasks and report decisions.")
        app.buttons["save-bot"].tap()
        XCTAssertTrue(app.textFields["bot-name"].waitForNonExistence(timeout: 5))
        sidebar(app)
        XCTAssertTrue(app.staticTexts["Research concierge"].waitForExistence(timeout: 5))
        settings(app)
        XCTAssertEqual(app.textFields["bot-name"].value as? String, "Research concierge")
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "bot-instructions").firstMatch.value as? String,
                       "Coordinate research tasks and report decisions.")
        capture("Native bot settings retain edits")
    }

    func testBotDocumentCanBeCreatedAndReadBack() {
        let app = launch()
        settings(app)
        let newDocument = app.buttons["bot-new-document"]
        for _ in 0..<4 where !newDocument.isHittable { app.swipeUp() }
        XCTAssertTrue(newDocument.isHittable)
        newDocument.tap()
        let name = app.textFields["bot-document-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        replace(name, with: "Notes.md")
        let content = app.textViews["bot-document-content"]
        XCTAssertTrue(content.waitForExistence(timeout: 5))
        content.tap()
        content.typeText("# Useful notes\n\nKeep these decisions for our next conversation.")
        app.buttons["save-bot-document"].tap()
        XCTAssertTrue(name.waitForNonExistence(timeout: 5))
        let document = app.buttons["bot-document-Notes.md"]
        for _ in 0..<4 where !document.isHittable { app.swipeUp() }
        XCTAssertTrue(document.waitForExistence(timeout: 5))
        document.tap()
        XCTAssertTrue(content.waitForExistence(timeout: 5))
        XCTAssertEqual(name.value as? String, "Notes.md")
        XCTAssertEqual(content.value as? String, "# Useful notes\n\nKeep these decisions for our next conversation.")
        capture("Native bot document roundtrip")
    }
}
