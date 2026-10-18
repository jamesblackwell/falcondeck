import XCTest

@MainActor final class MotionQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func launch(_ mode: String, policy: String? = nil) -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launchArguments = ["--demo", "--motion-preview=" + mode]
        if let policy { app.launchArguments.append("--motion-" + policy) }
        app.launch(); return app
    }
    private func capture(_ name: String) {
        let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        image.name = name; image.lifetime = .keepAlways; add(image)
    }
    func testCanvasWaveformPreservesRecordingControlsAndDraft() {
        let app = launch("recording")
        let cancel = app.buttons["Cancel voice input"], stop = app.buttons["Stop and transcribe"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Recording"].exists)
        for control in [cancel, stop, app.buttons["Transcribe and send"]] {
            XCTAssertTrue(control.isHittable)
            XCTAssertGreaterThanOrEqual(control.frame.width, 48)
            XCTAssertGreaterThanOrEqual(control.frame.height, 48)
        }
        capture("Canvas voice waveform and unchanged native controls")
        cancel.tap()
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "Keep my existing draft.")
        capture("Recording cancellation preserves the existing draft")
    }
    func testGoalCompletionPreservesComposerPosition() {
        let app = launch("goal")
        let goal = app.buttons["goal-status-button"], input = app.textFields["chat-input"]
        XCTAssertTrue(goal.waitForExistence(timeout: 5))
        let position = input.frame
        let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in goal.label.contains("Complete") }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 6), .completed)
        XCTAssertEqual(input.frame.minY, position.minY, accuracy: 1)
        XCTAssertTrue(goal.isHittable)
        capture("A live goal completes without moving the composer")
        goal.tap()
        XCTAssertTrue(app.buttons["delete-goal"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
    }
    func testReducedMotionAndLowPowerRetainSemanticFeedback() {
        for policy in ["reduce", "low-power"] {
            let app = launch("thinking", policy: policy)
            XCTAssertTrue(app.staticTexts["Thinking…"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["record-voice"].isHittable)
            capture("Thinking feedback under " + policy)
            app.terminate()
            let recording = launch("recording", policy: policy)
            XCTAssertTrue(recording.staticTexts["Recording"].waitForExistence(timeout: 5))
            XCTAssertTrue(recording.buttons["Cancel voice input"].isHittable)
            capture("Voice feedback under " + policy)
            recording.terminate()
        }
    }
}
