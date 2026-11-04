import XCTest

/// The notification centre end to end in the demo workspace: the sidebar entry
/// and its badge, the history and filters, reading a report, replying, and the
/// computer-asleep states. No computer is involved.
@MainActor final class NotificationCentreQATests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    private func launch(_ arguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo"] + arguments
        app.launch()
        return app
    }
    /// Attaches the screenshot, and also writes it where `NOTIFICATION_SHOTS` points.
    private func capture(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let shot = XCTAttachment(screenshot: screenshot); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        if let directory = ProcessInfo.processInfo.environment["NOTIFICATION_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appending(path: name + ".png"))
        }
    }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func back(_ app: XCUIApplication) {
        let button = app.buttons["BackButton"].exists ? app.buttons["BackButton"] : app.navigationBars.buttons.element(boundBy: 0)
        button.tap()
    }
    private func openCentre(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["sidebar-notifications"].waitForExistence(timeout: 30))
        app.buttons["sidebar-notifications"].tap()
        XCTAssertTrue(element(app, "notification-row-N-48").waitForExistence(timeout: 30) || element(app, "notifications-offline").exists, app.debugDescription)
    }
    private func filter(_ app: XCUIApplication, _ title: String) { app.segmentedControls.buttons[title].tap() }
    /// Scrolls the screen until the element is clear of the bars.
    private func reveal(_ app: XCUIApplication, _ target: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        for _ in 0..<16 {
            if target.exists, target.isHittable, target.frame.maxY < app.frame.height - 40 { return }
            app.swipeUp(velocity: .slow)
        }
        XCTFail("\(target) never scrolled into reach", file: file, line: line)
    }

    func testSidebarBadgeHistoryAndFilters() {
        let app = launch()
        XCTAssertTrue(app.buttons["sidebar-notifications"].waitForExistence(timeout: 30))
        let predicate = NSPredicate(format: "value == %@", "4 unread")
        expectation(for: predicate, evaluatedWith: app.buttons["sidebar-notifications"])
        waitForExpectations(timeout: 15)
        capture("ios-1-sidebar")
        openCentre(app)
        XCTAssertTrue(element(app, "notification-row-N-48").waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Overnight relay soak finished"].exists)
        XCTAssertTrue(app.staticTexts["Today"].exists)
        XCTAssertTrue(app.buttons["notifications-mark-all"].exists)
        capture("ios-2-list")
        app.swipeUp()
        capture("ios-3-list-earlier")
        app.swipeDown()

        filter(app, "Needs you")
        XCTAssertTrue(element(app, "notification-row-N-46").waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "notification-row-N-43").exists, "An answered request no longer needs James")
        capture("ios-4-needs-you")
        filter(app, "From bots")
        XCTAssertTrue(element(app, "notification-row-N-42").waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "notification-row-N-46").exists)
    }

    func testReadAReportAndReplyToItsThread() {
        let app = launch()
        openCentre(app)
        XCTAssertTrue(element(app, "notification-row-N-48").waitForExistence(timeout: 20))
        element(app, "notification-row-N-48").tap()
        XCTAssertTrue(element(app, "notification-body").waitForExistence(timeout: 20))
        XCTAssertEqual(element(app, "notification-title").label, "Overnight relay soak finished")
        capture("ios-5-report-detail")

        let field = app.textViews["notification-reply"].exists ? app.textViews["notification-reply"] : app.textFields["notification-reply"]
        reveal(app, field)
        XCTAssertTrue(app.buttons["notification-reply-dictate"].exists, "The voice composer's mic is on the field")
        XCTAssertFalse(app.buttons["notification-reply-send"].isEnabled, "Nothing to send yet")
        capture("ios-6-report-reply")
        field.tap()
        field.typeText("Yes, do the upload change this week.")
        app.toolbars.buttons["Done"].firstMatch.tap()
        reveal(app, app.buttons["notification-reply-send"])
        XCTAssertTrue(app.buttons["notification-reply-send"].isEnabled)
        capture("ios-7-reply-typed")
        app.buttons["notification-reply-send"].tap()
        XCTAssertTrue(element(app, "notification-reply-sent").waitForExistence(timeout: 15))

        // The link back leaves the report for the thread that received the reply.
        reveal(app, app.buttons["notification-open-thread"])
        app.buttons["notification-open-thread"].tap()
        XCTAssertTrue(element(app, "conversation-title").waitForExistence(timeout: 20), "Open thread leaves the report")
        XCTAssertFalse(element(app, "notification-body").exists)
        // Demo chats reload their canned transcript, so the reply itself is covered by unit tests.
        back(app)
        XCTAssertTrue(app.buttons["sidebar-notifications"].waitForExistence(timeout: 20), "One back reaches the sidebar")
        XCTAssertTrue(app.buttons["sidebar-task-native"].waitForExistence(timeout: 10))
        app.buttons["sidebar-task-native"].tap()
        XCTAssertTrue(element(app, "conversation-title").waitForExistence(timeout: 20), "A task row still opens from the sidebar")
    }

    func testTappingFollowsTheRecordAndMarkAllClearsTheBadge() {
        let app = launch()
        openCentre(app)
        XCTAssertTrue(element(app, "notification-row-N-47").waitForExistence(timeout: 20))
        XCTAssertEqual(element(app, "notification-row-N-47").value as? String, "Unread")
        element(app, "notification-row-N-47").tap()
        XCTAssertTrue(element(app, "review-title").waitForExistence(timeout: 20), "A review record opens the review")
        back(app)
        XCTAssertTrue(element(app, "notification-row-N-47").waitForExistence(timeout: 20))
        XCTAssertNotEqual(element(app, "notification-row-N-47").value as? String, "Unread", "Opening it read it")

        element(app, "notification-row-N-46").tap()
        XCTAssertTrue(element(app, "conversation-title").waitForExistence(timeout: 20), "A request record opens its thread")
        back(app)

        XCTAssertTrue(app.buttons["sidebar-notifications"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.buttons["sidebar-notifications"].value as? String, "2 unread")
        app.buttons["sidebar-notifications"].tap()
        XCTAssertTrue(app.buttons["notifications-mark-all"].waitForExistence(timeout: 20))
        app.buttons["notifications-mark-all"].tap()
        XCTAssertFalse(app.buttons["notifications-mark-all"].waitForExistence(timeout: 2), "Nothing left to mark")
    }

    func testReadingWithTheComputerAsleep() {
        let app = launch(["--notification-preview=offline"])
        openCentre(app)
        XCTAssertTrue(element(app, "notifications-offline").waitForExistence(timeout: 20))
        XCTAssertTrue(element(app, "notification-row-N-48").waitForExistence(timeout: 20), "A hosted notice joins what was last loaded")
        capture("ios-8-offline-list")
        XCTAssertFalse(app.buttons["notifications-mark-all"].isEnabled, "Mark-all needs the computer")

        element(app, "notification-row-N-48").tap()
        XCTAssertTrue(element(app, "notification-relay-copy").waitForExistence(timeout: 20))
        XCTAssertTrue(element(app, "notification-body").exists)
        capture("ios-9-offline-report")
        back(app)

        XCTAssertTrue(element(app, "notification-row-N-48").waitForExistence(timeout: 20))
        app.swipeUp()
        XCTAssertTrue(element(app, "notification-row-N-40").waitForExistence(timeout: 20))
        element(app, "notification-row-N-40").tap()
        XCTAssertTrue(element(app, "notification-on-computer").waitForExistence(timeout: 20))
        capture("ios-10-on-your-computer")
    }
}
