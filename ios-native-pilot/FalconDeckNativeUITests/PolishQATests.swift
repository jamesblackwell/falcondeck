import XCTest

/// Real navigation and screenshots, including compact widths and sheet handoffs.
@MainActor final class PolishQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    private func launch(arguments: [String] = []) -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launchArguments = ["--demo"] + arguments; app.launch()
        if !app.buttons["sidebar-settings"].exists, app.buttons["BackButton"].exists { app.buttons["BackButton"].tap() }
        XCTAssertTrue(app.buttons["sidebar-settings"].waitForExistence(timeout: 5)); return app
    }
    private func back(_ app: XCUIApplication, from title: String) {
        let bar = app.navigationBars[title]
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        bar.buttons.element(boundBy: 0).tap()
    }
    private func transcript(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "conversation-transcript").firstMatch
    }
    private func showSidebar(_ app: XCUIApplication) {
        if !app.buttons["sidebar-settings"].isHittable {
            let back = app.buttons["BackButton"]
            XCTAssertTrue(back.waitForExistence(timeout: 5)); back.tap()
        }
        XCTAssertTrue(app.buttons["sidebar-settings"].isHittable)
    }
    func testRenameTaskSavesAndReopens() {
        let app = launch()
        app.buttons["sidebar-task-native"].tap()
        app.buttons["task-menu"].tap()
        app.buttons["Rename task"].coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5)).tap()
        let title = app.textFields["task-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap()
        title.press(forDuration: 1.2)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        else { title.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (title.value as? String ?? "").count)) }
        title.typeText("Renamed from task options")
        app.buttons["Save title"].tap()
        XCTAssertTrue(app.navigationBars["Task options"].waitForNonExistence(timeout: 5))
        app.buttons["task-menu"].tap()
        app.buttons["Rename task"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.value as? String, "Renamed from task options")
    }
    func testArchiveAndRestorePreserveTheComposerDraft() {
        let app = launch()
        app.buttons["sidebar-task-native"].tap()
        let draft = "Keep this unfinished message after archiving."
        let input = app.textFields["chat-input"]
        input.tap(); input.typeText(draft)
        app.buttons["task-menu"].tap()
        let archive = app.buttons["Archive task"]
        for _ in 0..<4 where !archive.isHittable { app.swipeUp() }
        archive.tap()
        showSidebar(app)
        app.buttons["Sidebar options"].tap()
        let archivedTasks = app.buttons["Archived tasks"]
        if !archivedTasks.isHittable { app.swipeUp() }
        archivedTasks.tap()
        let archived = app.buttons.containing(.staticText, identifier: "A more native way to work").firstMatch
        XCTAssertTrue(archived.waitForExistence(timeout: 5)); archived.tap()
        let restore = app.buttons["Restore task to continue"]
        XCTAssertTrue(restore.waitForExistence(timeout: 5)); restore.tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, draft)
        capture("Archived task restores its unsent composer input")
    }
    func testReselectingTheSameSidebarDestinationReopensDetail() {
        let app = launch()
        for _ in 0..<2 {
            app.buttons["sidebar-task-native"].tap()
            XCTAssertTrue(app.textFields["chat-input"].isHittable)
            showSidebar(app)
        }
        for _ in 0..<2 {
            app.buttons["sidebar-settings"].tap()
            XCTAssertTrue(app.buttons["About FalconDeck"].isHittable)
            showSidebar(app)
        }
    }
    func testSearchRevealsTasksInsideCollapsedSections() {
        let app = launch()
        app.buttons["sidebar-section-pinned"].tap()
        let search = app.searchFields.firstMatch
        search.tap(); search.typeText("voice")
        XCTAssertTrue(app.buttons["sidebar-task-voice"].waitForExistence(timeout: 3))
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        XCTAssertFalse(app.buttons["sidebar-task-voice"].exists, "Clearing search must restore the collapsed section")
        let folder = app.buttons["Native app"]
        folder.tap()
        search.tap(); search.typeText("sidebar")
        XCTAssertTrue(app.buttons["sidebar-task-review"].waitForExistence(timeout: 3))
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 7))
        XCTAssertFalse(app.buttons["sidebar-task-review"].exists, "Search must not change a folder's saved collapsed state")
        let chats = app.buttons["sidebar-section-chats"]
        for _ in 0..<4 where !chats.isHittable { app.swipeUp() }
        chats.tap()
        for _ in 0..<4 where !search.isHittable { app.swipeDown() }
        search.tap(); search.typeText("release")
        XCTAssertTrue(app.buttons["sidebar-task-chat"].waitForExistence(timeout: 3))
    }
    func testExpandAllSurvivesRecreatedTranscriptRows() {
        let app = launch()
        app.buttons["sidebar-task-native"].tap()
        app.buttons["task-menu"].tap()
        let expand = app.buttons["Expand all activity"]
        for _ in 0..<4 where !expand.isHittable { app.swipeUp() }
        expand.tap()
        app.navigationBars["Task options"].buttons["Done"].tap()
        showSidebar(app)
        app.buttons["Activity"].tap()
        showSidebar(app)
        app.buttons["sidebar-task-native"].tap()
        let output = app.staticTexts["All focused checks passed."]
        for _ in 0..<8 where !output.isHittable { transcript(app).swipeDown() }
        XCTAssertTrue(output.isHittable, "The retained expand-all directive must apply when list cells are created")
        capture("Expanded activity after reopening conversation")
    }
    func testSidebarHierarchyDensityAndSheetTransitions() {
        let app = launch()
        let pin = app.buttons["sidebar-task-native"]
        XCTAssertTrue(pin.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(pin.frame.height, 48, "A pinned task must remain a compact single row")
        XCTAssertFalse(app.buttons["Archived tasks"].exists, "Archive belongs in secondary navigation")
        capture("01 Sidebar compact pins and projects")
        app.buttons["sidebar-section-projects"].tap()
        let chats = app.buttons["sidebar-section-chats"]
        XCTAssertTrue(chats.waitForExistence(timeout: 5))
        XCTAssertLessThan(app.buttons["sidebar-section-projects"].frame.minY, chats.frame.minY)
        capture("02 Projects before chats")
        app.buttons["Sidebar options"].tap()
        XCTAssertTrue(app.navigationBars["Sidebar options"].waitForExistence(timeout: 5))
        capture("03 Sidebar options stable sheet")
        app.buttons["Reorder projects"].tap()
        XCTAssertTrue(app.navigationBars["Project order"].waitForExistence(timeout: 5))
        capture("04 Project order sheet handoff")
        app.buttons["Cancel"].tap()
        app.buttons["Sidebar options"].tap()
        let archive = app.buttons["Archived tasks"]
        if !archive.isHittable { app.swipeUp() }
        archive.tap()
        XCTAssertTrue(app.navigationBars["Archived tasks"].waitForExistence(timeout: 5))
        capture("05 Archive secondary screen")
    }
    func testConversationControlsAndTaskSheetsStayWithinViewport() {
        let app = launch()
        app.buttons["sidebar-task-native"].tap()
        let model = app.buttons["composer-model"]
        XCTAssertTrue(model.waitForExistence(timeout: 5))
        XCTAssertTrue(model.isHittable, "Selecting a sidebar task must reveal the detail column on iPhone")
        let primary = app.buttons["stop-task"]
        XCTAssertLessThanOrEqual(model.frame.height, 48, "Model names must not wrap vertically")
        XCTAssertGreaterThanOrEqual(primary.frame.width, 48)
        XCTAssertLessThanOrEqual(primary.frame.maxX, app.frame.maxX)
        XCTAssertGreaterThanOrEqual(model.frame.minX, app.frame.minX)
        let latest = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Use the composer to continue the conversation")).firstMatch
        let visibleAboveComposer = NSPredicate { _, _ in
            latest.exists && latest.isHittable && latest.frame.maxY <= app.textFields["chat-input"].frame.minY - 8
        }
        let atLatest = XCTNSPredicateExpectation(predicate: visibleAboveComposer, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [atLatest], timeout: 5), .completed, "Opening history must reveal the latest response after Markdown reflow")
        let jump = app.buttons["Jump to latest message"]
        XCTAssertFalse(jump.exists, "Following the latest response should not add a redundant jump control")
        capture("06 Running conversation and compact composer")
        for _ in 0..<3 { transcript(app).swipeDown() }
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        capture("Conversation reading position")
        jump.tap()
        let returned = XCTNSPredicateExpectation(predicate: visibleAboveComposer, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [returned], timeout: 5), .completed)
        model.tap()
        XCTAssertTrue(app.navigationBars["Model & reasoning"].waitForExistence(timeout: 5))
        capture("07 Model and reasoning sheet")
        app.buttons["Done"].tap()
        app.buttons["Agent and task settings"].tap()
        XCTAssertTrue(app.navigationBars["Task settings"].waitForExistence(timeout: 5))
        capture("08 Task settings sheet")
        app.buttons["Done"].tap()
        app.buttons["task-menu"].tap()
        XCTAssertTrue(app.navigationBars["Task options"].waitForExistence(timeout: 5))
        capture("11 Task actions hierarchy")
        app.buttons["Rename task"].tap()
        XCTAssertTrue(app.textFields["task-title"].waitForExistence(timeout: 5))
        capture("12 Rename disclosure")
        app.buttons["Rename task"].tap()
        let goal = app.buttons["Set a goal"]
        if !goal.isHittable { app.swipeUp() }
        goal.tap()
        XCTAssertTrue(app.navigationBars["Goal"].waitForExistence(timeout: 5))
        capture("13 Goal editor")
        app.navigationBars["Goal"].buttons["Done"].tap()
        app.navigationBars["Task options"].buttons["Done"].tap()
        app.buttons["Add attachment"].tap()
        XCTAssertTrue(app.buttons["Photo library"].waitForExistence(timeout: 5))
        XCTAssertLessThan(app.buttons["Photo library"].frame.minY, app.buttons["Paste image"].frame.minY, "Bottom-edge menus must retain the authored action order")
        capture("09 Attachment menu anchor")
    }
    func testProjectFoldersActivityAndInteractiveRequests() {
        let app = launch()
        let project = app.buttons["project-falcondeck"]
        if !project.isHittable { app.swipeUp() }
        project.press(forDuration: 1)
        XCTAssertTrue(app.buttons["Project options"].waitForExistence(timeout: 5))
        capture("Project context menu")
        app.buttons["Project options"].tap()
        XCTAssertTrue(app.navigationBars["falcondeck"].waitForExistence(timeout: 5))
        capture("Project icon and visibility")
        app.buttons["Cancel"].tap()
        let review = app.buttons["sidebar-task-review"]
        if !review.isHittable { app.swipeUp() }
        XCTAssertTrue(review.waitForExistence(timeout: 5)); review.tap()
        XCTAssertTrue(app.buttons["Answer questions"].waitForExistence(timeout: 5))
        capture("Approval and question requests")
        let command = app.scrollViews["approval-command"]
        XCTAssertLessThanOrEqual(command.frame.height, 90, "Multiline command previews must remain bounded and scrollable")
        if !app.buttons["Answer questions"].isHittable { app.scrollViews["conversation-context"].swipeUp() }
        app.buttons["Answer questions"].tap()
        XCTAssertTrue(app.navigationBars["Questions"].waitForExistence(timeout: 5))
        capture("Question answer sheet")
        app.buttons["Cancel"].tap()
        app.terminate()
        let again = launch()
        again.buttons["Activity"].tap()
        XCTAssertTrue(again.navigationBars["Activity"].waitForExistence(timeout: 5))
        capture("Activity dense task feed")
    }
    func testGoalDeletionStaysVisibleForLongCompletedAndActiveGoals() {
        for provider in ["codex", "claude"] {
            for status in ["complete", "active"] {
                let app = launch(arguments: ["--goal-preview=\(provider)-\(status)"])
                app.buttons["sidebar-task-native"].tap()
                let goal = app.buttons["Goal · \(status.capitalized)"]
                XCTAssertTrue(goal.waitForExistence(timeout: 5)); goal.tap()
                let delete = app.buttons["delete-goal"]
                XCTAssertTrue(delete.waitForExistence(timeout: 5))
                XCTAssertTrue(delete.isHittable, "Long goals must not push deletion off-screen")
                if status == "complete" { XCTAssertFalse(app.buttons["Pause goal"].exists) }
                capture("\(provider) \(status) goal has a visible delete action")
                delete.tap()
                XCTAssertTrue(app.navigationBars["Goal"].waitForNonExistence(timeout: 5))
                XCTAssertFalse(goal.exists)
                XCTAssertTrue(app.textFields["chat-input"].exists, "Deleting a goal keeps its conversation")
                app.buttons["task-menu"].tap()
                let create = app.buttons["Set a goal"]
                for _ in 0..<3 where !create.isHittable { app.swipeUp() }
                XCTAssertTrue(create.isHittable, "A new goal can be created after deletion")
                app.terminate()
            }
        }
    }
    func testGoalEditorActiveAndPausedStates() {
        let app = launch()
        app.buttons["sidebar-task-native"].tap()
        app.buttons["task-menu"].tap()
        let setGoal = app.buttons["Set a goal"]
        if !setGoal.isHittable { app.swipeUp() }
        setGoal.tap()
        let objective = app.textFields["goal-objective"]
        XCTAssertTrue(objective.waitForExistence(timeout: 5))
        objective.tap(); objective.typeText("Polish the native app")
        let start = app.buttons["start-goal"]
        if !start.isHittable { app.swipeUp() }
        start.tap()
        app.buttons["View goal"].tap()
        XCTAssertTrue(app.buttons["Pause goal"].waitForExistence(timeout: 5))
        capture("Active goal controls")
        app.buttons["Pause goal"].tap()
        app.buttons["View goal"].tap()
        XCTAssertTrue(app.buttons["Resume goal"].waitForExistence(timeout: 5))
        capture("Paused goal controls")
        app.buttons["delete-goal"].tap()
        XCTAssertTrue(app.buttons["Set a goal"].waitForExistence(timeout: 5))
    }
    func testSidebarSearchFiltersAndRestoresTheProjectTree() {
        let app = launch()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("voice")
        XCTAssertTrue(app.buttons["sidebar-task-voice"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["sidebar-task-native"].exists)
        capture("Sidebar search results")
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        XCTAssertTrue(app.buttons["sidebar-task-native"].waitForExistence(timeout: 5))
    }
    func testExpandingLongMessagePreservesReadingPosition() {
        let app = launch()
        app.buttons["sidebar-task-native"].tap()
        let more = app.buttons["Show more"]
        for _ in 0..<5 where !more.isHittable { transcript(app).swipeDown() }
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: more)
        XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 5), .completed)
        let message = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Please keep the following priorities")).firstMatch
        let originalTop = message.frame.minY
        more.tap()
        XCTAssertEqual(message.frame.minY, originalTop, accuracy: 24, "Expanding text must keep the reader in place instead of following the bottom")
        let latest = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Use the composer to continue the conversation")).firstMatch
        XCTAssertFalse(latest.exists && latest.isHittable, "Expanded text should stay in view instead of snapping to the final reply")
        capture("Long message reading position")
    }
    func testKeyboardKeepsLatestReplyVisible() {
        let app = launch()
        app.buttons["sidebar-task-native"].tap()
        let latest = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Use the composer to continue the conversation")).firstMatch
        let opened = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: latest)
        XCTAssertEqual(XCTWaiter.wait(for: [opened], timeout: 5), .completed)
        let input = app.textFields["chat-input"]
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            latest.exists && latest.isHittable && latest.frame.maxY <= input.frame.minY - 8
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 5), .completed, "Opening the keyboard while following must keep the latest reply visible")
        capture("Latest reply with keyboard")
    }
    func testEverySettingsScreenAndConnectionDiagnostics() {
        let app = launch()
        app.buttons["sidebar-settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        capture("14 Settings index")
        for title in ["Appearance", "Conversation", "Notifications", "Speech", "Extensions", "About", "Developer", "Connections"] {
            let row = app.buttons[title == "About" ? "About FalconDeck" : title]
            if !row.isHittable { app.swipeUp() }
            row.tap()
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
            capture("Settings \(title)")
            if title == "Connections" {
                app.buttons["Connection log"].tap()
                XCTAssertTrue(app.navigationBars["Connection log"].waitForExistence(timeout: 5))
                capture("Connection log")
                back(app, from: "Connection log")
            }
            back(app, from: title)
            app.swipeDown()
        }
    }
}
