import XCTest

@MainActor final class MessageDeliveryQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func launch(_ mode: String, reduceMotion: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--send-preview=" + mode] + (reduceMotion ? ["--motion-reduce"] : [])
        app.launch(); return app
    }
    private func status(_ text: String, in app: XCUIApplication, timeout: TimeInterval = 3) {
        let indicator = app.descendants(matching: .any).matching(identifier: "conversation-delivery-status").firstMatch
        let wait = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in indicator.exists && indicator.label.contains(text) }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [wait], timeout: timeout), .completed)
    }
    private func capture(_ name: String, app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testNewTaskShowsTheMessageBeforeCreationAndKeepsOneRowAfterAcceptance() {
        let app = launch("new"), text = "Immediate first message"
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap(); input.typeText(text)
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 1))
        XCTAssertNotEqual(input.value as? String, text)
        status("Sending…", in: app)
        XCTAssertFalse(app.buttons["task-menu"].exists, "The message must appear before thread.start returns")
        capture("First message is visible during task creation", app: app)
        XCTAssertTrue(app.buttons["task-menu"].waitForExistence(timeout: 8))
        status("Thinking…", in: app, timeout: 10)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", text)).count, 1)
        XCTAssertTrue(app.staticTexts[text].isHittable)
        XCTAssertGreaterThanOrEqual(app.staticTexts[text].frame.minY, app.navigationBars.firstMatch.frame.maxY - 1)
        XCTAssertLessThan(app.staticTexts[text].frame.maxY, input.frame.minY)
        XCTAssertTrue(app.keyboards.firstMatch.exists, "A typed send must not dismiss the keyboard during task handoff")
        capture("The created task keeps the message and keyboard steady", app: app)
    }
    func testExistingTaskHasImmediateSendingFeedbackAndAnInPlaceAcknowledgement() {
        let app = launch("existing"), text = "Smooth follow-up message"
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap(); input.typeText(text)
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 1)); status("Sending…", in: app)
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        capture("Existing conversation shows local sending feedback", app: app)
        status("Thinking…", in: app, timeout: 8)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", text)).count, 1)
        capture("Mac acceptance changes the status in place", app: app)
    }
    func testTranscribedInputUsesTheSameImmediateDeliveryPathWithReduceMotion() {
        let app = launch("voice", reduceMotion: true), text = "A clear native transcript."
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); XCTAssertEqual(input.value as? String, text)
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 1)); status("Sending…", in: app)
        XCTAssertNotEqual(input.value as? String, text)
        status("Thinking…", in: app, timeout: 8)
        capture("Transcribed input sends immediately with Reduce Motion", app: app)
    }
    func testFailureRestoresTheInputAndAllowsAnExplicitRetry() {
        let app = launch("failure"), text = "Keep this message if sending fails"
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap(); input.typeText(text)
        app.buttons["send-message"].tap(); status("Sending…", in: app)
        let restored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in input.exists && input.value as? String == text }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [restored], timeout: 8), .completed)
        XCTAssertFalse(app.staticTexts[text].exists)
        XCTAssertTrue(app.buttons["send-message"].isEnabled)
        capture("Failed delivery restores the original input", app: app)
        app.buttons["send-message"].tap(); status("Sending…", in: app)
        status("Thinking…", in: app, timeout: 8)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", text)).count, 1)
    }
    func testTranscriptHandoffStaysBusyWithoutFlashingTheEditorOrAllowingAnotherUpload() {
        let app = launch("handoff")
        XCTAssertTrue(app.staticTexts["Transcribing…"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.textFields["chat-input"].exists)
        XCTAssertFalse(app.buttons["Transcribe and send"].exists)
        XCTAssertFalse(app.buttons["Stop and transcribe"].exists)
        XCTAssertFalse(app.buttons["Delete recording"].isEnabled)
        capture("Transcript handoff remains in the existing busy surface", app: app)
    }
}
