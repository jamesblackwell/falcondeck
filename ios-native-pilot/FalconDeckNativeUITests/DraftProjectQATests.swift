import XCTest

@MainActor final class DraftProjectQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["--demo"] + extra; app.launch(); return app
    }
    private func choose(_ id: String, in app: XCUIApplication, search: String? = nil) {
        let picker = app.buttons["draft-project-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 5)); picker.tap()
        XCTAssertTrue(app.navigationBars["Choose project"].waitForExistence(timeout: 5))
        if search != nil {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Native searchable project sheet"; shot.lifetime = .keepAlways; add(shot)
        }
        if let search {
            let field = app.searchFields["Search projects"]
            XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText(search)
        }
        let row = app.buttons["choose-project-" + id]
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        XCTAssertTrue(app.navigationBars["Choose project"].waitForNonExistence(timeout: 5))
    }
    func testProjectPickerSearchesAndKeepsEachProjectsDraft() {
        let app = launch()
        // Compact launches start in the sidebar. Enter through the same project
        // compose action as a normal new thread, rather than a shortcut fixture.
        let compose = app.buttons["New task in falcondeck"]
        XCTAssertTrue(compose.waitForExistence(timeout: 5)); compose.tap()
        choose("falcondeck", in: app, search: "falcon")
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap(); input.typeText("Draft for FalconDeck")
        choose("quizgecko", in: app)
        XCTAssertEqual(app.buttons["draft-project-picker"].value as? String, "quizgecko")
        XCTAssertEqual(input.value as? String, "Message Codex…")
        input.tap(); input.typeText("Draft for Quizgecko")
        choose("falcondeck", in: app)
        XCTAssertEqual(input.value as? String, "Draft for FalconDeck")
        choose("quizgecko", in: app)
        XCTAssertEqual(input.value as? String, "Draft for Quizgecko")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Project picker stays available on new tasks"; shot.lifetime = .keepAlways; add(shot)
    }
    func testNewTaskCanChooseAnIsolatedCopyAndRemembersItPerProject() {
        let app = launch()
        let compose = app.buttons["New task in falcondeck"]
        XCTAssertTrue(compose.waitForExistence(timeout: 5)); compose.tap()
        let location = app.buttons["composer-isolation"]
        XCTAssertTrue(location.waitForExistence(timeout: 5))
        XCTAssertEqual(location.value as? String, "Project folder")
        location.tap()
        app.buttons["Isolated copy"].tap()
        XCTAssertEqual(location.value as? String, "Isolated copy")
        choose("quizgecko", in: app)
        XCTAssertEqual(location.value as? String, "Project folder")
        choose("falcondeck", in: app)
        XCTAssertEqual(location.value as? String, "Isolated copy")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "New task isolated copy selector"; shot.lifetime = .keepAlways; add(shot)
        let input = app.textFields["chat-input"]
        input.tap(); input.typeText("Work in an isolated copy")
        app.buttons["send-message"].tap()
        XCTAssertTrue(location.waitForNonExistence(timeout: 5), "An existing task's checkout cannot be changed from the composer")
        XCTAssertTrue(app.buttons["task-menu"].waitForExistence(timeout: 5))
    }
    func testActualShortcutOpensTheChosenProjectAndPreservesInput() {
        let app = launch(["--shortcut-preview=task"])
        let input = app.textFields["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["draft-project-picker"].value as? String, "falcondeck")
        XCTAssertEqual(input.value as? String, "Existing draft.\n\nReview these changes from Shortcuts.")
        XCTAssertFalse(app.buttons["task-menu"].exists, "The shortcut must prepare input without starting an agent")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Actual New task App Intent prepares a local draft"; shot.lifetime = .keepAlways; add(shot)
    }
    func testOpenProjectAndActivityShortcutsUseNativeNavigation() {
        let app = launch(["--shortcut-preview=project"])
        XCTAssertTrue(app.buttons["draft-project-picker"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["draft-project-picker"].value as? String, "falcondeck")
        app.terminate()
        let activity = launch(["--shortcut-preview=activity"])
        XCTAssertTrue(activity.navigationBars["Activity"].waitForExistence(timeout: 5))
    }
}
