import XCTest

@MainActor final class LoadingQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func launch(_ mode: String = "slow") -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launchArguments = ["--demo", "--loading-preview=\(mode)"]; app.launch()
        if !app.buttons["sidebar-settings"].isHittable, app.buttons["BackButton"].exists { app.buttons["BackButton"].tap() }
        XCTAssertTrue(app.buttons["sidebar-settings"].waitForExistence(timeout: 5))
        return app
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testConnectingShowsCachedProjectsWithAnExplicitSyncBanner() {
        let app = launch("connecting")
        let banner = app.descendants(matching: .any).matching(identifier: "session-sync-banner").firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 3))
        XCTAssertTrue(banner.label.contains("Reconnecting"))
        XCTAssertTrue(banner.label.contains("saved projects"))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "session-sync-banner").count, 1, "A visible sidebar already provides the iPad connection banner")
        XCTAssertTrue(app.buttons["project-falcondeck"].isHittable)
        XCTAssertFalse(app.buttons["sidebar-new-chat"].isEnabled)
        capture("Cached sidebar stays readable while reconnecting")
    }
    func testColdSidebarHasVisibleLoadingFeedback() {
        let app = launch("empty")
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "session-sync-banner").firstMatch.waitForExistence(timeout: 3))
        let loading = app.descendants(matching: .any).matching(identifier: "sidebar-loading").firstMatch
        XCTAssertTrue(loading.waitForExistence(timeout: 3))
        XCTAssertTrue(loading.isHittable)
        capture("Cold sidebar has centered task loading state")
    }
    func testCachedConversationRemainsReadableDuringRefresh() {
        let app = launch("cached")
        app.buttons["sidebar-task-native"].tap()
        let answer = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Use the composer to continue the conversation'")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 2))
        let pill = app.descendants(matching: .any).matching(identifier: "loading-pill").firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 2))
        XCTAssertFalse(app.otherElements["conversation-loading"].exists)
        capture("Cached conversation refreshes behind a floating loading pill")
        XCTAssertTrue(pill.waitForNonExistence(timeout: 10))
        XCTAssertTrue(answer.exists)
    }
    func testUnloadedChatsAutomaticallyLoadAsOneFlatSection() {
        let app = launch()
        app.buttons["sidebar-section-projects"].tap()
        let first = app.buttons["sidebar-task-task-chat-0"]
        XCTAssertTrue(first.waitForExistence(timeout: 8), "Opening Chats must request unloaded casual workspaces")
        XCTAssertLessThanOrEqual(app.buttons.matching(NSPredicate(format: "label == 'Show more'")).count, 1)
        XCTAssertTrue(app.buttons["sidebar-task-task-chat-4"].waitForExistence(timeout: 5))
        let visible = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'sidebar-task-task-chat-'"))
            .allElementsBoundByIndex.filter(\.isHittable).sorted { $0.frame.minY < $1.frame.minY }
        XCTAssertGreaterThanOrEqual(visible.count, 3)
        for (previous, next) in zip(visible, visible.dropFirst()) {
            XCTAssertLessThanOrEqual(next.frame.minY - previous.frame.minY, 48, "Async inserts must not leave estimated-height gaps")
        }
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'CancellationError'")).firstMatch.exists)
        capture("Chats loaded from twelve casual workspaces")
    }
    func testFolderTapsRespondWhileTheSavedStateIsStillInFlight() {
        let app = launch()
        let folder = app.buttons["sidebar-folder-native-folder"]
        XCTAssertTrue(folder.waitForExistence(timeout: 5))
        folder.tap()
        XCTAssertEqual(folder.value as? String, "Collapsed")
        folder.tap()
        XCTAssertEqual(folder.value as? String, "Expanded")
        let child = app.buttons["sidebar-task-review"]
        XCTAssertTrue(child.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(child.frame.height, 48)
        capture("Folder reopened while preference save was pending")
        folder.tap()
        XCTAssertEqual(folder.value as? String, "Collapsed")
    }
    func testSlowHistoryKeepsALoadingStateVisibleAboveComposer() {
        let app = launch()
        app.buttons["sidebar-task-native"].tap()
        let loading = app.otherElements["conversation-loading"]
        XCTAssertTrue(loading.waitForExistence(timeout: 2))
        XCTAssertTrue(loading.isHittable)
        XCTAssertLessThan(loading.frame.maxY, app.textFields["chat-input"].frame.minY)
        capture("Conversation loading visible above composer")
        XCTAssertTrue(loading.waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Use the composer to continue the conversation'")).firstMatch.waitForExistence(timeout: 5))
        capture("Slow conversation loaded at latest response")
    }
    func testHistoryFailureShowsRetryAndRecovers() {
        let app = launch("retry")
        app.buttons["sidebar-task-native"].tap()
        let retry = app.buttons["conversation-retry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        XCTAssertTrue(retry.isHittable)
        XCTAssertTrue(app.buttons["stop-task"].exists, "A running task must still show its failed history load and retry")
        XCTAssertFalse(app.staticTexts["No messages yet"].exists)
        capture("Conversation failure has a visible retry")
        retry.tap()
        XCTAssertTrue(app.otherElements["conversation-loading"].waitForExistence(timeout: 2))
        XCTAssertTrue(retry.waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Use the composer to continue the conversation'")).firstMatch.waitForExistence(timeout: 10))
        app.buttons["task-menu"].tap()
        XCTAssertTrue(app.buttons["Mark unread"].waitForExistence(timeout: 5), "A successful retry must acknowledge the visible conversation")
    }
    func testReopeningAnInFlightConversationLoadsAndAcknowledgesIt() {
        let app = launch()
        app.buttons["sidebar-task-native"].tap()
        XCTAssertTrue(app.otherElements["conversation-loading"].waitForExistence(timeout: 2))
        if app.buttons["BackButton"].isHittable { app.buttons["BackButton"].tap() }
        else { app.buttons["Activity"].tap() }
        app.buttons["sidebar-task-native"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Use the composer to continue the conversation'")).firstMatch.waitForExistence(timeout: 10))
        app.buttons["task-menu"].tap()
        XCTAssertTrue(app.buttons["Mark unread"].waitForExistence(timeout: 5), "A shared history load must acknowledge the currently visible conversation")
    }
}
