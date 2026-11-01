import XCTest
import UIKit

/// Drives the transcript → file viewer flow against the debug "computer"
/// (`--file-preview`), which serves a host folder through the daemon's file RPCs.
@MainActor final class FileViewerQATests: XCTestCase {
    private var root: URL!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        root = URL(fileURLWithPath: "/tmp/fp-fixtures-\(UUID().uuidString.prefix(8))").resolvingSymlinksInPath()
        try? Self.writeFixtures(at: root)
    }
    override func tearDown() { try? FileManager.default.removeItem(at: root); super.tearDown() }

    private func launch(delay: Int = 0) -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--file-preview=\(root.path)"] + (delay > 0 ? ["--file-preview-delay=\(delay)"] : [])
        app.launch()
        XCTAssertTrue(app.staticTexts["The review pack is ready."].waitForExistence(timeout: 10) || app.textViews.firstMatch.waitForExistence(timeout: 2))
        return app
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    private func link(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        let predicate = NSPredicate(format: "label CONTAINS %@", text)
        let element = app.links.matching(predicate).firstMatch
        if element.waitForExistence(timeout: 5) { return element }
        return app.buttons.matching(predicate).firstMatch
    }
    private func viewer(_ app: XCUIApplication, _ id: String, timeout: TimeInterval = 12) -> XCUIElement {
        let element = app.descendants(matching: .any).matching(identifier: id).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(id) never appeared")
        return element
    }
    private func close(_ app: XCUIApplication) {
        app.buttons["file-viewer-close"].tap()
        XCTAssertTrue(app.buttons["file-viewer-close"].waitForNonExistence(timeout: 4))
    }

    func testMarkdownReportRendersWithImageAndRelativeLink() {
        let app = launch()
        capture("1 Transcript: file paths are links")
        link(app, containing: "report/index.md").tap()
        _ = viewer(app, "file-viewer-markdown")
        XCTAssertTrue(app.staticTexts["Q4 growth report"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "local-file-image").firstMatch.waitForExistence(timeout: 8), "relative image should load through the RPC")
        sleep(1)
        capture("2 Markdown report with image")
        link(app, containing: "appendix").tap()
        XCTAssertTrue(app.staticTexts["Appendix"].waitForExistence(timeout: 8))
        capture("3 Relative link pushed onto the viewer")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Q4 growth report"].waitForExistence(timeout: 4))
        close(app)
    }

    func testHtmlDashboardLoadsRelativeCssJsAndJson() {
        let app = launch()
        link(app, containing: "Q4 dashboard").tap()
        _ = viewer(app, "file-viewer-html")
        // The heading is plain HTML; the rows exist only if app.js ran and fetched data.json.
        XCTAssertTrue(app.webViews.staticTexts["Revenue by region"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.webViews.staticTexts["EMEA: 1280"].waitForExistence(timeout: 10), "script + fetch through the scheme handler")
        sleep(1)
        capture("4 HTML dashboard (relative CSS/JS/JSON)")
        close(app)
    }

    func testPdfOpensInTheNativeViewer() {
        let app = launch()
        link(app, containing: "brief.pdf").tap()
        _ = viewer(app, "file-viewer-pdf")
        sleep(2)
        capture("5 PDF")
        close(app)
    }

    func testWideScreenshotFitsWidthAndZooms() {
        let app = launch()
        app.buttons["Open Wide desktop screenshot"].tap()
        let image = viewer(app, "file-viewer-image")
        sleep(1)
        capture("6 Wide screenshot, fit to width")
        image.doubleTap()
        sleep(1)
        capture("7 Wide screenshot, zoomed")
        image.doubleTap()
        close(app)
    }

    func testDeniedFileExplainsItself() {
        let app = launch()
        link(app, containing: "Credentials").tap()
        _ = viewer(app, "file-viewer-error")
        XCTAssertTrue(app.staticTexts["This file isn't shareable from your Mac"].exists)
        XCTAssertFalse(app.buttons["file-viewer-retry"].exists)
        capture("8 Denied .env")
        close(app)
    }

    func testPathRelativeToTheProjectOpens() {
        let app = launch()
        let relative = app.links.matching(NSPredicate(format: "label == %@", "report/index.md")).firstMatch
        XCTAssertTrue(relative.waitForExistence(timeout: 5))
        relative.tap()
        _ = viewer(app, "file-viewer-markdown")
        XCTAssertTrue(app.staticTexts["Q4 growth report"].waitForExistence(timeout: 5))
        close(app)
    }

    func testBigFileShowsProgress() {
        let app = launch(delay: 350)
        link(app, containing: "export.zip").tap()
        let progress = viewer(app, "file-viewer-progress", timeout: 8)
        XCTAssertTrue(progress.exists)
        sleep(2)
        capture("9 Loading progress for a big file")
        close(app)
    }

    // MARK: Fixtures

    private static func writeFixtures(at root: URL) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: root.appending(path: "report"), withIntermediateDirectories: true)
        try manager.createDirectory(at: root.appending(path: "dashboard"), withIntermediateDirectories: true)
        try """
        # Q4 growth report

        Revenue grew **18%** quarter over quarter. The chart below is a relative image served through the same file RPC as this document.

        ![Revenue chart](chart.png)

        | Region | Q3 | Q4 |
        | --- | --- | --- |
        | EMEA | 1,090 | 1,280 |
        | AMER | 2,310 | 2,640 |

        See the [appendix](appendix.md) and the [live dashboard](../dashboard/index.html).
        """.write(to: root.appending(path: "report/index.md"), atomically: true, encoding: .utf8)
        try "# Appendix\n\nMethodology notes.\n".write(to: root.appending(path: "report/appendix.md"), atomically: true, encoding: .utf8)
        try gradient(size: CGSize(width: 1200, height: 600), title: "Revenue by region").write(to: root.appending(path: "report/chart.png"))
        try gradient(size: CGSize(width: 3000, height: 1500), title: "Desktop screenshot 3000x1500").write(to: root.appending(path: "wide.png"))
        try "SECRET=1\n".write(to: root.appending(path: ".env"), atomically: true, encoding: .utf8)
        try Data((0..<3_000_000).map { UInt8(truncatingIfNeeded: $0 &* 2654435761 >> 7) }).write(to: root.appending(path: "export.zip"))
        try """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Q4 dashboard</title><link rel="stylesheet" href="style.css"></head>
        <body><h1>Revenue by region</h1><ul id="rows"></ul><p id="status">loading…</p><script src="app.js"></script></body></html>
        """.write(to: root.appending(path: "dashboard/index.html"), atomically: true, encoding: .utf8)
        try "body{font:17px -apple-system,sans-serif;margin:24px;background:#0b1220;color:#e6edf7}h1{font-size:26px}li{padding:10px 14px;margin:8px 0;border-radius:10px;background:#16213a;list-style:none}#status{color:#7aa2ff}".write(to: root.appending(path: "dashboard/style.css"), atomically: true, encoding: .utf8)
        try """
        fetch('data.json').then(r => r.json()).then(rows => {
          document.getElementById('rows').innerHTML = rows.map(r => '<li>' + r.region + ': ' + r.revenue + '</li>').join('');
          document.getElementById('status').textContent = 'loaded ' + rows.length + ' rows by script';
        }).catch(e => { document.getElementById('status').textContent = 'fetch failed: ' + e; });
        """.write(to: root.appending(path: "dashboard/app.js"), atomically: true, encoding: .utf8)
        try #"[{"region":"EMEA","revenue":1280},{"region":"AMER","revenue":2640},{"region":"APAC","revenue":1710}]"#.write(to: root.appending(path: "dashboard/data.json"), atomically: true, encoding: .utf8)
        let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792)).pdfData { context in
            for page in 1...3 {
                context.beginPage()
                ("Quarterly brief — page \(page)" as NSString).draw(at: CGPoint(x: 54, y: 72), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 28)])
                (String(repeating: "Growth held across every region this quarter. ", count: 12) as NSString).draw(in: CGRect(x: 54, y: 130, width: 504, height: 400), withAttributes: [.font: UIFont.systemFont(ofSize: 16)])
            }
        }
        try pdf.write(to: root.appending(path: "brief.pdf"))
    }

    private static func gradient(size: CGSize, title: String) -> Data {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
            let colors = [UIColor(red: 0.1, green: 0.2, blue: 0.5, alpha: 1).cgColor, UIColor(red: 0.1, green: 0.7, blue: 0.6, alpha: 1).cgColor]
            let space = CGColorSpaceCreateDeviceRGB()
            if let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: [0, 1]) {
                context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            }
            (title as NSString).draw(at: CGPoint(x: size.width * 0.05, y: size.height * 0.05), withAttributes: [.font: UIFont.boldSystemFont(ofSize: size.height * 0.08), .foregroundColor: UIColor.white])
            for index in 0..<8 {
                UIColor.white.withAlphaComponent(0.25).setFill()
                context.fill(CGRect(x: size.width * 0.05 + CGFloat(index) * size.width * 0.11, y: size.height * 0.3, width: size.width * 0.08, height: size.height * (0.15 + 0.07 * CGFloat(index))))
            }
            ("12px caption text that only reads when zoomed to native pixels" as NSString).draw(at: CGPoint(x: size.width * 0.05, y: size.height * 0.9), withAttributes: [.font: UIFont.systemFont(ofSize: 22), .foregroundColor: UIColor.white])
        }
    }
}
