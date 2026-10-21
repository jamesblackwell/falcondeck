import XCTest
@testable import FalconDeckMac

final class NativePlainTextTests: XCTestCase {
    func testStripsInlineMarkdownPunctuation() {
        XCTAssertEqual(NativePlainText.line("**296 of 303 items are complete.** The tutor photo limits are tested."),
                       "296 of 303 items are complete. The tutor photo limits are tested.")
        XCTAssertEqual(NativePlainText.line("Both servers run `b14f54112e`, which includes the fix."),
                       "Both servers run b14f54112e, which includes the fix.")
        XCTAssertEqual(NativePlainText.line("__Shipped__ today"), "Shipped today")
    }

    func testDropsLeadingBlockMarkersButKeepsMidLinePunctuation() {
        XCTAssertEqual(NativePlainText.line("# Release notes\n- first\n- second"), "Release notes first second")
        XCTAssertEqual(NativePlainText.line("> quoted line"), "quoted line")
        XCTAssertEqual(NativePlainText.line("rolled back 2024-03-01 to 2024-03-02"), "rolled back 2024-03-01 to 2024-03-02")
        XCTAssertEqual(NativePlainText.line("a-b c+d"), "a-b c+d")
    }

    func testCollapsesWhitespaceAndNewlines() {
        XCTAssertEqual(NativePlainText.line("one\n\n  two\t\tthree  "), "one two three")
        XCTAssertEqual(NativePlainText.line(""), "")
        XCTAssertEqual(NativePlainText.line("   "), "")
    }

    func testDropsSchedulerEnvelope() {
        let text = "<falcondeck_automation>\nRun the nightly check.\n</falcondeck_automation>\nNothing needed attention."
        XCTAssertEqual(NativePlainText.line(text), "Nothing needed attention.")
    }

    func testUnterminatedEnvelopeKeepsOnlyTheTextBeforeIt() {
        XCTAssertEqual(NativePlainText.line("Heads up. <falcondeck_automation>truncated"), "Heads up.")
    }

    func testHonoursTheLengthLimit() {
        let long = String(repeating: "ab ", count: 500)
        XCTAssertEqual(NativePlainText.line(long, limit: 10).count, 10)
    }
}

@MainActor final class NativeDatesTests: XCTestCase {
    func testShortRelativeReadsAsSettledAge() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(NativeDates.shortRelative(now.addingTimeInterval(-5), now: now), "now")
        XCTAssertEqual(NativeDates.shortRelative(now.addingTimeInterval(-90), now: now), "1m")
        XCTAssertEqual(NativeDates.shortRelative(now.addingTimeInterval(-3 * 3600), now: now), "3h")
        XCTAssertEqual(NativeDates.shortRelative(now.addingTimeInterval(-50 * 3600), now: now), "2d")
        XCTAssertEqual(NativeDates.shortRelative(now.addingTimeInterval(-30 * 86_400), now: now), "4w")
    }

    func testFutureTimestampsDoNotReadAsNegativeAges() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(NativeDates.shortRelative(now.addingTimeInterval(120), now: now), "now")
    }

    func testParsesBothDaemonTimestampShapesAndCaches() {
        let fractional = NativeDates.parse("2026-10-21T06:30:00.123Z")
        let standard = NativeDates.parse("2026-10-21T06:30:00Z")
        XCTAssertNotNil(fractional)
        XCTAssertNotNil(standard)
        XCTAssertEqual(NativeDates.parse("2026-10-21T06:30:00Z"), standard)
        XCTAssertNil(NativeDates.parse(""))
        XCTAssertNil(NativeDates.parse("not a date"))
    }
}
