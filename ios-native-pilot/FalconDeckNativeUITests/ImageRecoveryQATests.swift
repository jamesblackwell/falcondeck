import XCTest

@MainActor final class ImageRecoveryQATests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    func testImageLoadsWhenRelayReturnsAndSurvivesOfflineRelaunch() {
        let app = XCUIApplication(); app.launchArguments = ["--demo", "--image-preview=reconnect"]; app.launch()
        let image = app.buttons["Preview Image.jpg"]
        XCTAssertTrue(image.waitForExistence(timeout: 8), "A stripped image must load automatically once the relay becomes ready")
        let first = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); first.name = "Image restored after relay readiness"; first.lifetime = .keepAlways; add(first)
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(image.waitForExistence(timeout: 5))
        app.terminate()
        app.launchArguments = ["--demo", "--image-preview=restore"]; app.launch()
        XCTAssertTrue(image.waitForExistence(timeout: 5), "The image must restore from disk with the computer offline")
        let restored = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); restored.name = "Image retained after offline cold relaunch"; restored.lifetime = .keepAlways; add(restored)
        image.tap()
        XCTAssertTrue(app.buttons["Save to Photos"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(image.exists)
        app.terminate()
        app.launchArguments = ["--demo", "--image-preview=cache-ready"]; app.launch()
        XCTAssertTrue(image.waitForExistence(timeout: 6), "An offline image must retry when its cache finishes restoring")
    }
}
