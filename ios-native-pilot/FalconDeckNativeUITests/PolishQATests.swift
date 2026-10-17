import XCTest

/// Real navigation and screenshots, including compact widths and sheet handoffs.
@MainActor final class PolishQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    private func launch() -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launchArguments = ["--demo"]; app.launch()
        if !app.buttons["sidebar-settings"].exists, app.buttons["BackButton"].exists { app.buttons["BackButton"].tap() }
        XCTAssertTrue(app.buttons["sidebar-settings"].waitForExistence(timeout: 5)); return app
    }
    private func back(_ app: XCUIApplication, from title: String) {
        let bar = app.navigationBars[title]
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        bar.buttons.element(boundBy: 0).tap()
    }
    func testSidebarHierarchyDensityAndSheetTransitions() {
        let app = launch()
        let pin = app.buttons["sidebar-task-native"]
        XCTAssertTrue(pin.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(pin.frame.height, 48, "A pinned task must remain a compact single row")
        XCTAssertFalse(app.buttons["Archived tasks"].exists, "Archive belongs in secondary navigation")
        capture("01 Sidebar compact pins and projects")
        app.buttons["sidebar-section-projects"].tap()
        let chats = app.buttons["sidebar-section-chats"]
        XCTAssertTrue(chats.waitForExistence(timeout: 5))
        XCTAssertLessThan(app.buttons["sidebar-section-projects"].frame.minY, chats.frame.minY)
        capture("02 Projects before chats")
        app.buttons["Sidebar options"].tap()
        XCTAssertTrue(app.navigationBars["Sidebar options"].waitForExistence(timeout: 5))
        capture("03 Sidebar options stable sheet")
        app.buttons["Reorder projects"].tap()
        XCTAssertTrue(app.navigationBars["Project order"].waitForExistence(timeout: 5))
        capture("04 Project order sheet handoff")
        app.buttons["Cancel"].tap()
        app.buttons["Sidebar options"].tap()
        let archive = app.buttons["Archived tasks"]
        if !archive.isHittable { app.swipeUp() }
        archive.tap()
        XCTAssertTrue(app.navigationBars["Archived tasks"].waitForExistence(timeout: 5))
        capture("05 Archive secondary screen")
    }
    func testConversationControlsAndTaskSheetsStayWithinViewport() {
        let app = launch()
        app.buttons["sidebar-task-native"].tap()
        let model = app.buttons["composer-model"]
        XCTAssertTrue(model.waitForExistence(timeout: 5))
        XCTAssertTrue(model.isHittable, "Selecting a sidebar task must reveal the detail column on iPhone")
        let send = app.buttons["send-message"]
        XCTAssertLessThanOrEqual(model.frame.height, 48, "Model names must not wrap vertically")
        XCTAssertGreaterThanOrEqual(send.frame.width, 44)
        XCTAssertLessThanOrEqual(send.frame.maxX, app.frame.maxX)
        XCTAssertGreaterThanOrEqual(model.frame.minX, app.frame.minX)
        capture("06 Running conversation and compact composer")
        model.tap()
        XCTAssertTrue(app.navigationBars["Model & reasoning"].waitForExistence(timeout: 5))
        capture("07 Model and reasoning sheet")
        app.buttons["Done"].tap()
        app.buttons["Agent and task settings"].tap()
        XCTAssertTrue(app.navigationBars["Task settings"].waitForExistence(timeout: 5))
        capture("08 Task settings sheet")
        app.buttons["Done"].tap()
        app.buttons["task-menu"].tap()
        XCTAssertTrue(app.navigationBars["Task options"].waitForExistence(timeout: 5))
        capture("11 Task actions hierarchy")
        app.buttons["Rename task"].tap()
        XCTAssertTrue(app.textFields["task-title"].waitForExistence(timeout: 5))
        capture("12 Rename disclosure")
        app.buttons["Rename task"].tap()
        let goal = app.buttons["Set a goal"]
        if !goal.isHittable { app.swipeUp() }
        goal.tap()
        XCTAssertTrue(app.navigationBars["Goal"].waitForExistence(timeout: 5))
        capture("13 Goal editor")
        app.navigationBars["Goal"].buttons["Done"].tap()
        app.navigationBars["Task options"].buttons["Done"].tap()
        app.buttons["Add attachment"].tap()
        XCTAssertTrue(app.buttons["Photo library"].waitForExistence(timeout: 5))
        capture("09 Attachment menu anchor")
    }
    func testProjectFoldersActivityAndInteractiveRequests() {
        let app = launch()
        let project = app.buttons["project-falcondeck"]
        if !project.isHittable { app.swipeUp() }
        project.press(forDuration: 1)
        XCTAssertTrue(app.buttons["Project options"].waitForExistence(timeout: 5))
        capture("Project context menu")
        app.buttons["Project options"].tap()
        XCTAssertTrue(app.navigationBars["falcondeck"].waitForExistence(timeout: 5))
        capture("Project icon and visibility")
        app.buttons["Cancel"].tap()
        let review = app.buttons["sidebar-task-review"]
        if !review.isHittable { app.swipeUp() }
        XCTAssertTrue(review.waitForExistence(timeout: 5)); review.tap()
        XCTAssertTrue(app.buttons["Answer questions"].waitForExistence(timeout: 5))
        capture("Approval and question requests")
        let command = app.scrollViews["approval-command"]
        XCTAssertLessThanOrEqual(command.frame.height, 90, "Multiline command previews must remain bounded and scrollable")
        if !app.buttons["Answer questions"].isHittable { app.scrollViews["conversation-context"].swipeUp() }
        app.buttons["Answer questions"].tap()
        XCTAssertTrue(app.navigationBars["Questions"].waitForExistence(timeout: 5))
        capture("Question answer sheet")
        app.buttons["Cancel"].tap()
        app.terminate()
        let again = launch()
        again.buttons["Activity"].tap()
        XCTAssertTrue(again.navigationBars["Activity"].waitForExistence(timeout: 5))
        capture("Activity dense task feed")
    }
    func testEverySettingsScreenAndConnectionDiagnostics() {
        let app = launch()
        app.buttons["sidebar-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        capture("14 Settings index")
        for title in ["Appearance", "Conversation", "Notifications", "Speech", "Extensions", "About", "Developer", "Connections"] {
            let row = app.buttons[title == "About" ? "About FalconDeck" : title]
            if !row.isHittable { app.swipeUp() }
            row.tap()
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
            capture("Settings \(title)")
            if title == "Connections" {
                app.buttons["Connection log"].tap()
                XCTAssertTrue(app.navigationBars["Connection log"].waitForExistence(timeout: 5))
                capture("Connection log")
                back(app, from: "Connection log")
            }
            back(app, from: title)
            app.swipeDown()
        }
    }
}
