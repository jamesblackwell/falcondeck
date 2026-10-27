import XCTest
@testable import FalconDeckMac

final class ThreadLinkTests: XCTestCase {
    func testMarkdownLabelKeepsItsStableTaskDestination() {
        let text = TranscriptMarkdownInline.attributed("[Original name](falcondeck://thread/task-123)")
        XCTAssertEqual(String(text.characters), "Original name")
        let url = text.runs.first?.link
        XCTAssertEqual(url.flatMap { TranscriptThreadLink.parse($0.absoluteString) }, "task-123")
        XCTAssertEqual(TranscriptThreadLink.parse("falcondeck://thread/claude%3Atask-123"), "claude:task-123")
    }

    func testTaskLinksRejectOtherActionsAndMalformedIDs() {
        for value in ["falcondeck://thread/", "falcondeck://pair/task", "https://thread/task", "falcondeck://thread/task?delete=true", "falcondeck://thread/task#hash", "falcondeck://thread/%2E%2E", "falcondeck://thread/%2Fetc", "falcondeck://thread/%ZZ", "falcondeck://thread/task%0A123", "falcondeck://thread/task%0A"] {
            XCTAssertNil(TranscriptThreadLink.parse(value), value)
        }
    }

    func testRemoteTranscriptLinksStayOnTheirOwningComputer() {
        XCTAssertEqual(TranscriptThreadLink.targetID("task-123", sourceID: "remote:host-1:bot"), "remote:host-1:task-123")
        XCTAssertEqual(TranscriptThreadLink.targetID("task-123", sourceID: "local-bot"), "task-123")
    }
}
