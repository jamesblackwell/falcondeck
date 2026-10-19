import XCTest

@MainActor final class TaskActivityQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    func testTaskLiveActivityCanBeStartedAndHiddenWithoutAnAgentTurn() {
        let app = XCUIApplication(); app.launchArguments = ["--demo", "--task-activity-preview"]; app.launch()
        XCTAssertTrue(app.buttons["task-menu"].waitForExistence(timeout: 5)); app.buttons["task-menu"].tap()
        let control = app.buttons["task-live-activity"]
        for _ in 0..<4 where !control.isHittable { app.swipeUp() }
        XCTAssertTrue(control.isHittable); XCTAssertEqual(control.label, "Show on Lock Screen")
        XCTAssertTrue(control.isEnabled); control.tap()
        let following = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in control.label == "Hide from Lock Screen" }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [following], timeout: 5), .completed)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Task Live Activity follows local content"; shot.lifetime = .keepAlways; add(shot)
        app.navigationBars["Task options"].buttons["Done"].tap()
        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // Notification Center presents the same Lock Screen activity surface
        // without locking the simulator or requiring any device credentials.
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0))
        top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.85)))
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Local preview")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 5))
        if springboard.buttons["Always Allow"].exists { springboard.buttons["Always Allow"].tap() }
        if springboard.buttons["Allow"].exists { springboard.buttons["Allow"].tap() }
        let lockScreen = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); lockScreen.name = "Real ActivityKit task card on the Lock Screen surface"; lockScreen.lifetime = .keepAlways; add(lockScreen)
        app.activate()
        XCTAssertTrue(app.buttons["task-menu"].waitForExistence(timeout: 5)); app.buttons["task-menu"].tap()
        for _ in 0..<4 where !control.isHittable { app.swipeUp() }
        XCTAssertEqual(control.label, "Hide from Lock Screen")
        control.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in control.label == "Show on Lock Screen" }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
    }
    func testLockScreenShowsInputCompletionAndLastKnownStatus() {
        for (mode, value, label) in [("input", "Needs you", "Needs you"), ("complete", "", "Completed"), ("offline", "Last known status", "Last seen:")] {
            let app = XCUIApplication(); app.launchArguments = ["--demo", "--task-activity-preview", "--task-activity-phase=" + mode]; app.launch()
            XCTAssertTrue(app.buttons["task-menu"].waitForExistence(timeout: 5)); app.buttons["task-menu"].tap()
            let control = app.buttons["task-live-activity"]
            for _ in 0..<4 where !control.isHittable { app.swipeUp() }
            XCTAssertTrue(control.isEnabled); control.tap()
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                mode == "complete" ? control.label == "Show on Lock Screen" : control.value as? String == value
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 12), .completed)
            XCUIDevice.shared.press(.home)
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0))
            top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.85)))
            let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
            XCTAssertTrue(banner.waitForExistence(timeout: 5))
            if springboard.buttons["Always Allow"].exists { springboard.buttons["Always Allow"].tap() }
            if springboard.buttons["Allow"].exists { springboard.buttons["Allow"].tap() }
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "Lock Screen task status " + mode; shot.lifetime = .keepAlways; add(shot)
            app.activate()
            if mode != "complete" {
                let hide = app.buttons["task-live-activity"]
                for _ in 0..<4 where !hide.isHittable { app.swipeUp() }
                if hide.label == "Hide from Lock Screen" { hide.tap() }
            }
            app.terminate()
        }
    }
}
