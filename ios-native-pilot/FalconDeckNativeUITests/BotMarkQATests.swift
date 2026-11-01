import XCTest

@MainActor final class BotMarkQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }

    private func launch() -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--bots-preview"]
        app.launch()
        XCTAssertTrue(app.buttons["sidebar-bot-preview-bot"].waitForExistence(timeout: 8))
        return app
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }

    func testMarksAppearInSidebarHeaderAndBotSheet() {
        let app = launch()
        capture("1 Bot marks in the sidebar")
        // A bot waiting on you swaps its mark for the warning dot, as on the web.
        XCTAssertTrue(app.buttons["sidebar-bot-preview-bot2"].exists)
        app.buttons["sidebar-bot-preview-bot"].tap()
        let title = app.buttons["conversation-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 6))
        XCTAssertTrue(title.label.contains("bot details"))
        capture("2 Bot conversation header carries the mark")
        title.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "bot-info").firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["bot-status-age"].waitForExistence(timeout: 5) || app.descendants(matching: .any).matching(identifier: "bot-status-age").firstMatch.exists)
        capture("3 Bot sheet: status and age")
        app.swipeUp()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "bot-schedule-preview-auto-1").firstMatch.waitForExistence(timeout: 3))
        capture("4 Bot sheet: tickets, schedules and dispatches")
        app.swipeUp()
        capture("5 Bot sheet: dispatched work")
    }

    func testScheduleToggleUpdatesInTheSheet() {
        let app = launch()
        app.buttons["sidebar-bot-preview-bot"].tap()
        app.buttons["conversation-title"].tap()
        let toggle = app.switches["Morning status refresh enabled"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5) || { app.swipeUp(); return toggle.waitForExistence(timeout: 3) }())
        XCTAssertEqual(toggle.value as? String, "1")
        toggle.tap()
        let paused = NSPredicate(format: "value == '0'")
        expectation(for: paused, evaluatedWith: toggle); waitForExpectations(timeout: 4)
        capture("6 Schedule paused from the bot sheet")
    }

    func testActivityRowsCarryBotMarks() {
        let app = launch()
        app.buttons["Activity"].firstMatch.tap()
        XCTAssertTrue(app.buttons["activity-task-preview-spawn-1"].waitForExistence(timeout: 6))
        capture("7 Activity rows name the dispatching bot")
    }
}
