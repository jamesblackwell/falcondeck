import SwiftUI
@preconcurrency import MarkdownUI

struct NativeFencedBlock: View {
    let content: String
    let language: String?
    var body: some View {
        if language?.lowercased() == "mermaid", let diagram = FlowDiagram.parse(content) { NativeDiagram(diagram: diagram, source: content) }
        else { NativeCodeBlock(content: content, language: language) }
    }
}

private struct FlowLayout {
    var positions: [String: CGPoint] = [:]
    var size: CGSize
    init(_ diagram: FlowDiagram) {
        let ranks = diagram.levels()
        let groups = Dictionary(grouping: diagram.nodes) { ranks[$0.id] ?? 0 }
        let widest = groups.values.map(\.count).max() ?? 1, depth = (ranks.values.max() ?? 0) + 1
        for (level, nodes) in groups {
            let rank = diagram.reversed ? depth - 1 - level : level
            for (index, node) in nodes.enumerated() {
                positions[node.id] = diagram.horizontal ? CGPoint(x: 112 + rank * 250, y: 76 + index * 150) : CGPoint(x: 112 + index * 250, y: 76 + rank * 150)
            }
        }
        size = diagram.horizontal ? CGSize(width: max(250, depth * 250), height: max(150, widest * 150)) : CGSize(width: max(250, widest * 250), height: max(150, depth * 150))
    }
}

struct NativeDiagram: View {
    let diagram: FlowDiagram
    let source: String
    @State private var code = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Label("Flowchart", systemImage: "point.3.connected.trianglepath.dotted").font(.caption); Spacer(); Button(code ? "Diagram" : "Source") { code.toggle() }.font(.caption) }.foregroundStyle(FD.secondary)
            if code { NativeCodeBlock(content: source, language: "mermaid") }
            else {
                let layout = FlowLayout(diagram)
                ScrollView([.horizontal, .vertical]) {
                    ZStack(alignment: .topLeading) {
                        ForEach(Array(diagram.edges.enumerated()), id: \.offset) { _, edge in
                            if let start = layout.positions[edge.from], let end = layout.positions[edge.to] { FlowArrow(start: start, end: end, horizontal: diagram.horizontal, label: edge.label, directed: edge.directed, dashed: edge.dashed) }
                        }
                        ForEach(diagram.nodes) { node in
                            let shape = node.diamond ? AnyShape(DecisionDiamond()) : AnyShape(RoundedRectangle(cornerRadius: 14))
                            Text(node.label).font(.subheadline).multilineTextAlignment(.center).lineLimit(4).padding(12).frame(width: 174, height: node.diamond ? 98 : 76)
                                .background(FD.raised, in: shape).overlay { shape.stroke(FD.accent.opacity(0.55), lineWidth: 1.2) }
                                .position(layout.positions[node.id] ?? .zero).accessibilityLabel(node.label)
                        }
                    }.frame(width: layout.size.width, height: layout.size.height)
                }.frame(height: min(layout.size.height, 500))
            }
        }.padding(12).background(FD.surface, in: .rect(cornerRadius: 14)).overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(FD.line) }.markdownMargin(top: 8, bottom: 16)
    }
}

private struct FlowArrow: View {
    let start: CGPoint
    let end: CGPoint
    let horizontal: Bool
    let label: String
    let directed: Bool
    let dashed: Bool
    var body: some View {
        let direction: CGFloat = horizontal ? (end.x >= start.x ? 1 : -1) : (end.y >= start.y ? 1 : -1)
        let from = horizontal ? CGPoint(x: start.x + 88 * direction, y: start.y) : CGPoint(x: start.x, y: start.y + 39 * direction)
        let to = horizontal ? CGPoint(x: end.x - 88 * direction, y: end.y) : CGPoint(x: end.x, y: end.y - 39 * direction)
        let a = horizontal ? CGPoint(x: (from.x + to.x) / 2, y: from.y) : CGPoint(x: from.x, y: (from.y + to.y) / 2)
        let b = horizontal ? CGPoint(x: a.x, y: to.y) : CGPoint(x: to.x, y: a.y)
        ZStack(alignment: .topLeading) {
            Path { p in p.move(to: from); p.addCurve(to: to, control1: a, control2: b) }.stroke(FD.secondary.opacity(0.6), style: StrokeStyle(lineWidth: 1.4, dash: dashed ? [5, 4] : []))
            if directed { Path { p in
                p.move(to: to)
                p.addLine(to: horizontal ? CGPoint(x: to.x - 7 * direction, y: to.y - 4) : CGPoint(x: to.x - 4, y: to.y - 7 * direction))
                p.addLine(to: horizontal ? CGPoint(x: to.x - 7 * direction, y: to.y + 4) : CGPoint(x: to.x + 4, y: to.y - 7 * direction)); p.closeSubpath()
            }.fill(FD.secondary) }
            if !label.isEmpty { Text(label).font(.caption2).padding(4).background(FD.surface, in: .rect(cornerRadius: 4)).position(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2) }
        }.accessibilityElement(children: .ignore).accessibilityLabel("\(label.nonempty ?? "Connection")")
    }
}

private struct DecisionDiamond: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in path.move(to: CGPoint(x: rect.midX, y: rect.minY)); path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY)); path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY)); path.addLine(to: CGPoint(x: rect.minX, y: rect.midY)); path.closeSubpath() }
    }
}
