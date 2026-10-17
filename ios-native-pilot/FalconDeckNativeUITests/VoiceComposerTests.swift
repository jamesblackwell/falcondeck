import XCTest

@MainActor final class VoiceComposerTests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    func testVoiceStatesReplaceTheInputWithoutLosingTheDraft() {
        XCUIDevice.shared.orientation = .portrait
        for phase in ["starting", "recording", "transcribing", "failed"] {
            let app = XCUIApplication(); app.launchArguments = ["--demo", "--voice-preview=" + phase]; app.launch()
            app.buttons["sidebar-task-native"].tap()
            let cancel = app.buttons["Cancel voice input"]
            XCTAssertTrue(cancel.waitForExistence(timeout: 5))
            XCTAssertFalse(app.textFields["chat-input"].exists)
            XCTAssertFalse(app.buttons["composer-model"].exists)
            XCTAssertGreaterThanOrEqual(cancel.frame.width, 44)
            XCTAssertLessThanOrEqual(cancel.frame.height, 48)
            if phase == "transcribing" {
                XCTAssertTrue(app.staticTexts["Transcribing…"].exists)
                XCTAssertFalse(app.buttons["Transcribe and send"].exists)
            } else if phase == "recording" {
                XCTAssertTrue(app.buttons["Stop and transcribe"].isEnabled)
                XCTAssertTrue(app.buttons["Transcribe and send"].isEnabled)
                XCTAssertTrue(app.staticTexts["0:42"].exists)
            } else if phase == "starting" {
                XCTAssertFalse(app.buttons["Transcribe and send"].isEnabled)
            } else {
                XCTAssertTrue(app.buttons["Retry transcription"].isHittable)
                XCTAssertTrue(app.buttons["Speech settings"].isHittable)
            }
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "Voice composer " + phase; shot.lifetime = .keepAlways; add(shot)
            cancel.tap()
            let input = app.textFields["chat-input"]
            XCTAssertTrue(input.waitForExistence(timeout: 5))
            XCTAssertEqual(input.value as? String, "Keep my existing draft.")
            app.terminate()
        }
    }
}
