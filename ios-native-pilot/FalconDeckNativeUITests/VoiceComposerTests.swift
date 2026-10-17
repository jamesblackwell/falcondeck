import XCTest

@MainActor final class VoiceComposerTests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    func testMicrophoneAfterSendingAClearedDraftDoesNotCrash() {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launchArguments = ["--demo", "-native.speech.provider", "openrouter"]; app.launch()
        app.buttons["sidebar-task-native"].tap()
        let input = app.textFields["chat-input"]
        input.tap(); input.typeText("A long draft with 🦅 Unicode that will be cleared before recording.")
        app.buttons["send-message"].tap()
        let cleared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in input.exists && (input.value as? String) != "A long draft with 🦅 Unicode that will be cleared before recording." }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [cleared], timeout: 5), .completed)
        app.buttons["record-voice"].tap()
        XCTAssertTrue(app.buttons["Cancel voice input"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Connect to your computer to use OpenRouter voice input."].exists)
        app.buttons["Cancel voice input"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
    }
    func testMicrophoneStaysOnTheRightBesideThePrimaryAction() {
        let app = XCUIApplication(); app.launchArguments = ["--demo"]; app.launch()
        app.buttons["sidebar-task-native"].tap()
        let model = app.buttons["composer-model"], options = app.buttons["Agent and task settings"], mic = app.buttons["record-voice"], stop = app.buttons["stop-task"], send = app.buttons["send-message"]
        XCTAssertTrue(mic.waitForExistence(timeout: 5))
        XCTAssertLessThan(model.frame.maxX, options.frame.maxX)
        XCTAssertLessThanOrEqual(options.frame.maxX, mic.frame.minX)
        XCTAssertLessThanOrEqual(mic.frame.maxX, stop.frame.minX)
        XCTAssertLessThanOrEqual(stop.frame.maxX, send.frame.minX)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "Composer matches Expo control order"; shot.lifetime = .keepAlways; add(shot)
    }
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
