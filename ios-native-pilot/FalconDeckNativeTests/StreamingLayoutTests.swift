import SwiftUI
import XCTest
@testable import FalconDeckNative

@MainActor final class StreamingLayoutTests: XCTestCase {
    @Observable final class Input { var text = "A fixed opening paragraph.\n\nA growing response" }
    private struct Sample: View {
        let input: Input
        let measured: (CGFloat) -> Void
        var body: some View {
            NativeMarkdown(text: input.text, streaming: true)
                .frame(width: 320)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measured($0) }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
    func testAppendingPlainTextDoesNotMakeMarkdownHeightBounce() async throws {
        let input = Input(), window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 700))
        var heights: [CGFloat] = []
        let host = UIHostingController(rootView: Sample(input: input) { heights.append($0) })
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        try await Task.sleep(for: .milliseconds(100))
        for _ in 0..<35 {
            input.text += " more words"
            try await Task.sleep(for: .milliseconds(25))
        }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertGreaterThan(heights.count, 5)
        let drops = zip(heights, heights.dropFirst()).filter { $1 < $0 - 0.5 }
        XCTAssertTrue(drops.isEmpty, "Plain appended prose must not shrink between layouts: \(heights)")
    }
}
