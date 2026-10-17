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
        XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 5))
        app.buttons["Cancel voice input"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        discardSavedRecording(app)
    }
    func testMicrophoneStaysOnTheRightBesideThePrimaryAction() {
        let app = XCUIApplication(); app.launchArguments = ["--demo"]; app.launch()
        app.buttons["sidebar-task-native"].tap()
        let model = app.buttons["composer-model"], options = app.buttons["Agent and task settings"], mic = app.buttons["record-voice"], stop = app.buttons["stop-task"]
        XCTAssertTrue(mic.waitForExistence(timeout: 5))
        let controls = [app.buttons["Add attachment"], model, options, mic, stop]
        for control in controls {
            XCTAssertGreaterThanOrEqual(control.frame.width, 48)
            XCTAssertGreaterThanOrEqual(control.frame.height, 48)
            XCTAssertLessThanOrEqual(control.frame.maxX, app.frame.maxX)
            XCTAssertTrue(control.isHittable)
        }
        XCTAssertLessThan(model.frame.maxX, options.frame.maxX)
        XCTAssertLessThanOrEqual(options.frame.maxX, mic.frame.minX)
        XCTAssertLessThanOrEqual(mic.frame.maxX, stop.frame.minX)
        XCTAssertFalse(app.buttons["send-message"].exists, "An empty running composer uses one Stop action, as Expo does")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "Composer matches Expo control order"; shot.lifetime = .keepAlways; add(shot)
    }
    func testPrimaryActionSwitchesBetweenStopQueueAndIdleSend() {
        let app = XCUIApplication(); app.launchArguments = ["--demo"]; app.launch()
        app.buttons["sidebar-task-native"].tap()
        let stop = app.buttons["stop-task"], send = app.buttons["send-message"], input = app.textFields["chat-input"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        let primaryFrame = stop.frame
        input.tap(); input.typeText("Follow up")
        XCTAssertTrue(send.isEnabled)
        XCTAssertEqual(send.label, "Queue message")
        XCTAssertFalse(stop.exists)
        XCTAssertEqual(send.frame.minX, primaryFrame.minX, accuracy: 1)
        capture("Draft uses the same primary position for queueing")
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 9))
        XCTAssertTrue(stop.isEnabled)
        XCTAssertFalse(send.exists)
        stop.tap()
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertEqual(send.label, "Send message")
        XCTAssertFalse(send.isEnabled)
        input.tap(); input.typeText("Continue after stopping")
        XCTAssertTrue(send.isEnabled)
        send.tap()
        let cleared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            input.exists && (input.value as? String) == "Message Codex…"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [cleared], timeout: 5), .completed)
        XCTAssertFalse(send.isEnabled)
    }
    func testOfflineComposerKeepsTheDraftWithoutReconnectNotices() {
        let app = XCUIApplication(); app.launchArguments = ["--demo", "--review-preview=offline"]; app.launch()
        app.buttons["sidebar-task-native"].tap()
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap(); input.typeText("Save this draft while offline.")
        XCTAssertFalse(app.buttons["send-message"].isEnabled)
        XCTAssertTrue(app.buttons["record-voice"].isEnabled)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Reconnect'")).firstMatch.exists)
        if app.frame.width < 600 {
            XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "session-sync-banner").firstMatch.exists)
        }
        capture("Offline composer keeps the draft without connection chatter")
    }
    func testFinishedTranscriptionReturnsToTheExistingDraft() {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--loading-preview=slow", "-native.speech.provider", "openrouter"]
        app.launch(); app.buttons["sidebar-task-native"].tap()
        let input = app.textFields["chat-input"]
        input.tap(); input.typeText("Keep this draft.")
        app.buttons["record-voice"].tap()
        let permission = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if permission.waitForExistence(timeout: 2) { permission.tap() }
        XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 5))
        app.buttons["Stop and transcribe"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "Keep this draft. A clear native transcript.")
        input.typeText(" Continue.")
        XCTAssertEqual(input.value as? String, "Keep this draft. A clear native transcript. Continue.")
        capture("Transcription preserves the draft and returns focus to the composer")
    }
    func testOpenRouterRecordingStartsOfflineAndWaitsWithoutLosingAudio() {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--review-preview=offline", "-native.speech.provider", "openrouter"]
        app.launch()
        app.buttons["sidebar-task-native"].tap()
        app.buttons["record-voice"].tap()
        let permission = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if permission.waitForExistence(timeout: 2) { permission.tap() }
        let recording = app.staticTexts["Recording"]
        XCTAssertTrue(recording.waitForExistence(timeout: 5))
        capture("OpenRouter microphone records while reconnecting")
        app.buttons["Stop and transcribe"].tap()
        XCTAssertTrue(app.staticTexts["Transcribing…"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Waiting for connection…"].exists)
        capture("Saved audio waits for connection before uploading")
        app.buttons["Cancel voice input"].tap()
        discardSavedRecording(app)
    }
    private func discardSavedRecording(_ app: XCUIApplication) {
        if app.buttons["BackButton"].isHittable { app.buttons["BackButton"].tap() }
        app.buttons["sidebar-settings"].tap()
        app.buttons["Speech"].tap()
        let discard = app.buttons["Discard recording"]
        XCTAssertTrue(discard.waitForExistence(timeout: 5), "Cancelling the upload must retain captured audio")
        discard.tap()
    }
    func testComputerVoiceFailureIsVisibleOnTheResponse() {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--review-preview=queue-error", "-native.readAloud.provider", "desktop"]
        app.launch()
        app.buttons["sidebar-task-native"].tap()
        let read = app.buttons["Read aloud"].firstMatch
        XCTAssertTrue(read.waitForExistence(timeout: 5))
        let error = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'read-aloud-error-'")).firstMatch
        XCTAssertFalse(error.exists)
        read.tap()
        XCTAssertTrue(error.waitForExistence(timeout: 4))
        XCTAssertTrue(error.label.contains("The preview computer is unavailable."))
        capture("Computer voice failure remains visible beside the response")
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
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
            XCTAssertGreaterThanOrEqual(cancel.frame.width, 48)
            XCTAssertEqual(cancel.frame.height, 48, accuracy: 1)
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
