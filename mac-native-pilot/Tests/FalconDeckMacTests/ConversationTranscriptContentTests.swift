import XCTest
@testable import FalconDeckMac

final class ConversationTranscriptContentTests: XCTestCase {
    func testEmptyAndSummaryOnlyThoughtsAreLabelsInEveryThinkingMode() {
        for content: JSON in [.null, .string(""), .string(" \n ")] {
            let thought = Message(.object([
                "id": .string("thought"), "kind": .string("reasoning"),
                "summary": .string("Checking the result"), "content": content,
                "duration_ms": .number(2), "lifecycle": .string("complete")
            ]))
            XCTAssertFalse(TranscriptPresentation.hasReasoningBody(thought.raw))
            // A sub-second thought reports no useful elapsed time.
            XCTAssertEqual(TranscriptPresentation.reasoningTitle(thought), "Checking the result")
            XCTAssertEqual(TranscriptPresentation.reasoningTitle(Message(thought.raw.setting("duration_ms", .number(4200)))),
                           "Checking the result · 4.2 s")
            for mode in ["auto", "preview", "always_expanded", "always_collapsed"] {
                XCTAssertFalse(TranscriptPresentation.defaultExpanded(thought, preferences: .object(["thinking_display": .string(mode)])))
                let tools = [tool("before"), thought, tool("after")]
                XCTAssertEqual(ConversationTranscriptGroups.groups(messages: tools, preferences: .null, thinkingDisplay: mode).map { $0.map(\.id) }, [["before", "thought", "after"]])
            }
        }
        let empty = Message(.object(["kind": .string("reasoning")]))
        XCTAssertEqual(TranscriptPresentation.reasoningTitle(empty), "Thought")
        XCTAssertEqual(TranscriptPresentation.reasoningTitle(Message(empty.raw.setting("lifecycle", .string("interrupted")))), "Thought interrupted")
        XCTAssertEqual(TranscriptPresentation.reasoningTitle(Message(empty.raw.setting("lifecycle", .string("error")))), "Thought failed")
        XCTAssertEqual(TranscriptPresentation.reasoningTitle(Message(empty.raw.setting("lifecycle", .string("streaming")).setting("duration_ms", .number(2)))), "Thinking…")
    }

    func testBareThoughtsAreDroppedOnlyWhenTheyWouldStandAlone() {
        let bare = Message(.object(["id": .string("thought"), "kind": .string("reasoning"), "lifecycle": .string("complete")]))
        let reply = Message(.object(["id": .string("reply"), "kind": .string("assistant_message")]))
        func ids(_ messages: [Message], _ preferences: JSON) -> [[String]] {
            ConversationTranscriptGroups.groups(messages: messages, preferences: preferences).map { $0.map(\.id) }
        }
        // Nothing to read and nothing to open: the row carries no information.
        XCTAssertEqual(ids([reply, bare], .null), [["reply"]])
        // Unless it is the whole transcript: an empty one would look like loss.
        XCTAssertEqual(ids([bare], .null), [["thought"]])
        // Folded into real work, or shown verbatim on request, it stays.
        XCTAssertEqual(ids([tool("before"), bare, tool("after")], .null), [["before", "thought", "after"]])
        XCTAssertEqual(ids([reply, bare], .object(["tool_details_mode": .string("expanded")])), [["reply"], ["thought"]])
        // An interrupted or failed thought still says something.
        for lifecycle in ["interrupted", "error"] {
            XCTAssertEqual(ids([reply, Message(bare.raw.setting("lifecycle", .string(lifecycle)))], .null), [["reply"], ["thought"]])
        }
        // So does one with a summary, or one with a retained body.
        XCTAssertEqual(ids([reply, Message(bare.raw.setting("summary", .string("Weighing two fixes")))], .null), [["reply"], ["thought"]])
        XCTAssertEqual(ids([reply, Message(bare.raw.setting("content", .string("Two options.")))], .null), [["reply"], ["thought"]])
    }

    func testProgressUpdatesStayVisibleBetweenCollapsedWorkAndFinalAnswer() {
        let progress = Message(.object([
            "id": .string("progress"), "kind": .string("assistant_message"),
            "phase": .string("commentary"), "text": .string("The **build passed**. I’m checking the result."),
            "lifecycle": .string("streaming")
        ]))
        let answer = Message(progress.raw.setting("id", .string("answer")).setting("phase", .string("final_answer")))
        var transcript = Transcript(items: [tool("read")])
        transcript.apply(.object(["type": .string("conversation-item-added"), "item": progress.raw]))
        transcript.apply(.object([
            "type": .string("text"), "item_id": .string("progress"),
            "target": .string("assistant_text"), "delta": .string(" Next check.")
        ]))
        transcript.upsert(tool("check")); transcript.upsert(answer)
        XCTAssertTrue(TranscriptPresentation.isProgressUpdate(transcript.items[1]))
        XCTAssertFalse(TranscriptPresentation.isProgressUpdate(answer))
        for mode in ["collapsed", "expanded", "auto", "compact", "hide_read_only_details"] {
            let groups = ConversationTranscriptGroups.groups(messages: transcript.items, preferences: .object(["tool_details_mode": .string(mode)]))
            XCTAssertEqual(groups.map { $0.map(\.id) }, [["read"], ["progress"], ["check"], ["answer"]])
            XCTAssertEqual(groups[1][0].text, progress.text + " Next check.")
        }
    }

    func testOneRoutineToolUsesWorkFoldButHighSignalItemsStayVisible() {
        XCTAssertTrue(ConversationTranscriptGroups.isActivityGroup([tool("read")], preferences: .null))
        XCTAssertFalse(ConversationTranscriptGroups.isActivityGroup([tool("read")], preferences: .object(["tool_details_mode": .string("expanded")])))
        for display: JSON in [
            .object(["artifact_kind": .string("diff")]),
            .object(["artifact_kind": .string("approval_related")]),
            .object(["provider_output_summary": .object(["images": .number(1)])])
        ] {
            XCTAssertFalse(ConversationTranscriptGroups.isActivityGroup([Message(tool("signal").raw.setting("display", display))], preferences: .null))
        }
        let trailing = Message(.object(["id": .string("thought"), "kind": .string("reasoning"), "lifecycle": .string("streaming")]))
        let groups = ConversationTranscriptGroups.groups(messages: [trailing], preferences: .null, isStreaming: false)
        XCTAssertFalse(groups[0][0].streaming)
        XCTAssertTrue(trailing.streaming)
        XCTAssertEqual(ConversationTranscriptGroups.title(for: [tool("read")], running: true), "Working…")
        XCTAssertEqual(ConversationTranscriptGroups.title(for: [tool("read"), trailing], running: true), "Thinking…")
    }

    func testProgressAfterRunningWorkDoesNotMarkThatWorkComplete() {
        let active = Message(tool("read").raw.setting("status", .string("running")))
        let progress = Message(.object([
            "id": .string("progress"), "kind": .string("assistant_message"),
            "phase": .string("commentary"), "text": .string("The check is still running.")
        ]))
        let groups = ConversationTranscriptGroups.groups(messages: [active, progress], preferences: .null)
        XCTAssertEqual(groups.map { $0.map(\.id) }, [["read"], ["progress"]])
        XCTAssertTrue(ConversationTranscriptGroups.isRunning(groups[0], keepAlive: false))
        XCTAssertEqual(ConversationTranscriptGroups.title(for: groups[0], running: false), "Working…")
        let thought = Message(.object(["id": .string("thought"), "kind": .string("reasoning")]))
        XCTAssertEqual(ConversationTranscriptGroups.title(for: [active, thought], running: true), "Working…")
        XCTAssertFalse(ConversationTranscriptGroups.isRunning([tool("complete")]))
        XCTAssertTrue(ConversationTranscriptGroups.isRunning([tool("complete")], keepAlive: true))
    }

    func testCompletedToolOutputDoesNotHideTheContinuingTurnIndicator() {
        var transcript = Transcript(items: [Message(tool("check").raw.setting("status", .string("running")))])
        XCTAssertTrue(TranscriptPresentation.hasActivityIndicator(transcript.items[0]))
        transcript.apply(.object([
            "type": .string("text"), "target": .string("tool_output"),
            "item_id": .string("check"), "delta": .string("Checks passed")
        ]))
        transcript.apply(.object([
            "type": .string("tool-call-end"), "item_id": .string("check"), "status": .string("completed"), "exit_code": .number(0)
        ]))
        XCTAssertTrue(transcript.items[0].streaming, "Output lifecycle can trail the terminal command status.")
        XCTAssertFalse(TranscriptPresentation.hasActivityIndicator(transcript.items[0]))
        for kind in ["assistant_message", "code_review", "reasoning"] {
            XCTAssertTrue(TranscriptPresentation.hasActivityIndicator(Message(.object([
                "kind": .string(kind), "lifecycle": .string("streaming")
            ]))))
        }
        XCTAssertFalse(TranscriptPresentation.hasActivityIndicator(Message(.object(["kind": .string("image"), "lifecycle": .string("streaming")]))))
    }

    func testFoldedToolTitleMatchesTheSameSearchThatRevealsItsGroup() {
        let command = Message(tool("check").raw.setting("title", .string("Run the Markdown regression suite"))
            .setting("output", .string("45 checks passed.")))
        let groups = ConversationTranscriptGroups.groups(messages: [command], preferences: .null)
        XCTAssertTrue(ConversationTranscriptGroups.isActivityGroup(groups[0], preferences: .null))
        XCTAssertFalse(command.text.localizedCaseInsensitiveContains("markdown"))
        for query in ["markdown", "CHECKS PASSED"] {
            XCTAssertTrue(TranscriptPresentation.matchesSearch(command, query: query))
            XCTAssertTrue(groups[0].contains { TranscriptPresentation.matchesSearch($0, query: query) })
        }
        XCTAssertFalse(TranscriptPresentation.matchesSearch(command, query: "missing"))
        XCTAssertFalse(TranscriptPresentation.matchesSearch(command, query: ""))
    }

    func testReasoningBodyPreservesFullThoughtWhenSummaryIsPresent() {
        let body = "The replay starts after the retained cursor.\n\nRecover a fresh snapshot before applying later events."
        let item: JSON = .object([
            "kind": .string("reasoning"), "summary": .string("Inspecting replay state"),
            "content": .string(body), "lifecycle": .string("complete")
        ])
        XCTAssertEqual(TranscriptPresentation.reasoningBody(item), body)
        XCTAssertFalse(TranscriptPresentation.hasReasoningBody(item.setting("content", .string("  \n"))))
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

    private func tool(_ id: String) -> Message {
        Message(.object(["id": .string(id), "kind": .string("tool_call"), "status": .string("completed")]))
    }
}
