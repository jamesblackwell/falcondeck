import XCTest
@testable import FalconDeckNative

final class DiagramTests: XCTestCase {
    func testNativeFlowchartKeepsLabelsBranchesAndDecisionShapes() throws {
        let diagram = try XCTUnwrap(FlowDiagram.parse("flowchart TD\nA[Start] --> B{Ready?}\nB -->|Yes| C[Finish]\nB -.->|No| A"))
        XCTAssertEqual(diagram.nodes.map(\.label), ["Start", "Ready?", "Finish"])
        XCTAssertTrue(diagram.nodes[1].diamond)
        XCTAssertEqual(diagram.edges.count, 3)
        XCTAssertEqual(diagram.edges[1].label, "Yes")
        XCTAssertTrue(diagram.edges[2].dashed)
        XCTAssertEqual(diagram.levels().count, 3)
    }
    func testReverseOrientationPreservesEdgeMeaning() throws {
        let diagram = try XCTUnwrap(FlowDiagram.parse("flowchart RL\nA[Client] --> B[Relay]"))
        XCTAssertTrue(diagram.reversed)
        XCTAssertEqual(diagram.edges[0].from, "A")
        XCTAssertEqual(diagram.edges[0].to, "B")
        XCTAssertEqual(diagram.levels()["A"], 0)
        XCTAssertEqual(diagram.levels()["B"], 1)
    }
    func testUnsupportedSyntaxFallsBackToCompleteSource() {
        XCTAssertNil(FlowDiagram.parse("sequenceDiagram\nAlice->>Bob: Hello"))
        XCTAssertNil(FlowDiagram.parse("flowchart TD\nsubgraph Work\nA-->B\nend"))
        XCTAssertNil(FlowDiagram.parse("flowchart TD\nA --> A"))
        XCTAssertNil(FlowDiagram.parse("flowchart TD\n" + (0..<81).map { "N\($0)[Node]" }.joined(separator: "\n")))
    }
    func testUndirectedConnectionsAndNodeDeclarationsRemainSupported() throws {
        let diagram = try XCTUnwrap(FlowDiagram.parse("graph LR; A[One]; B[Two]; A --- B"))
        XCTAssertEqual(diagram.nodes.map(\.label), ["One", "Two"])
        XCTAssertFalse(diagram.edges[0].directed)
    }
}
