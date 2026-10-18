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
    private func revealSidebar(_ app: XCUIApplication) {
        // A notification banner covers the native back button on a real phone.
        // Wait for it to leave rather than accidentally opening its source app.
        let banner = XCUIApplication(bundleIdentifier: "com.apple.springboard").descendants(matching: .any).matching(identifier: "NotificationShortLookView").firstMatch
        XCTAssertTrue(banner.waitForNonExistence(timeout: 12))
        let settings = app.buttons["sidebar-settings"]
        if !settings.exists || !settings.isHittable {
            let back = app.buttons["BackButton"]
            XCTAssertTrue(back.exists); back.tap()
        }
        let shown = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in settings.exists && settings.isHittable }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [shown], timeout: 3), .completed)
    }
    func testLoadedMessagesStayVisibleAcrossReopeningAndBackgrounding() {
        let app = launch()
        let latest = app.staticTexts["Latest response. This should appear in its final position immediately."]
        XCTAssertTrue(latest.waitForExistence(timeout: 5)); XCTAssertTrue(latest.isHittable)
        let pill = app.descendants(matching: .any).matching(identifier: "loading-pill").firstMatch
        XCTAssertTrue(pill.waitForNonExistence(timeout: 12))
        for cycle in 1...3 {
            revealSidebar(app)
            app.buttons["sidebar-settings"].tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
            revealSidebar(app)
            app.buttons["sidebar-task-native"].tap()
            capture("Reopened conversation cycle \(cycle)")
            XCTAssertTrue(latest.waitForExistence(timeout: 3), "Opening cycle \(cycle) must render the cached transcript")
            XCTAssertTrue(latest.isHittable)
            XCTAssertTrue(app.navigationBars.staticTexts["A more native way to work"].exists, "Reopening must preserve the chat title")
            XCUIDevice.shared.press(.home); app.activate()
            XCTAssertTrue(latest.waitForExistence(timeout: 3), "Returning cycle \(cycle) must retain the transcript")
            XCTAssertTrue(latest.isHittable)
            XCTAssertTrue(app.navigationBars.staticTexts["A more native way to work"].exists, "Returning must preserve the chat title")
            XCTAssertLessThan(latest.frame.maxY, app.textFields["chat-input"].frame.minY)
        }
        capture("Loaded conversation remains visible after three reopen and resume cycles")
    }
    func testSwitchingFromNestedSettingsResetsTheDetailDestination() {
        let app = launch()
        let latest = app.staticTexts["Latest response. This should appear in its final position immediately."]
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        revealSidebar(app); app.buttons["sidebar-settings"].tap()
        app.buttons["Connections"].tap()
        XCTAssertTrue(app.navigationBars["Connections"].waitForExistence(timeout: 3))
        let task = app.buttons["sidebar-task-native"]
        if !task.exists || !task.isHittable {
            app.navigationBars["Connections"].buttons.firstMatch.tap()
            revealSidebar(app)
        }
        task.tap()
        XCTAssertTrue(latest.waitForExistence(timeout: 3)); XCTAssertTrue(latest.isHittable)
        revealSidebar(app); app.buttons["sidebar-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.navigationBars["Connections"].exists, "A different sidebar destination must clear nested navigation")
        capture("Switching from nested settings replaces the detail without replacing its navigation stack")
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

@MainActor final class ConversationHeaderQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func launch(largeText: Bool = false) -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--loading-preview=settling"]
        if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch(); return app
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testGlassTitleStaysInPlaceWhileHistoryScrollsAndOptionsOpen() {
        let app = launch()
        let title = app.staticTexts["conversation-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "A more native way to work")
        let position = title.frame
        let transcript = app.descendants(matching: .any).matching(identifier: "conversation-transcript").firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 5))
        transcript.swipeDown()
        XCTAssertEqual(title.frame.minY, position.minY, accuracy: 1)
        XCTAssertTrue(app.buttons["task-menu"].isHittable)
        XCTAssertTrue(app.buttons["composer-model"].isHittable)
        capture("Glass title floats over scrolling conversation history")
        app.buttons["task-menu"].tap()
        XCTAssertTrue(app.navigationBars["Task options"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.frame.minY, position.minY, accuracy: 1)
        capture("Glass conversation title remains after dismissing options")
    }
    func testGlassTitleRemainsReadableWithAccessibilityText() {
        let app = launch(largeText: true)
        let title = app.staticTexts["conversation-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "A more native way to work")
        let bar = app.navigationBars.firstMatch
        XCTAssertGreaterThan(title.frame.height, 10)
        XCTAssertLessThanOrEqual(title.frame.maxY, bar.frame.maxY + 1)
        XCTAssertTrue(app.buttons["task-menu"].isHittable)
        capture("Glass conversation title at accessibility text size")
    }
}
