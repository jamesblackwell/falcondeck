import XCTest
@testable import FalconDeckMac

final class ConversationMarkdownRegressionTests: XCTestCase {
    func testIndentedCodeKeepsWhitespaceAndMarkdownLiteral() {
        XCTAssertEqual(TranscriptMarkdownParser.parse("    # literal heading\n        **literal emphasis**\n\n    echo done\n\nAfter"), [
            .code(language: "", text: "# literal heading\n    **literal emphasis**\n\necho done"),
            .paragraph("After")
        ])
        XCTAssertEqual(TranscriptMarkdownParser.parse("\techo one\n\t\techo two"), [
            .code(language: "", text: "echo one\n\techo two")
        ])
    }

    func testParagraphParserPreservesExplicitHardBreakMarkers() {
        XCTAssertEqual(TranscriptMarkdownParser.parse("First  \nSecond\\\nThird"), [
            .paragraph("First  \nSecond\\\nThird")
        ])
        XCTAssertEqual(TranscriptMarkdownParser.parse("- First  \n  Second"), [
            .list(ordered: false, start: 1, items: [.init(checked: nil, blocks: [.paragraph("First  \nSecond")])])
        ])
    }

    func testInlineSourceWrappingAndHardBreaksMatchMarkdown() {
        XCTAssertEqual(String(TranscriptMarkdownInline.attributed("First\nSecond").characters), "First Second")
        for source in ["First  \nSecond", "First\\\nSecond"] {
            let result = TranscriptMarkdownInline.attributed(source)
            XCTAssertEqual(String(result.characters), "First\nSecond")
            XCTAssertTrue(result.runs.contains { $0.inlinePresentationIntent?.contains(.lineBreak) == true })
        }
        XCTAssertEqual(String(TranscriptMarkdownInline.attributed("`First\nSecond`").characters), "First Second")
    }

    func testReferenceLinksResolveAcrossParagraphsAndNestedBlocks() {
        let source = "Read [the docs][guide].\n\n> Follow [the docs][guide].\n\n- Check [the docs][guide].\n\n[guide]:\n  <https://falcondeck.com/docs>\n  \"Guide\""
        let document = TranscriptMarkdownParser.document(source)
        XCTAssertEqual(document.blocks, [
            .paragraph("Read [the docs][guide]."),
            .quote([.paragraph("Follow [the docs][guide].")]),
            .list(ordered: false, start: 1, items: [.init(checked: nil, blocks: [.paragraph("Check [the docs][guide].")])])
        ])
        for text in ["Read [the docs][guide].", "Follow [the docs][guide].", "Check [the docs][guide]."] {
            let result = TranscriptMarkdownInline.attributed(text, referenceDefinitions: document.referenceDefinitions)
            XCTAssertFalse(String(result.characters).contains("[guide]"))
            XCTAssertEqual(result.runs.compactMap(\.link).map(\.absoluteString), ["https://falcondeck.com/docs"])
        }
    }

    func testReferenceDefinitionsRemainLiteralInsideCodeAndParagraphs() {
        let source = "```text\n[guide]: https://example.com/fenced\n```\n\n    [guide]: https://example.com/indented\n\nOrdinary prose\n[guide]: https://example.com/prose\n\n[missing]:"
        let document = TranscriptMarkdownParser.document(source)
        XCTAssertEqual(document.referenceDefinitions, "")
        XCTAssertEqual(document.blocks, [
            .code(language: "text", text: "[guide]: https://example.com/fenced"),
            .code(language: "", text: "[guide]: https://example.com/indented"),
            .paragraph("Ordinary prose\n[guide]: https://example.com/prose"),
            .paragraph("[missing]:")
        ])
        XCTAssertEqual(String(TranscriptMarkdownInline.attributed("[the docs][guide]", referenceDefinitions: document.referenceDefinitions).characters), "[the docs][guide]")
    }

    func testReferenceDefinitionsDoNotConsumeFollowingThematicBreaks() {
        for definition in ["[doc]: /docs", "[doc]: /docs \"Documentation\""] {
            for gap in ["\n", "\n\n"] {
                for rule in ["---", "***", "___"] {
                    let source = definition + gap + rule + "\nAfter"
                    let document = TranscriptMarkdownParser.document(source)
                    XCTAssertEqual(document.blocks, [.rule, .paragraph("After")], source)
                    XCTAssertEqual(document.referenceDefinitions, definition, source)
                }
            }
        }
    }

    func testReferenceDefinitionsDoNotConsumeEmptyCodeFences() {
        for gap in ["\n", "\n\n"] {
            let document = TranscriptMarkdownParser.document("[doc]: /docs" + gap + "```text\n```\nAfter")
            XCTAssertEqual(document.blocks, [.code(language: "text", text: ""), .paragraph("After")])
            XCTAssertEqual(document.referenceDefinitions, "[doc]: /docs")
        }
    }

    func testMultilineReferenceDestinationsAndTitlesStopBeforeFollowingBlocks() {
        let destination = "https://falcondeck.com/docs"
        let definitions = [
            "[doc]:\n  <\(destination)>\n  \"Documentation\"",
            "[doc]: \(destination)\n\"Documentation\ncontinued\"",
            "[doc]: \(destination)\n'Documentation\ncontinued'",
            "[doc]: \(destination)\n(Documentation\ncontinued)"
        ]
        for definition in definitions {
            let document = TranscriptMarkdownParser.document(definition + "\n---\n[other]: /other")
            XCTAssertEqual(document.blocks, [.rule], definition)
            XCTAssertEqual(document.referenceDefinitions, definition + "\n[other]: /other", definition)
            let result = TranscriptMarkdownInline.attributed("[Docs][doc]", referenceDefinitions: document.referenceDefinitions)
            XCTAssertEqual(String(result.characters), "Docs", definition)
            XCTAssertEqual(result.runs.compactMap(\.link).map(\.absoluteString), [destination], definition)
        }
    }

    func testInlineRenderingPreservesTypographyAndLiteralBlockMarkers() {
        let result = TranscriptMarkdownInline.attributed("**Bold 🦅** and *emphasis*, ~~old~~ and `code`.")
        XCTAssertEqual(String(result.characters), "Bold 🦅 and emphasis, old and code.")
        XCTAssertTrue(result.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        XCTAssertTrue(result.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
        XCTAssertTrue(result.runs.contains { $0.inlinePresentationIntent?.contains(.strikethrough) == true })
        XCTAssertTrue(result.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        XCTAssertTrue(result.runs.allSatisfy { $0.presentationIntent == nil })
        for text in ["# literal heading", "- literal list", "> literal quote", "    literal spaces", "snake_case", "_ trailing_", "__ trailing__"] {
            XCTAssertEqual(String(TranscriptMarkdownInline.attributed(text).characters), text)
        }
    }

    func testUnderscoreEmphasisAndStrongFormattingAtStartOfInlineText() {
        let italic = TranscriptMarkdownInline.attributed("_italic_ with text")
        XCTAssertEqual(String(italic.characters), "italic with text")
        XCTAssertTrue(italic.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
        let bold = TranscriptMarkdownInline.attributed("__bold__ with text")
        XCTAssertEqual(String(bold.characters), "bold with text")
        XCTAssertTrue(bold.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        XCTAssertEqual(String(TranscriptMarkdownInline.attributed("   _italic_").characters), "   italic")
    }

    func testLinksAtStartOfInlineTextKeepTheirDestinations() {
        for (source, text, target) in [
            ("[relative](src/main.rs:9)", "relative", "src/main.rs:9"),
            ("[docs](https://example.com/docs)", "docs", "https://example.com/docs"),
            ("https://example.com/docs", "https://example.com/docs", "https://example.com/docs"),
            ("<https://example.com/docs>", "https://example.com/docs", "https://example.com/docs")
        ] {
            let result = TranscriptMarkdownInline.attributed(source)
            XCTAssertEqual(String(result.characters), text)
            XCTAssertEqual(result.runs.compactMap(\.link).map(\.absoluteString), [target])
        }
    }

    func testInlineImagesRemainExplicitLinksIncludingEmptyAltText() {
        for (source, label) in [("Before ![A chart](https://example.com/chart.png) after", "Before A chart after"), ("![](https://example.com/chart.png)", "[Linked image]")] {
            let result = TranscriptMarkdownInline.attributed(source)
            XCTAssertEqual(String(result.characters), label)
            XCTAssertEqual(result.runs.compactMap(\.link).map(\.absoluteString), ["https://example.com/chart.png"])
            XCTAssertTrue(result.runs.allSatisfy { $0.imageURL == nil })
        }
    }

    func testMultilineSetextHeadingKeepsAllLines() {
        for (underline, level) in [("---", 2), ("===", 1)] {
            XCTAssertEqual(TranscriptMarkdownParser.parse("First line\nSecond 🦅 line\n\(underline)\nAfter"), [
                .heading(level: level, text: "First line\nSecond 🦅 line"),
                .paragraph("After")
            ])
        }
    }

    func testTableEndsBeforeFollowingBlockEvenWhenItContainsPipes() {
        let table: TranscriptMarkdownBlock = .table(headers: ["One", "Two"], alignments: [.leading, .leading], rows: [["a", "b"]])
        let cases: [(String, TranscriptMarkdownBlock)] = [
            ("# Next | Heading", .heading(level: 1, text: "Next | Heading")),
            ("~~~text|plain\nvalue\n~~~", .code(language: "text|plain", text: "value")),
            ("> Next | quote", .quote([.paragraph("Next | quote")])),
            ("- Next | item", .list(ordered: false, start: 1, items: [.init(checked: nil, blocks: [.paragraph("Next | item")])]))
        ]
        for (source, block) in cases {
            XCTAssertEqual(TranscriptMarkdownParser.parse("| One | Two |\n| --- | --- |\n| a | b |\n\(source)"), [table, block], source)
        }
    }

    func testThematicBreakAfterListDoesNotBecomeAnotherItem() {
        let list: TranscriptMarkdownBlock = .list(ordered: false, start: 1, items: [.init(checked: nil, blocks: [.paragraph("Item")])])
        for marker in ["-", "*"] {
            for gap in ["\n", "\n\n"] {
                let rule = Array(repeating: marker, count: 3).joined(separator: " ")
                XCTAssertEqual(TranscriptMarkdownParser.parse("\(marker) Item\(gap)\(rule)\nAfter"), [list, .rule, .paragraph("After")])
            }
        }
    }
}
