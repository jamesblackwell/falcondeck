import XCTest
@testable import FalconDeckMac

final class ConversationMarkdownRegressionTests: XCTestCase {
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
