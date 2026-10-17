import XCTest
@testable import FalconDeckNative

@MainActor final class StreamingTextTests: XCTestCase {
    func testBurstPublishesItsLatestUnicodeText() async throws {
        let display = StreamingText()
        display.update("Hello", streaming: true)
        display.update("Hello 🦅", streaming: true)
        display.update("Hello 🦅 cafe\u{301}", streaming: true)
        XCTAssertEqual(display.value, "Hello")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(display.value, "Hello 🦅 cafe\u{301}")
    }
    func testContinuousDeltasCannotPostponeTheTrailingPaint() async throws {
        let display = StreamingText()
        display.update("Start", streaming: true)
        var paints: Set<String> = [], text = "Start"
        for _ in 0..<14 {
            text += " more"
            display.update(text, streaming: true)
            try await Task.sleep(for: .milliseconds(15))
            paints.insert(display.value ?? "")
        }
        XCTAssertGreaterThan(paints.count, 2, "A continuous stream must paint before it stops")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(display.value, text)
    }
    func testCompletionFlushesImmediatelyAndCannotBeOverwrittenByATimer() async throws {
        let display = StreamingText()
        display.update("Start", streaming: true)
        display.update("Start pending", streaming: true)
        display.update("Start final answer", streaming: false)
        XCTAssertEqual(display.displayed("Start final answer", streaming: false), "Start final answer")
        XCTAssertEqual(display.value, "Start final answer")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(display.value, "Start final answer")
    }
    func testReplacementNeverShowsThePreviousMessage() async throws {
        let display = StreamingText()
        display.update("Old", streaming: true)
        display.update("Old pending text", streaming: true)
        XCTAssertEqual(display.displayed("New response", streaming: true), "New response")
        display.update("New response", streaming: true)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(display.value, "New response")
    }
    func testResetCancelsARecycledRowsOldPaint() async throws {
        let display = StreamingText()
        display.update("Old", streaming: true)
        display.update("Old pending text", streaming: true)
        display.reset()
        XCTAssertEqual(display.displayed("Fresh", streaming: true), "Fresh")
        display.update("Fresh", streaming: true)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(display.value, "Fresh")
    }
    func testRetractionToTheDisplayedValueCancelsPendingText() async throws {
        let display = StreamingText()
        display.update("Keep", streaming: true)
        display.update("Keep a discarded suffix", streaming: true)
        display.update("Keep", streaming: true)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(display.value, "Keep")
    }
}
