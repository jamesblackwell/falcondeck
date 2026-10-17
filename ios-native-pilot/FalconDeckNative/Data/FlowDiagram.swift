import Foundation

struct FlowDiagram {
    struct Node: Identifiable { let id: String; var label: String; var diamond: Bool }
    struct Edge { let from: String; let to: String; let label: String; let directed: Bool; let dashed: Bool }
    var horizontal = false
    var reversed = false
    var nodes: [Node] = []
    var edges: [Edge] = []
    /// Common Mermaid flowcharts are rendered as native shapes. Unsupported
    /// syntax returns nil, keeping the complete, copyable source visible.
    static func parse(_ source: String) -> FlowDiagram? {
        guard source.utf8.count <= 80_000 else { return nil }
        let lines = source.components(separatedBy: .newlines).map { String($0.components(separatedBy: "%%").first ?? "") }.joined(separator: "\n").split(whereSeparator: { $0 == "\n" || $0 == ";" }).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard let header = lines.first?.split(whereSeparator: \.isWhitespace), header.count == 2, ["flowchart", "graph"].contains(String(header[0])), ["TD", "TB", "BT", "LR", "RL"].contains(String(header[1])) else { return nil }
        var diagram = FlowDiagram(horizontal: ["LR", "RL"].contains(String(header[1])), reversed: ["BT", "RL"].contains(String(header[1])))
        let pattern = #"^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\]|\(\((.*?)\)\)|\((.*?)\)|\{(.*?)\})?"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        func node(_ source: String) -> (String, String)? {
            guard let match = regex.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)), let idRange = Range(match.range(at: 1), in: source), let whole = Range(match.range, in: source) else { return nil }
            let id = String(source[idRange])
            let label = (2...5).compactMap { index in Range(match.range(at: index), in: source).map { String(source[$0]) } }.first
            let title = (label ?? id).trimmingCharacters(in: CharacterSet(charactersIn: "\"'")).replacingOccurrences(of: "<br/>", with: "\n").replacingOccurrences(of: "<br>", with: "\n")
            if let index = diagram.nodes.firstIndex(where: { $0.id == id }) {
                if label != nil { diagram.nodes[index].label = title; diagram.nodes[index].diamond = match.range(at: 5).location != NSNotFound }
            } else { diagram.nodes.append(Node(id: id, label: title, diamond: match.range(at: 5).location != NSNotFound)) }
            return (id, String(source[whole.upperBound...]).trimmingCharacters(in: .whitespaces))
        }
        for line in lines.dropFirst() {
            if ["style ", "classDef ", "class ", "linkStyle "].contains(where: line.hasPrefix) { continue }
            guard var current = node(line), diagram.nodes.count <= 80 else { return nil }
            while !current.1.isEmpty {
                let rest = current.1
                guard let arrow = ["-->", "---", "-.->", "==>"].first(where: rest.hasPrefix) else { return nil }
                var following = String(rest.dropFirst(arrow.count)).trimmingCharacters(in: .whitespaces)
                var label = ""
                if following.hasPrefix("|") {
                    guard let end = following.dropFirst().firstIndex(of: "|") else { return nil }
                    label = String(following[following.index(after: following.startIndex)..<end])
                    following = String(following[following.index(after: end)...]).trimmingCharacters(in: .whitespaces)
                }
                guard let next = node(following) else { return nil }
                guard current.0 != next.0 else { return nil }
                diagram.edges.append(Edge(from: current.0, to: next.0, label: label, directed: arrow != "---", dashed: arrow == "-.->"))
                current = next
                if diagram.nodes.count > 80 || diagram.edges.count > 160 { return nil }
            }
        }
        return diagram.nodes.isEmpty ? nil : diagram
    }
    func levels() -> [String: Int] {
        var degrees = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, 0) }), ranks: [String: Int] = [:]
        for edge in edges { degrees[edge.to, default: 0] += 1 }
        var queue = nodes.filter { degrees[$0.id] == 0 }.map(\.id)
        for id in queue { ranks[id] = 0 }
        var cursor = 0
        while cursor < queue.count {
            let id = queue[cursor]; cursor += 1
            for edge in edges where edge.from == id {
                ranks[edge.to] = max(ranks[edge.to, default: 0], ranks[id, default: 0] + 1)
                degrees[edge.to, default: 0] -= 1
                if degrees[edge.to] == 0 { queue.append(edge.to) }
            }
        }
        // Cyclic components get a bounded linear placement, with visible
        // returning arrows, rather than an unbounded rank propagation loop.
        var next = (ranks.values.max() ?? -1) + 1
        for node in nodes where degrees[node.id, default: 0] > 0 { ranks[node.id] = next; next += 1 }
        return ranks
    }
}
