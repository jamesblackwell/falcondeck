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
        XCTAssertTrue(app.buttons["Delete recording"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 5))
        app.buttons["Delete recording"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["record-voice"].label, "Record voice message")
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
        app.buttons["Delete recording"].tap()
        XCTAssertEqual(app.buttons["record-voice"].label, "Record voice message")
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
        for phase in ["starting", "recording", "transcribing", "failed", "ready"] {
            let app = XCUIApplication(); app.launchArguments = ["--demo", "--voice-preview=" + phase]; app.launch()
            app.buttons["sidebar-task-native"].tap()
            let cancel = app.buttons[phase == "starting" ? "Cancel voice input" : "Delete recording"]
            XCTAssertTrue(cancel.waitForExistence(timeout: 5))
            XCTAssertFalse(app.textFields["chat-input"].exists)
            XCTAssertFalse(app.buttons["composer-model"].exists)
            XCTAssertGreaterThanOrEqual(cancel.frame.width, 44)
            XCTAssertGreaterThanOrEqual(cancel.frame.height, 44)
            if phase == "transcribing" {
                XCTAssertTrue(app.staticTexts["Transcribing…"].exists)
                XCTAssertFalse(app.buttons["Transcribe and send"].exists)
            } else if phase == "recording" {
                XCTAssertTrue(app.buttons["Stop and transcribe"].isEnabled)
                XCTAssertTrue(app.buttons["Transcribe and send"].isEnabled)
                XCTAssertTrue(app.staticTexts["0:42"].exists)
            } else if phase == "starting" {
                XCTAssertFalse(app.buttons["Transcribe and send"].isEnabled)
            } else if phase == "ready" {
                XCTAssertTrue(app.buttons["Transcribe recording"].isHittable)
                XCTAssertTrue(app.staticTexts["Recording saved"].exists)
                XCTAssertFalse(app.staticTexts["0:00"].exists)
            } else {
                XCTAssertTrue(app.buttons["Retry transcription"].isHittable)
                XCTAssertTrue(app.buttons["Recording options"].isHittable)
            }
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "Voice composer " + phase; shot.lifetime = .keepAlways; add(shot)
            cancel.tap()
            let input = app.textFields["chat-input"]
            XCTAssertTrue(input.waitForExistence(timeout: 5))
            XCTAssertEqual(input.value as? String, "Keep my existing draft.")
            app.terminate()
        }
    }
    func testSavedRecordingInAnotherTaskOffersUseOrDeleteWithoutOpeningSettings() {
        for choice in ["Delete recording", "Use recording here"] {
            let app = XCUIApplication(); app.launchArguments = ["--demo", "--voice-preview=other-task"]; app.launch()
            app.buttons["sidebar-task-native"].tap()
            let input = app.textFields["chat-input"]
            XCTAssertTrue(input.waitForExistence(timeout: 5))
            app.buttons["record-voice"].tap()
            XCTAssertTrue(app.buttons[choice].waitForExistence(timeout: 5))
            XCTAssertFalse(app.navigationBars["Speech"].exists)
            capture("Saved recording offers explicit recovery or deletion")
            app.buttons[choice].tap()
            if choice == "Use recording here" {
                XCTAssertTrue(app.staticTexts["Recording saved"].waitForExistence(timeout: 5))
                app.buttons["Transcribe recording"].tap()
                // Local fixture has no audio file; failure must stay inline.
                XCTAssertTrue(app.buttons["Retry transcription"].waitForExistence(timeout: 5))
                XCTAssertFalse(app.navigationBars["Speech"].exists)
                capture("Retry errors stay inline with a clear delete action")
                app.buttons["Delete recording"].tap()
            }
            XCTAssertTrue(input.waitForExistence(timeout: 5))
            XCTAssertEqual(input.value as? String, "Keep my existing draft.")
            XCTAssertEqual(app.buttons["record-voice"].label, "Record voice message")
            XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "voice-input").firstMatch.exists)
            app.terminate()
        }
    }
    func testKeepingAudioForLaterDoesNotTrapTheComposer() {
        let app = XCUIApplication(); app.launchArguments = ["--demo", "--loading-preview=slow", "--voice-preview=ready"]; app.launch()
        app.buttons["sidebar-task-native"].tap()
        let options = app.buttons["Recording options"]
        XCTAssertTrue(options.waitForExistence(timeout: 5)); options.tap()
        app.buttons["Keep recording for later"].tap()
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "Keep my existing draft.")
        XCTAssertEqual(app.buttons["record-voice"].label, "Recover saved recording")
        app.buttons["record-voice"].tap()
        XCTAssertTrue(app.staticTexts["Recording saved"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Speech"].exists)
        app.buttons["Delete recording"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.typeText(" Continue typing.")
        XCTAssertEqual(input.value as? String, "Keep my existing draft. Continue typing.")
        capture("Deleting a saved recording returns directly to the typed draft")
    }

    func testLongRecordingAndHalfHourLimitKeepClearControlsAndDraft() {
        for phase in ["long", "limit"] {
            let app = XCUIApplication(); app.launchArguments = ["--demo", "--loading-preview=slow", "--voice-preview=" + phase]; app.launch()
            app.buttons["sidebar-task-native"].tap()
            if phase == "long" {
                XCTAssertTrue(app.staticTexts["15:00"].waitForExistence(timeout: 5))
                XCTAssertTrue(app.buttons["Stop and transcribe"].isEnabled)
            } else {
                XCTAssertTrue(app.staticTexts["30-minute limit reached. Your recording is saved and ready to transcribe."].waitForExistence(timeout: 5))
                XCTAssertTrue(app.buttons["Transcribe recording"].isHittable)
                XCTAssertFalse(app.staticTexts["Couldn't transcribe"].exists)
            }
            capture("Long recording composer " + phase)
            app.buttons["Delete recording"].tap()
            let input = app.textFields["chat-input"]
            XCTAssertTrue(input.waitForExistence(timeout: 5))
            XCTAssertEqual(input.value as? String, "Keep my existing draft.")
            app.terminate()
        }
    }

}
