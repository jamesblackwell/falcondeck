import XCTest
@testable import FalconDeckNative

@MainActor final class StreamingTextTests: XCTestCase {
    func testBurstPublishesItsLatestUnicodeText() async throws {
        let display = StreamingText()
        display.update("Hello", streaming: true)
        display.update("Hello 🦅", streaming: true)
        display.update("Hello 🦅 cafe\u{301}", streaming: true)
        XCTAssertEqual(display.value, "Hello")
        let final = "Hello 🦅 cafe\u{301}"
        for _ in 0..<40 where display.value != final {
            XCTAssertTrue(final.hasPrefix(display.value ?? ""), "A paced reveal only ever shows a prefix, never a split character")
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(display.value, final)
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
        try await Task.sleep(for: .milliseconds(500))
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
    func testABurstIsSpreadOverSeveralFramesAndNeverOutrunsTheWire() async throws {
        let display = StreamingText()
        display.update("Go", streaming: true)
        let burst = "Go " + String(repeating: "steady words ", count: 6)
        display.update(burst, streaming: true)
        var lengths: [Int] = [], started = ContinuousClock.now
        while display.value != burst, ContinuousClock.now - started < .seconds(2) {
            lengths.append(display.value?.utf16.count ?? 0)
            XCTAssertTrue(burst.hasPrefix(display.value ?? ""))
            try await Task.sleep(for: .milliseconds(8))
        }
        XCTAssertEqual(display.value, burst)
        XCTAssertGreaterThan(Set(lengths).count, 4, "One burst must not land as a single step")
        XCTAssertLessThan(ContinuousClock.now - started, .milliseconds(900), "The paced tail must not trail the wire for long")
    }
    func testReduceMotionPaintsEveryDeltaImmediately() {
        let display = StreamingText()
        display.update("One", streaming: true, paced: false)
        display.update("One two three", streaming: true, paced: false)
        XCTAssertEqual(display.value, "One two three")
    }
    func testNewDeltasWhileDrainingExtendTheSameReveal() async throws {
        let display = StreamingText()
        display.update("A", streaming: true)
        display.update("A quick brown fox", streaming: true)
        try await Task.sleep(for: .milliseconds(30))
        display.update("A quick brown fox jumps over the lazy dog", streaming: true)
        XCTAssertTrue("A quick brown fox jumps over the lazy dog".hasPrefix(display.value ?? ""))
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(display.value, "A quick brown fox jumps over the lazy dog")
    }
    func testCompletionWhileDrainingShowsTheFinalTextAtOnce() {
        let display = StreamingText()
        display.update("Start", streaming: true)
        display.update("Start " + String(repeating: "tail ", count: 40), streaming: true)
        let final = "Start " + String(repeating: "tail ", count: 40) + "end"
        display.update(final, streaming: false)
        XCTAssertEqual(display.value, final)
    }
}
