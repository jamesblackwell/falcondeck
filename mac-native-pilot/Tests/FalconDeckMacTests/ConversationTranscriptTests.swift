import XCTest
@testable import FalconDeckMac

final class ConversationTranscriptTests: XCTestCase {
    func testFenceLengthAndMarkerMustMatch() {
        let source = "````swift\nlet text = \"```\"\n```\n~~~\n````\nDone"
        XCTAssertEqual(TranscriptMarkdownParser.parse(source), [
            .code(language: "swift", text: "let text = \"```\"\n```\n~~~"),
            .paragraph("Done")
        ])
    }

    func testFenceWithTrailingCodeDoesNotCloseAndUnfinishedFenceStreamsAsCode() {
        XCTAssertEqual(TranscriptMarkdownParser.parse("```js\nconst value = 1\n```still code\nnext"), [
            .code(language: "js", text: "const value = 1\n```still code\nnext")
        ])
        XCTAssertEqual(TranscriptMarkdownParser.parse("  ~~~sh\n  echo hello\n ~~~~"), [.code(language: "sh", text: "echo hello")])
    }

    func testNestedTaskAndOrderedListsKeepTheirStructure() {
        let source = "3. Parent\n   - [x] Finished **work**\n   - [ ] Pending\n     1. Nested\n4. Next"
        XCTAssertEqual(TranscriptMarkdownParser.parse(source), [
            .list(ordered: true, start: 3, items: [
                .init(checked: nil, blocks: [
                    .paragraph("Parent"),
                    .list(ordered: false, start: 1, items: [
                        .init(checked: true, blocks: [.paragraph("Finished **work**")]),
                        .init(checked: false, blocks: [
                            .paragraph("Pending"),
                            .list(ordered: true, start: 1, items: [.init(checked: nil, blocks: [.paragraph("Nested")])])
                        ])
                    ])
                ]),
                .init(checked: nil, blocks: [.paragraph("Next")])
            ])
        ])
    }

    func testListParagraphsAndCodeKeepItemIndentation() {
        XCTAssertEqual(TranscriptMarkdownParser.parse("- Task\n\n  More detail\n\n  ```swift\n  let x = 1\n  ```\n\nAfter"), [
            .list(ordered: false, start: 1, items: [.init(checked: nil, blocks: [
                .paragraph("Task"), .paragraph("More detail"), .code(language: "swift", text: "let x = 1")
            ])]),
            .paragraph("After")
        ])
    }

    func testTablesPreserveEscapedAndCodePipesAndPadShortRows() {
        let source = "| Name | Value |\n| :--- | ---: |\n| a \\| b | `x | y` |\n| short |\n\nAfter"
        XCTAssertEqual(TranscriptMarkdownParser.parse(source), [
            .table(headers: ["Name", "Value"], alignments: [.leading, .trailing], rows: [["a \\| b", "`x | y`"], ["short", ""]]),
            .paragraph("After")
        ])
        XCTAssertNil(TranscriptMarkdownParser.tableCells("a \\| b"))
    }

    func testHeadingsQuotesRulesAndImagesAreDistinctBlocks() {
        XCTAssertEqual(TranscriptMarkdownParser.parse("# Title ###\n\nSubheading\n---\n\n> Quoted\n>\n> - Point\n\n***\n\n![A chart](https://example.com/chart.png)"), [
            .heading(level: 1, text: "Title"),
            .heading(level: 2, text: "Subheading"),
            .quote([.paragraph("Quoted"), .list(ordered: false, start: 1, items: [.init(checked: nil, blocks: [.paragraph("Point")])])]),
            .rule,
            .image(alt: "A chart", destination: "https://example.com/chart.png")
        ])
    }

    func testPlainTextDoesNotLoseUnicodeOrLineBreaks() {
        XCTAssertEqual(TranscriptMarkdownParser.parse("Hello 🦅\r\nSecond **line**\r\n\r\nNext"), [.paragraph("Hello 🦅\nSecond **line**"), .paragraph("Next")])
        XCTAssertEqual(TranscriptMarkdownParser.parse("#not a heading\n1234567890. ordinary text"), [.paragraph("#not a heading\n1234567890. ordinary text")])
    }

    func testExcessiveQuoteNestingFallsBackToLiteralText() {
        var blocks = TranscriptMarkdownParser.parse(String(repeating: "> ", count: 1_000) + "Deep content")
        var depth = 0
        while case .quote(let children) = blocks.first {
            blocks = children
            depth += 1
        }
        XCTAssertEqual(depth, 32)
        XCTAssertEqual(blocks, [.paragraph(String(repeating: "> ", count: 968) + "Deep content")])
    }

    @MainActor func testSyntaxHighlightNeverChangesCodeContents() {
        for (language, text) in [("swift", "let bird = \"🦅\" // comment\nprint(bird)"), ("diff", "--- old\n+++ new\n@@ -1 +1 @@\n- old 🦅\n+ new 🦅\n"), ("json", "{\"value\": 42, \"ok\": true}")] {
            XCTAssertEqual(String(TranscriptSyntaxHighlight.attributed(text, language: language).characters), text)
        }
    }

    func testReasoningExpansionRespectsExplicitPreferences() {
        let streaming = Message(.object(["kind": .string("reasoning"), "lifecycle": .string("streaming"), "content": .string("Checking the result.")]))
        let completed = Message(streaming.raw.setting("lifecycle", .string("complete")))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(streaming, preferences: .null))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(completed, preferences: .null))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(streaming, preferences: .object(["thinking_display": .string("always_collapsed")])))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(streaming, preferences: .object(["thinking_display": .string("preview")])))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(completed, preferences: .object(["thinking_display": .string("always_expanded")])))
    }

    func testToolErrorsExpandUnlessPreferenceSuppressesDetails() {
        let failure = Message(.object(["kind": .string("tool_call"), "status": .string("failed")]))
        XCTAssertEqual(TranscriptPresentation.toolMode(.null), "collapsed")
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(failure, preferences: .null))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(failure, preferences: .object(["tool_details_mode": .string("auto")])))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(failure, preferences: .object(["tool_details_mode": .string("collapsed")])))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(failure, preferences: .object(["tool_details_mode": .string("auto"), "auto_expand": .object(["errors": .bool(false)])])))
        let running = Message(failure.raw.setting("status", .string("running")))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(running, preferences: .null))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(running, preferences: .object(["tool_details_mode": .string("expanded")])))
    }

    func testConversationPreferencesAcceptRootOrConversationSection() {
        let preferences: JSON = .object([
            "tool_details_mode": .string("auto"), "thinking_display": .string("always_expanded"),
            "group_read_only_tools": .bool(false), "show_expand_all_controls": .bool(false),
            "auto_expand": .object(["errors": .bool(false)])
        ])
        let root: JSON = .object(["conversation": preferences, "tool_details_mode": .string("expanded")])
        XCTAssertEqual(TranscriptPresentation.conversationPreferences(root), preferences)
        XCTAssertEqual(TranscriptPresentation.conversationPreferences(preferences), preferences)
        XCTAssertEqual(TranscriptPresentation.toolMode(root), "auto")
        XCTAssertFalse(TranscriptPresentation.flag("group_read_only_tools", preferences: root))
        XCTAssertFalse(TranscriptPresentation.autoExpand("errors", preferences: root))
        XCTAssertTrue(TranscriptPresentation.autoExpand("failed_tests", preferences: root))
        XCTAssertFalse(ConversationTranscriptGroups.showsExpansionControls(preferences: root))
        XCTAssertTrue(ConversationTranscriptGroups.showsExpansionControls(preferences: .null))
        let reasoning = Message(.object(["kind": .string("reasoning"), "lifecycle": .string("complete"), "content": .string("Checking the result.")]))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(reasoning, preferences: root))
    }

    func testAutoGroupingOnlyCombinesReadOnlyToolsWithoutSideEffects() {
        let messages = [
            tool("a", readOnly: true), tool("b", readOnly: true),
            tool("write", readOnly: true, sideEffect: true),
            tool("c", readOnly: true), tool("d", readOnly: true),
            Message(.object(["id": .string("reply"), "kind": .string("assistant_message")]))
        ]
        let preferences: JSON = .object(["tool_details_mode": .string("auto")])
        XCTAssertEqual(groupIDs(messages, preferences: preferences), [["a", "b"], ["write"], ["c", "d"], ["reply"]])
        XCTAssertFalse(TranscriptPresentation.isReadOnly(messages[2].raw))
        let summaryOnly = tool("summary", display: ["history_mode": .string("summary")])
        XCTAssertTrue(TranscriptPresentation.isReadOnly(summaryOnly.raw))
        XCTAssertEqual(ConversationTranscriptGroups.title(for: Array(messages.prefix(2))), "Explored · 2 steps")
        XCTAssertEqual(ConversationTranscriptGroups.title(for: [messages[2]]), "Worked · 1 step")
    }

    func testExpandedToolsStaySingletonAndCollapsedToolsFoldContiguously() {
        let messages = [
            tool("a"), Message(.object(["id": .string("thinking"), "kind": .string("reasoning")])), tool("b"),
            Message(.object(["id": .string("reply"), "kind": .string("assistant_message")])),
            tool("c"), tool("d")
        ]
        XCTAssertEqual(groupIDs(messages, preferences: .object(["tool_details_mode": .string("expanded")])), messages.map { [$0.id] })
        XCTAssertEqual(groupIDs(messages, preferences: .object(["tool_details_mode": .string("collapsed")])), [["a", "thinking", "b"], ["reply"], ["c", "d"]])
        XCTAssertEqual(groupIDs(messages, preferences: .null), [["a", "thinking", "b"], ["reply"], ["c", "d"]])
    }

    func testLocalThinkingPreferenceControlsReasoningGroupsAndSettlesOldStreaming() {
        let reasoning = Message(.object(["id": .string("thinking"), "kind": .string("reasoning"), "lifecycle": .string("complete"), "content": .string("Checking the result.")]))
        let messages = [tool("before"), reasoning]
        let preferences: JSON = .object(["conversation": .object(["tool_details_mode": .string("collapsed"), "thinking_display": .string("always_expanded")])])
        for local in ["always_expanded", "preview"] {
            XCTAssertEqual(ConversationTranscriptGroups.groups(messages: messages, preferences: preferences, thinkingDisplay: local).map { $0.map(\.id) }, [["before"], ["thinking"]])
        }
        for local in ["auto", "always_collapsed"] {
            XCTAssertEqual(ConversationTranscriptGroups.groups(messages: messages, preferences: preferences, thinkingDisplay: local).map { $0.map(\.id) }, [["before", "thinking"]])
        }
        let streaming = Message(reasoning.raw.setting("lifecycle", .string("streaming")))
        XCTAssertEqual(ConversationTranscriptGroups.groups(messages: [tool("before"), streaming], preferences: preferences, thinkingDisplay: "auto").map { $0.map(\.id) }, [["before"], ["thinking"]])
        let oldStreaming = [tool("before"), streaming, tool("after")]
        let groups = ConversationTranscriptGroups.groups(messages: oldStreaming, preferences: preferences, thinkingDisplay: "auto")
        XCTAssertEqual(groups.map { $0.map(\.id) }, [["before", "thinking", "after"]])
        XCTAssertEqual(groups[0][1].raw["lifecycle"].string, "complete")
        XCTAssertEqual(oldStreaming[1].raw["lifecycle"].string, "streaming")
    }

    func testAutoGroupingRespectsDisabledPreference() {
        let messages = [tool("a", readOnly: true), tool("b", readOnly: true)]
        let preferences: JSON = .object(["conversation": .object(["tool_details_mode": .string("auto"), "group_read_only_tools": .bool(false)])])
        XCTAssertEqual(groupIDs(messages, preferences: preferences), [["a"], ["b"]])
        XCTAssertEqual(groupIDs(messages, preferences: .object(["tool_details_mode": .string("collapsed"), "group_read_only_tools": .bool(false)])), [["a", "b"]])
    }

    func testApprovalsDiffsAndMediaEscapeToolGroups() {
        let approval = tool("approval", readOnly: true, display: ["artifact_kind": .string("approval_related")])
        let diff = tool("diff", readOnly: true, display: ["artifact_kind": .string("diff")])
        let media = tool("media", readOnly: true, display: ["provider_output_summary": .object(["images": .number(1)])])
        let messages = [tool("a", readOnly: true), tool("b", readOnly: true), approval, tool("c", readOnly: true), tool("d", readOnly: true), diff, tool("e", readOnly: true), tool("f", readOnly: true), media]
        let expected = [["a", "b"], ["approval"], ["c", "d"], ["diff"], ["e", "f"], ["media"]]
        for mode in ["auto", "collapsed"] {
            XCTAssertEqual(groupIDs(messages, preferences: .object(["tool_details_mode": .string(mode)])), expected)
        }
        let suppressed: JSON = .object(["tool_details_mode": .string("collapsed"), "auto_expand": .object(["approvals": .bool(false), "first_diff": .bool(false)])])
        XCTAssertEqual(groupIDs(messages, preferences: suppressed), [["a", "b", "approval", "c", "d"], ["diff"], ["e", "f"], ["media"]])
    }

    func testCollapsedModeSurfacesHighSignalButKeepsRoutineFailuresFolded() {
        let ordinaryFailure = tool("error").raw.setting("status", .string("failed"))
        let failedTests = tool("test", display: ["test_summary": .object(["failed": .number(1)])])
        let approval = tool("approval", display: ["artifact_kind": .string("approval_related")])
        let firstDiff = tool("first-diff", display: ["artifact_kind": .string("diff")])
        let secondDiff = tool("second-diff", display: ["artifact_kind": .string("diff")])
        let media = tool("image", display: ["provider_output_summary": .object(["images": .number(1)])])
        let preferences: JSON = .object(["tool_details_mode": .string("collapsed")])
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(Message(ordinaryFailure), preferences: preferences))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(failedTests, preferences: preferences))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(approval, preferences: preferences))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(media, preferences: preferences))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(firstDiff, preferences: preferences, firstDiff: true))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(secondDiff, preferences: preferences, firstDiff: false))
        let messages = [tool("a"), Message(ordinaryFailure), failedTests, approval, firstDiff, tool("b"), secondDiff, media]
        XCTAssertEqual(groupIDs(messages, preferences: preferences), [["a", "error"], ["test"], ["approval"], ["first-diff"], ["b"], ["second-diff"], ["image"]])
        let suppressed = preferences.setting("auto_expand", .object(["approvals": .bool(false), "failed_tests": .bool(false), "first_diff": .bool(false)]))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(failedTests, preferences: suppressed))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(approval, preferences: suppressed))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(firstDiff, preferences: suppressed, firstDiff: true))
        XCTAssertEqual(groupIDs(messages, preferences: suppressed), [["a", "error", "test", "approval"], ["first-diff"], ["b"], ["second-diff"], ["image"]])
    }

    func testFirstDiffExpansionUsesExplicitFirstDiffAndPreference() {
        let diff = Message(.object(["id": .string("first"), "kind": .string("diff")]))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(diff, preferences: .null))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(diff, preferences: .null, firstDiff: true))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(diff, preferences: .object(["auto_expand": .object(["first_diff": .bool(false)])]), firstDiff: true))
        let items = [tool("plain"), diff, Message(.object(["id": .string("second"), "kind": .string("file_change")]))]
        XCTAssertEqual(ConversationTranscriptGroups.firstDiffItemID(messages: items), "first")
        XCTAssertNil(ConversationTranscriptGroups.firstDiffItemID(messages: [items[0]]))
        let toolDiff = tool("tool-diff", display: ["artifact_kind": .string("diff")])
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(toolDiff, preferences: .object(["tool_details_mode": .string("auto")]), firstDiff: true))
    }

    func testFailedTestsExpandIndependentlyOfErrorPreference() {
        let failed = tool("failed-test", readOnly: true, display: ["is_error": .bool(true), "test_summary": .object(["failed": .number(2)])])
        let preferences: JSON = .object(["tool_details_mode": .string("auto"), "auto_expand": .object(["errors": .bool(false), "failed_tests": .bool(true)])])
        XCTAssertTrue(TranscriptPresentation.failedTests(failed.raw))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(failed, preferences: preferences))
        XCTAssertEqual(groupIDs([tool("a", readOnly: true), failed, tool("b", readOnly: true)], preferences: preferences), [["a"], ["failed-test"], ["b"]])
        let disabled = preferences.setting("auto_expand", .object(["errors": .bool(false), "failed_tests": .bool(false)]))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(failed, preferences: disabled))
        XCTAssertEqual(groupIDs([tool("a", readOnly: true), failed, tool("b", readOnly: true)], preferences: disabled), [["a", "failed-test", "b"]])
    }

    func testCompactReadOnlyDetailsPreserveMCPArtifactsAndHighSignal() {
        let ordinary = tool("ordinary", readOnly: true)
        let mediaContents: [JSON] = [
            .object(["type": .string("image"), "data": .string("image-data")]),
            .object(["type": .string("audio"), "data": .string("audio-data")]),
            .object(["type": .string("resource_link"), "uri": .string("https://example.com/file")]),
            .object(["type": .string("resource"), "resource": .object(["uri": .string("file:///tmp/image.png")])])
        ]
        for mode in ["compact", "hide_read_only_details"] {
            let preferences: JSON = .object(["tool_details_mode": .string(mode)])
            XCTAssertTrue(TranscriptPresentation.suppressReadOnlyDetails(ordinary.raw, preferences: preferences))
            XCTAssertFalse(TranscriptPresentation.suppressReadOnlyDetails(tool("write", readOnly: true, sideEffect: true).raw, preferences: preferences))
            for content in mediaContents {
                let media = ordinary.raw.setting("detail", .object(["result": .object(["content": .array([content])])]))
                XCTAssertTrue(TranscriptPresentation.hasRenderableArtifacts(media))
                XCTAssertFalse(TranscriptPresentation.suppressReadOnlyDetails(media, preferences: preferences))
            }
            let summary = tool("summary", readOnly: true, display: ["provider_output_summary": .object(["embedded_resources": .number(1)])])
            XCTAssertFalse(TranscriptPresentation.suppressReadOnlyDetails(summary.raw, preferences: preferences))
            let error = ordinary.raw.setting("status", .string("failed"))
            XCTAssertFalse(TranscriptPresentation.suppressReadOnlyDetails(error, preferences: preferences))
            XCTAssertTrue(TranscriptPresentation.suppressReadOnlyDetails(error, preferences: preferences.setting("auto_expand", .object(["errors": .bool(false)]))))
            let approval = ordinary.raw.setting("status", .string("awaiting_approval"))
            XCTAssertFalse(TranscriptPresentation.suppressReadOnlyDetails(approval, preferences: preferences))
        }
        XCTAssertFalse(TranscriptPresentation.suppressReadOnlyDetails(ordinary.raw, preferences: .null))
        XCTAssertFalse(TranscriptPresentation.hasRenderableArtifacts(ordinary.raw.setting("detail", .object(["result": .object(["content": .array([.object(["type": .string("text"), "text": .string("ordinary")])])])]))))
    }

    func testUnresolvedApprovalExpansionUsesApprovalPreference() {
        let request = Message(.object(["kind": .string("interactive_request"), "resolved": .bool(false)]))
        XCTAssertTrue(TranscriptPresentation.defaultExpanded(request, preferences: .null))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(request, preferences: .object(["auto_expand": .object(["approvals": .bool(false)])])))
        XCTAssertFalse(TranscriptPresentation.defaultExpanded(Message(request.raw.setting("resolved", .bool(true))), preferences: .null))
    }

    func testFileLinksPreservePathsAndSourceLocations() {
        let cases: [(String, String, Int?)] = [
            ("/Users/James/App.swift", "/Users/James/App.swift", nil),
            ("/Users/James/App.swift:12", "/Users/James/App.swift", 12),
            ("/Users/James/App.swift:12:4", "/Users/James/App.swift", 12),
            ("src/App.swift:7:2", "src/App.swift", 7),
            ("README.md:9", "./README.md", 9),
            ("../App.swift#L12", "../App.swift", 12),
            ("src/App.swift#L12-L20", "src/App.swift", 12),
            ("./App.swift?line=18", "./App.swift", 18),
            ("file:///tmp/user%20name.swift#L6", "/tmp/user name.swift", 6),
            ("file://localhost/tmp/App.swift?line=3", "/tmp/App.swift", 3),
            ("./App.swift:4:2?line=9#L12", "./App.swift", 12)
        ]
        for (destination, path, line) in cases {
            XCTAssertEqual(TranscriptFileLink.parse(destination), TranscriptFileLink(path: path, line: line), destination)
        }
    }

    func testFileLinksRejectSchemesCredentialsAndAmbiguousWords() {
        for destination in ["", "#L12", "settings", "javascript:alert(1)", "https://example.com/file.swift", "vscode://file/tmp/App.swift", "file://user:secret@localhost/tmp/App.swift", "//example.com/App.swift", "//localhost/tmp/App.swift", "file://remote-host/tmp/App.swift", "file:///tmp/a\0.swift"] {
            XCTAssertNil(TranscriptFileLink.parse(destination), destination)
        }
    }

    func testTranscriptLinksOnlyOpenSafeExternalSchemes() {
        for candidate in ["https://example.com/path", "http://localhost:3000", "mailto:hello@example.com"] {
            XCTAssertNotNil(TranscriptPresentation.externalURL(candidate), candidate)
        }
        for candidate in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hello", "falcondeck://settings", "https://user:secret@example.com", "https:///missing-host", "relative/file"] {
            XCTAssertNil(TranscriptPresentation.externalURL(candidate), candidate)
        }
    }

    func testInlineAttachmentDataDecodesAndRejectsInvalidPayloads() throws {
        let pngSignature = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        XCTAssertEqual(try TranscriptMediaData.inlineData("data:image/png;base64,iVBORw0KGgo="), pngSignature)
        XCTAssertEqual(try TranscriptMediaData.inlineData("data:text/plain,Hello%20world"), Data("Hello world".utf8))
        XCTAssertNil(try TranscriptMediaData.inlineData("https://example.com/image.png"))
        XCTAssertThrowsError(try TranscriptMediaData.inlineData("data:image/png;base64,A"))
        XCTAssertThrowsError(try TranscriptMediaData.inlineData("data:image/png;base64"))
    }

    private func tool(_ id: String, readOnly: Bool = false, sideEffect: Bool = false, display fields: [String: JSON] = [:]) -> Message {
        var display = fields
        display["is_read_only"] = .bool(readOnly)
        display["has_side_effect"] = .bool(sideEffect)
        return Message(.object(["id": .string(id), "kind": .string("tool_call"), "status": .string("completed"), "display": .object(display)]))
    }

    private func groupIDs(_ messages: [Message], preferences: JSON) -> [[String]] {
        ConversationTranscriptGroups.groups(messages: messages, preferences: preferences).map { $0.map(\.id) }
    }
}
