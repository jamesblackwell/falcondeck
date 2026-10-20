import XCTest
@testable import FalconDeckMac

final class ConversationTranscriptContentTests: XCTestCase {
    func testReasoningBodyPreservesFullThoughtWhenSummaryIsPresent() {
        let body = "The replay starts after the retained cursor.\n\nRecover a fresh snapshot before applying later events."
        let item: JSON = .object([
            "kind": .string("reasoning"), "summary": .string("Inspecting replay state"),
            "content": .string(body), "lifecycle": .string("complete")
        ])
        XCTAssertEqual(TranscriptPresentation.reasoningBody(item), body)
        XCTAssertEqual(TranscriptPresentation.reasoningBody(item.setting("content", .string("  \n"))), "Inspecting replay state")
        XCTAssertEqual(TranscriptPresentation.reasoningBody(item.setting("summary", .null)), body)
    }

    func testExpandedToolsStillSettleEarlierStreamingThoughts() {
        let thought = Message(.object([
            "id": .string("thinking"), "kind": .string("reasoning"), "lifecycle": .string("streaming")
        ]))
        let tool = Message(.object(["id": .string("read"), "kind": .string("tool_call"), "status": .string("running")]))
        let preferences: JSON = .object(["tool_details_mode": .string("expanded")])
        let groups = ConversationTranscriptGroups.groups(messages: [thought, tool], preferences: preferences)
        XCTAssertEqual(groups.map { $0.map(\.id) }, [["thinking"], ["read"]])
        XCTAssertFalse(groups[0][0].streaming)
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(groups[0][0], preferences: preferences))
        XCTAssertTrue(ConversationTranscriptGroups.groups(messages: [thought], preferences: preferences)[0][0].streaming)
        XCTAssertTrue(thought.streaming)
    }

    func testExportOmitsMCPBinaryBodiesAndKeepsTextAndMetadata() {
        let imageBytes = "PRIVATE_SCREENSHOT_BINARY_12345"
        let audioBytes = "PRIVATE_AUDIO_BINARY_12345"
        let resourceBytes = "PRIVATE_RESOURCE_BINARY_12345"
        let result: JSON = .object([
            "content": .array([
                .object(["type": .string("text"), "text": .string("Screenshot captured")]),
                .object(["type": .string("image"), "mimeType": .string("image/png"), "data": .string(imageBytes)]),
                .object(["type": .string("audio"), "mimeType": .string("audio/wav"), "data": .string(audioBytes)]),
                .object(["type": .string("resource"), "resource": .object([
                    "uri": .string("file:///tmp/report.pdf"), "mimeType": .string("application/pdf"), "blob": .string(resourceBytes)
                ])])
            ]),
            "structuredContent": .object(["data": .string("Preserve structured text")])
        ])
        let tool = Message(.object([
            "kind": .string("tool_call"), "title": .string("Capture"),
            "detail": .object(["kind": .string("mcp"), "result": result])
        ]))
        let markdown = ConversationExport.markdown([tool], title: "Task", partial: false)
        for binary in [imageBytes, audioBytes, resourceBytes] { XCTAssertFalse(markdown.contains(binary)) }
        let unescaped = markdown.replacingOccurrences(of: "\\/", with: "/")
        for retained in ["Screenshot captured", "image/png", "audio/wav", "report.pdf", "Preserve structured text"] {
            XCTAssertTrue(unescaped.contains(retained), retained)
        }
        XCTAssertTrue(markdown.contains("[Binary media retained in original conversation]"))
    }

    func testFileLinksDistinguishEncodedFilenameColonsFromLineSuffixes() {
        XCTAssertEqual(TranscriptFileLink.parse("src/a%3A12"), .init(path: "src/a:12", line: nil))
        XCTAssertEqual(TranscriptFileLink.parse("src/a%3A12:7"), .init(path: "src/a:12", line: 7))
        XCTAssertEqual(TranscriptFileLink.parse("file:///tmp/a%3A12#L9"), .init(path: "/tmp/a:12", line: 9))
        XCTAssertNil(TranscriptFileLink.parse("/%2Fremote-host/file.swift"))
        XCTAssertNil(TranscriptFileLink.parse("file:///tmp/a%00.swift"))
    }

    func testBareFilenameLineLinksAcceptQueryAndFragmentLocations() {
        XCTAssertEqual(TranscriptFileLink.parse("README.md:12?line=4"), .init(path: "./README.md", line: 4))
        XCTAssertEqual(TranscriptFileLink.parse("README.md:12:8?line=4#L6"), .init(path: "./README.md", line: 6))
    }
}
