import XCTest

/// The review inbox end to end in the demo workspace: the sidebar entry and its
/// badge, a review with image evidence, the file viewer, per-item feedback and
/// decisions, the submit bar, and the closed state. No computer is involved.
@MainActor final class ReviewInboxQATests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo"]
        app.launch()
        return app
    }
    /// Attaches the screenshot to the result, and also writes it where `REVIEW_SHOTS` points
    /// (the simulator shares the host's file system) so QA captures need no result-bundle export.
    private func capture(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let shot = XCTAttachment(screenshot: screenshot); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        if let directory = ProcessInfo.processInfo.environment["REVIEW_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appending(path: name.replacingOccurrences(of: " ", with: "-") + ".png"))
        }
    }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func sidebar(_ app: XCUIApplication) {
        if !app.buttons["sidebar-reviews"].isHittable, app.buttons["BackButton"].isHittable { app.buttons["BackButton"].tap() }
        XCTAssertTrue(app.buttons["sidebar-reviews"].waitForExistence(timeout: 30))
    }
    /// Scrolls until the element is on screen, clear of the navigation bar and the submit bar.
    private func reveal(_ app: XCUIApplication, _ target: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        for _ in 0..<24 {
            if target.exists, target.isHittable, target.frame.minY > 120, target.frame.maxY < app.frame.height - 100 { return }
            // Above the screen (or under the navigation bar) means scroll back; otherwise forward.
            if target.exists, target.frame.minY <= 120 { app.swipeDown(velocity: .slow) } else { app.swipeUp(velocity: .slow) }
        }
        XCTFail("\(target) never scrolled into reach (exists \(target.exists), hittable \(target.isHittable), frame \(target.frame), app \(app.frame))", file: file, line: line)
    }
    private func openFirstReview(_ app: XCUIApplication) {
        sidebar(app)
        app.buttons["sidebar-reviews"].tap()
        XCTAssertTrue(element(app, "review-row-R-12").waitForExistence(timeout: 30))
        element(app, "review-row-R-12").tap()
        XCTAssertTrue(element(app, "review-title").waitForExistence(timeout: 30))
    }

    func testSidebarShowsTheBadgeAndTheInboxListsOpenReviews() {
        let app = launch()
        sidebar(app)
        let entry = app.buttons["sidebar-reviews"]
        XCTAssertEqual(entry.value as? String, "2 open", "The badge is the open count")
        capture("1 Sidebar with the Reviews badge")
        entry.tap()
        XCTAssertTrue(element(app, "review-row-R-12").waitForExistence(timeout: 30))
        XCTAssertTrue(element(app, "review-row-R-11").exists)
        XCTAssertTrue(element(app, "review-row-R-9").exists, "Answered reviews sit below the open ones")
        XCTAssertTrue(app.staticTexts["Pricing page refresh"].exists)
        XCTAssertTrue(app.staticTexts["Ship the new hero and pricing table this afternoon?"].exists)
        capture("2 Reviews inbox")
    }

    func testAnswerAReviewWithEvidenceFeedbackAndDecisions() {
        let app = launch()
        openFirstReview(app)
        XCTAssertEqual(element(app, "review-ask").label, "Ship the new hero and pricing table this afternoon?")
        XCTAssertTrue(element(app, "review-recommendation").exists)
        XCTAssertTrue(element(app, "review-going-ahead").exists)
        XCTAssertTrue(app.buttons["review-submit"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["review-submit"].isEnabled, "Nothing is decided yet")
        XCTAssertTrue(element(app, "review-submit-status").label.hasPrefix("Needs a decision on Hero"), element(app, "review-submit-status").label)
        capture("3 Review screen top")

        // Evidence opens the existing file viewer, and closing returns to the same place.
        let evidence = app.buttons["review-evidence-e1"]
        reveal(app, evidence)
        capture("4 Item card with evidence, chips and feedback")
        evidence.tap()
        XCTAssertTrue(element(app, "file-viewer").waitForExistence(timeout: 30))
        XCTAssertTrue(element(app, "file-viewer-image").waitForExistence(timeout: 30), "The demo image should load through the file store")
        sleep(1)
        capture("5 File viewer on an image")
        app.buttons["file-viewer-close"].tap()
        XCTAssertTrue(app.buttons["file-viewer-close"].waitForNonExistence(timeout: 15))
        XCTAssertTrue(element(app, "review-title").exists || app.buttons["review-evidence-e1"].exists)

        // Per-item feedback, typed, with a decision on each item.
        let feedback = element(app, "review-feedback-i2")
        reveal(app, feedback)
        feedback.tap()
        feedback.typeText("Make the annual toggle default.")
        app.buttons["Done"].firstMatch.tap()
        XCTAssertEqual(feedback.value as? String, "Make the annual toggle default.")
        for (item, decision) in [("i1", "approve"), ("i2", "request_changes"), ("i3", "reject")] {
            let chip = app.buttons["review-decision-\(item)-\(decision)"]
            reveal(app, chip)
            chip.tap()
            XCTAssertTrue(chip.isSelected, "\(item) \(decision)")
        }
        let submit = app.buttons["review-submit"]
        XCTAssertTrue(submit.isEnabled, "Every item has a decision")
        XCTAssertEqual(element(app, "review-progress").label, "3 of 3 decided")
        capture("6 Submit bar ready")

        // Leaving the screen keeps what was typed.
        let back = app.navigationBars.buttons.matching(NSPredicate(format: "label == 'Reviews'")).firstMatch
        (back.exists ? back : app.navigationBars.buttons.firstMatch).tap()
        XCTAssertTrue(element(app, "review-row-R-12").waitForExistence(timeout: 15))
        element(app, "review-row-R-12").tap()
        let again = element(app, "review-feedback-i2")
        reveal(app, again)
        XCTAssertEqual(again.value as? String, "Make the annual toggle default.")
        XCTAssertTrue(app.buttons["review-submit"].isEnabled)

        app.buttons["review-submit"].tap()
        XCTAssertTrue(element(app, "review-closed-banner").waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Changes requested"].exists)
        XCTAssertFalse(app.buttons["review-submit"].exists, "A closed review has no submit bar")
        reveal(app, element(app, "review-answer-i2"))
        XCTAssertTrue(app.staticTexts["Make the annual toggle default."].exists, "James's feedback stays on the closed review")
        capture("7 Closed state with decisions")
    }

    func testOneDecisionForTheWholeReview() {
        let app = launch()
        sidebar(app)
        app.buttons["sidebar-reviews"].tap()
        element(app, "review-row-R-11").tap()
        XCTAssertTrue(element(app, "review-title").waitForExistence(timeout: 30))
        let toggle = element(app, "review-overall-toggle")
        reveal(app, toggle)
        toggle.tap()
        let approve = app.buttons["review-overall-decision-approve"]
        reveal(app, approve)
        approve.tap()
        XCTAssertTrue(app.buttons["review-submit"].isEnabled, "An overall answer covers every item")
        let note = element(app, "review-overall-note")
        reveal(app, note)
        note.tap(); note.typeText("Send it Friday.")
        app.buttons["Done"].firstMatch.tap()
        app.buttons["review-submit"].tap()
        XCTAssertTrue(element(app, "review-closed-banner").waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Approved"].exists)
        XCTAssertTrue(app.staticTexts["Send it Friday."].exists)
    }

    func testAnswersThatCouldNotBeDeliveredSaySo() {
        let app = launch()
        sidebar(app)
        app.buttons["sidebar-reviews"].tap()
        let row = element(app, "review-row-R-8")
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        XCTAssertTrue(row.label.contains("Couldn't reach Libra"), row.label)
        reveal(app, row)
        row.tap()
        XCTAssertTrue(element(app, "review-delivery-failed").waitForExistence(timeout: 30))
        capture("8 Closed review whose answer was not delivered")
    }
}
