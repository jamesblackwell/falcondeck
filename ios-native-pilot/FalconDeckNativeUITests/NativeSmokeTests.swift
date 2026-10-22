import XCTest

@MainActor final class NativeReviewTests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func launch(_ mode: String) -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launchArguments = ["--demo", "--review-preview=" + mode]; app.launch()
        if !app.buttons["sidebar-task-native"].exists, app.buttons["BackButton"].exists { app.buttons["BackButton"].tap() }
        XCTAssertTrue(app.buttons["sidebar-task-native"].waitForExistence(timeout: 5))
        app.buttons["sidebar-task-native"].tap(); return app
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testQueuedMessageEditorPreservesFullMultilineTextAndSaves() {
        let app = launch("queue")
        app.buttons["queued-options-review-queue"].tap(); app.buttons["Edit message"].tap()
        let editor = app.textViews["queued-message-text"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String)?.contains("Leave the released app alone") == true, "Editing must load full text, not the truncated preview")
        capture("Queue full multiline editor")
        editor.tap(); editor.typeKey("a", modifierFlags: .command); editor.typeText("Edited queue message.\n\nKeep the second paragraph.")
        app.buttons["save-queued-message"].tap()
        XCTAssertTrue(editor.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["queued-options-review-queue"].exists)
        XCTAssertTrue(app.staticTexts["Edited queue message.\n\nKeep the second paragraph."].exists)
        capture("Queue saved with full multiline text")
    }
    func testDispatchDuringEditingKeepsTheDraftAvailableToCopy() {
        let app = launch("dispatched")
        XCTAssertTrue(app.textViews["queued-message-text"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["save-queued-message"].isEnabled)
        let copy = app.buttons["Copy edited message"]
        for _ in 0..<3 where !copy.isHittable { app.swipeUp() }
        XCTAssertTrue(copy.isHittable)
        capture("Dispatched queue preserves unsaved edits")
        app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
        XCTAssertTrue(app.textFields["chat-input"].waitForExistence(timeout: 5))
    }
    func testFailedQueueSaveRetainsEditsAndShowsTheError() {
        let app = launch("queue-error")
        app.buttons["queued-options-review-queue"].tap(); app.buttons["Edit message"].tap()
        let editor = app.textViews["queued-message-text"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap(); editor.typeKey("a", modifierFlags: .command); editor.typeText("Retain these unsaved edits.")
        app.buttons["save-queued-message"].tap()
        XCTAssertTrue(app.staticTexts["The preview computer is unavailable."].waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String)?.contains("Retain these unsaved edits.") == true)
        XCTAssertTrue(app.buttons["save-queued-message"].isEnabled)
        capture("Queue save failure retains edits")
    }
    func testLoadedConversationCanBeSharedOffline() {
        let app = launch("offline")
        XCTAssertFalse(app.buttons["stop-task"].isEnabled)
        app.buttons["task-menu"].tap()
        let share = app.buttons["share-conversation"]
        for _ in 0..<3 where !share.isHittable { app.swipeUp() }
        XCTAssertTrue(share.isEnabled); XCTAssertTrue(share.isHittable)
        capture("Offline conversation sharing remains available")
        share.tap()
        XCTAssertTrue(app.otherElements["ActivityListView"].waitForExistence(timeout: 5))
        capture("Native offline share sheet")
    }
    func testFullToolOutputSupportsNativeFind() {
        let app = launch("output")
        app.buttons["Worked · 1 activity"].tap()
        app.buttons["Review output"].coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        let full = app.buttons["Open full output"]
        let transcript = app.descendants(matching: .any).matching(identifier: "conversation-transcript").firstMatch
        for _ in 0..<4 where !full.isHittable { transcript.swipeUp() }
        full.tap()
        XCTAssertTrue(app.textViews["tool-output-text"].waitForExistence(timeout: 5))
        app.typeKey("f", modifierFlags: .command)
        let search = app.searchFields["find.searchField"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("focused")
        XCTAssertEqual(search.value as? String, "focused")
        XCTAssertTrue(app.textViews["tool-output-text"].exists)
        capture("Native find in full tool output")
    }
}

@MainActor final class PlanReviewQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func launch(_ mode: String = "plan") -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launchArguments = ["--demo", "--review-preview=" + mode]; app.launch()
        if !app.buttons["sidebar-task-native"].isHittable, app.buttons["BackButton"].isHittable { app.buttons["BackButton"].tap() }
        let task = app.buttons["sidebar-task-native"]
        XCTAssertTrue(task.waitForExistence(timeout: 5)); task.tap()
        XCTAssertTrue(app.buttons["plan-abandon"].waitForExistence(timeout: 5))
        return app
    }
    @discardableResult private func reveal(_ id: String, in app: XCUIApplication, earlier: Bool = false) -> XCUIElement {
        let element = app.descendants(matching: .any).matching(identifier: id).firstMatch
        let context = app.scrollViews["conversation-context"]
        for _ in 0..<5 where !element.isHittable {
            if earlier { context.swipeDown() } else { context.swipeUp() }
        }
        XCTAssertTrue(element.isHittable, "Plan control \(id) must be reachable")
        return element
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testRequestChangesRequiresFeedbackAndKeepsTheComposerDraft() {
        let app = launch()
        XCTAssertFalse(app.buttons["plan-request-changes"].isEnabled)
        let feedback = reveal("plan-feedback", in: app, earlier: true)
        feedback.tap(); feedback.typeText(" \n")
        XCTAssertFalse(app.buttons["plan-request-changes"].isEnabled)
        feedback.typeText("Revise validation.\nKeep the daemon API unchanged.")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["plan-request-changes"].isEnabled)
        reveal("plan-request-changes", in: app)
        capture("Native plan review with revision feedback")
        app.buttons["plan-request-changes"].tap()
        XCTAssertTrue(app.buttons["plan-request-changes"].waitForNonExistence(timeout: 5))
        XCTAssertEqual(app.textFields["chat-input"].value as? String, "Keep my separate follow-up.")
    }
    func testApproveAndAbandonResolveWithoutConsumingTheComposer() {
        for id in ["plan-approve", "plan-abandon"] {
            let app = launch()
            reveal(id, in: app).tap()
            XCTAssertTrue(app.buttons[id].waitForNonExistence(timeout: 5))
            XCTAssertEqual(app.textFields["chat-input"].value as? String, "Keep my separate follow-up.")
            app.terminate()
        }
    }
    func testMissingPlanCannotBeApprovedButCanBeAbandoned() {
        let app = launch("plan-empty")
        XCTAssertFalse(app.buttons["plan-approve"].isEnabled)
        XCTAssertTrue(app.staticTexts["This provider did not supply a plan to review."].exists)
        reveal("plan-abandon", in: app).tap()
        XCTAssertTrue(app.buttons["plan-abandon"].waitForNonExistence(timeout: 5))
    }
    func testFailureKeepsFeedbackAndMakesTheReviewAvailableForRetry() {
        let app = launch("plan-error")
        let feedback = reveal("plan-feedback", in: app, earlier: true)
        feedback.tap(); feedback.typeText("Keep this revision feedback for retry.")
        app.buttons["Done"].tap()
        reveal("plan-request-changes", in: app).tap()
        XCTAssertTrue(app.staticTexts["The preview computer is unavailable."].waitForExistence(timeout: 5))
        XCTAssertEqual(feedback.value as? String, "Keep this revision feedback for retry.")
        XCTAssertTrue(app.buttons["plan-request-changes"].isEnabled)
        XCTAssertTrue(app.buttons["plan-abandon"].isEnabled)
        XCTAssertEqual(app.textFields["chat-input"].value as? String, "Keep my separate follow-up.")
        reveal("plan-feedback", in: app, earlier: true)
        capture("Failed plan response retains revision feedback")
    }
    func testOfflineReviewCannotSubmitAnyPlanOutcome() {
        let app = launch("plan-offline")
        for id in ["plan-approve", "plan-abandon", "plan-request-changes", "plan-feedback"] {
            XCTAssertFalse(app.descendants(matching: .any).matching(identifier: id).firstMatch.isEnabled)
        }
    }
}

@MainActor final class NativeSmokeTests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func launchDemo() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo"]
        app.launch(); return app
    }
    private func sidebar(_ app: XCUIApplication) {
        if !app.buttons["sidebar-settings"].exists, app.buttons["BackButton"].exists { app.buttons["BackButton"].tap() }
        XCTAssertTrue(app.buttons["sidebar-settings"].waitForExistence(timeout: 5))
    }
    func testAutomationCanSaveAndDismissInLandscape() {
        XCUIDevice.shared.orientation = .portrait
        let app = launchDemo()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let landscape = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.frame.width > app.frame.height }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [landscape], timeout: 5), .completed)
        sidebar(app)
        app.buttons["sidebar-settings"].tap()
        app.buttons["Automations"].tap()
        app.buttons["New automation"].tap()
        let name = app.textFields["automation-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5)); name.tap(); name.typeText("Native UI regression")
        let instruction = app.textFields["automation-instruction"]
        instruction.tap(); instruction.typeText("Review the native demo.")
        app.buttons["save-automation"].tap()
        XCTAssertTrue(app.staticTexts["Native UI regression"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.state, .runningForeground)
        capture("Landscape automation saved")
        app.terminate()
        let chat = launchDemo()
        sidebar(chat)
        chat.buttons["sidebar-task-native"].tap()
        XCTAssertTrue(chat.buttons["composer-model"].waitForExistence(timeout: 5))
        XCTAssertTrue(chat.buttons["composer-model"].isHittable)
        let latest = chat.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Use the composer to continue the conversation")).firstMatch
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            latest.exists && latest.isHittable && latest.frame.maxY <= chat.textFields["chat-input"].frame.minY - 8
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 5), .completed)
        capture("Landscape conversation")
    }
    func testFirstSendCreatesTaskAndRendersMarkdown() {
        XCUIDevice.shared.orientation = .portrait
        let app = launchDemo()
        sidebar(app)
        app.buttons["sidebar-new-chat"].tap()
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        input.typeText("Native UI smoke")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.buttons["task-menu"].waitForExistence(timeout: 5))
        let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "A native place for your work")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertEqual(app.state, .runningForeground)
        capture("Native first reply")
    }

    func testPairingMatchesScanOrEnterFlowAndShowsInlineErrors() {
        XCUIDevice.shared.orientation = .portrait
        let app = launchDemo()
        sidebar(app)
        app.buttons["sidebar-settings"].tap()
        app.buttons["Connections"].tap()
        app.buttons["Pair a computer"].tap()
        XCTAssertTrue(app.buttons["pair-scan"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Connect to your desktop agent"].exists)
        XCTAssertFalse(app.staticTexts["This pilot"].exists)
        XCTAssertFalse(app.buttons["pair-connect"].isEnabled)
        let input = app.textFields["pairing-input"]
        input.tap(); input.typeText("incomplete")
        app.buttons["pair-connect"].tap()
        XCTAssertTrue(app.staticTexts["pairing-error"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["pair-scan"].exists)
        XCTAssertFalse(app.otherElements["pairing-progress"].exists)
        capture("Native scan or enter pairing")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Pair a computer"].waitForExistence(timeout: 5))
    }
}
