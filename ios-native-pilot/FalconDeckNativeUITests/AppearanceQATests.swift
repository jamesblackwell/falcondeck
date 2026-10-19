import XCTest

/// Local history only: no pairing, network requests, or agent turns.
@MainActor final class AppearanceQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private let lightThemes = ["falcon-light", "catppuccin-latte", "alucard", "gruvbox-light", "nord-light", "one-light", "rose-pine-dawn", "solarized-light", "tokyo-night-light"]
    private let darkThemes = ["falcon-dark", "catppuccin-mocha", "dracula", "gruvbox-dark", "matrix", "nord", "one-dark", "rose-pine", "solarized-dark", "tokyo-night"]
    private func launch(theme: String, mode: String, draft: Bool = false) -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["--demo", draft ? "--shortcut-preview=project" : "--loading-preview=settling",
            "-native.appearance.mode", mode, "-native.appearance." + mode, theme]
        app.launch(); return app
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    private func checkThemes(_ themes: [String], mode: String) {
        for theme in themes {
            let app = launch(theme: theme, mode: mode)
            let title = app.staticTexts["conversation-title"]
            XCTAssertTrue(title.waitForExistence(timeout: 8))
            XCTAssertEqual(title.label, "A more native way to work")
            XCTAssertTrue(app.staticTexts["Latest response. This should appear in its final position immediately."].waitForExistence(timeout: 12))
            let frame = title.frame
            capture(theme + " — conversation")
            let transcript = app.descendants(matching: .any).matching(identifier: "conversation-transcript").firstMatch
            transcript.swipeDown()
            XCTAssertEqual(title.frame.minY, frame.minY, accuracy: 1)
            XCTAssertTrue(app.buttons["task-menu"].isHittable)
            capture(theme + " — scrolled title")
            app.terminate()
        }
    }
    func testEveryLightThemeAcrossScrollingHistory() { checkThemes(lightThemes, mode: "light") }
    func testEveryDarkThemeAcrossScrollingHistory() { checkThemes(darkThemes, mode: "dark") }
    func testProjectTitlesAndSheetsInLightAndDark() {
        for (theme, mode) in [("catppuccin-latte", "light"), ("solarized-light", "light"), ("falcon-dark", "dark")] {
            let app = launch(theme: theme, mode: mode, draft: true)
            let title = app.buttons["draft-project-picker"]
            XCTAssertTrue(title.waitForExistence(timeout: 8))
            XCTAssertEqual(title.value as? String, "falcondeck")
            capture(theme + " — project title")
            title.tap()
            XCTAssertTrue(app.buttons["choose-project-falcondeck"].waitForExistence(timeout: 5))
            XCTAssertLessThanOrEqual(app.searchFields["Search projects"].frame.height, 60)
            XCTAssertTrue(app.buttons["choose-project-quizgecko"].isHittable)
            capture(theme + " — project sheet")
            app.buttons["choose-project-quizgecko"].tap()
            XCTAssertTrue(app.navigationBars["Choose project"].waitForNonExistence(timeout: 5))
            XCTAssertEqual(title.value as? String, "quizgecko")
            XCTAssertTrue(app.textFields["chat-input"].isHittable)
            capture(theme + " — changed project title")
            app.terminate()
        }
    }
    func testChangingAppearanceKeepsNavigationAndProjectTitlesReadable() {
        let app = launch(theme: "falcon-light", mode: "light", draft: true)
        XCTAssertTrue(app.buttons["draft-project-picker"].waitForExistence(timeout: 8))
        if !app.buttons["sidebar-settings"].isHittable { app.buttons["BackButton"].tap() }
        app.buttons["sidebar-settings"].tap()
        app.buttons["Appearance"].tap()
        XCTAssertTrue(app.navigationBars["Appearance"].waitForExistence(timeout: 5))
        for mode in ["Dark", "Light", "System", "Light"] {
            app.segmentedControls.buttons[mode].tap()
            XCTAssertTrue(app.staticTexts["Your agents, in focus."].isHittable)
            capture("Appearance changed to " + mode)
        }
        app.navigationBars["Appearance"].buttons.element(boundBy: 0).tap()
        if !app.buttons["sidebar-settings"].isHittable { app.buttons["BackButton"].tap() }
        app.buttons["New task in falcondeck"].tap()
        XCTAssertEqual(app.buttons["draft-project-picker"].value as? String, "falcondeck")
        capture("Project title after changing appearance")
    }

    func testProjectSearchClearsAndDismissesTheKeyboard() {
        let app = launch(theme: "catppuccin-latte", mode: "light", draft: true)
        let picker = app.buttons["draft-project-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 8)); picker.tap()
        let field = app.searchFields["Search projects"]
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("No matching project")
        XCTAssertFalse(app.buttons["choose-project-falcondeck"].exists)
        capture("Readable project search and empty results")
        field.buttons["Clear text"].tap()
        XCTAssertTrue(app.buttons["choose-project-falcondeck"].waitForExistence(timeout: 5))
        field.typeText("quiz\n")
        XCTAssertTrue(app.buttons["choose-project-quizgecko"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.keyboards.count, 0)
        capture("Native search keeps results after dismissing the keyboard")
        app.buttons["choose-project-quizgecko"].tap()
        XCTAssertTrue(app.navigationBars["Choose project"].waitForNonExistence(timeout: 5))
        XCTAssertEqual(picker.value as? String, "quizgecko")
    }

}
