import SwiftUI

/// A bot's `icon` as the daemon stores it: a shape name plus a `cat-N` theme token.
struct NativeBotIcon: Hashable, Sendable {
    var shape: String
    var color: String

    static let shapes = ["circle", "diamond", "square", "triangle", "hexagon", "star", "pentagon", "cross"]
    static let colors = (1...12).map { "cat-\($0)" }

    init(shape: String, color: String) { self.shape = shape; self.color = color }
    init?(raw: JSON) {
        let shape = raw["shape"].string, color = raw["color"].string
        guard Self.shapes.contains(shape), Self.colors.contains(color) else { return nil }
        self.init(shape: shape, color: color)
    }

    /// `cat-7` → 7. Palettes retint the same twelve slots.
    var colorSlot: String { String(color.dropFirst(4)) }

    /// Mirrors client-core's `resolveBotIcons`: bots without a valid mark get the
    /// next unused shape and color, in the daemon's assignment order.
    static func resolve(_ bots: [(id: String, icon: NativeBotIcon?)]) -> [String: NativeBotIcon] {
        var taken = bots.compactMap(\.icon)
        var resolved: [String: NativeBotIcon] = [:]
        for bot in bots {
            if let icon = bot.icon { resolved[bot.id] = icon; continue }
            func pick(_ options: [String], _ part: (NativeBotIcon) -> String) -> String {
                options.first { option in !taken.contains { part($0) == option } } ?? options[taken.count % options.count]
            }
            let icon = NativeBotIcon(shape: pick(shapes, \.shape), color: pick(colors, \.color))
            taken.append(icon)
            resolved[bot.id] = icon
        }
        return resolved
    }
}

/// The web `BotMark`'s shapes, drawn in the same 16×16 box.
private struct BotMarkShape: Shape {
    let name: String

    private static let polygons: [String: [(CGFloat, CGFloat)]] = [
        "diamond": [(8, 1.6), (14.4, 8), (8, 14.4), (1.6, 8)],
        "triangle": [(8, 2.1), (14.24, 12.9), (1.76, 12.9)],
        "hexagon": [(8, 1.4), (13.72, 4.7), (13.72, 11.3), (8, 14.6), (2.28, 11.3), (2.28, 4.7)],
        "star": [(8, 1.6), (9.76, 6.17), (14.66, 6.44), (10.85, 9.53), (12.11, 14.26), (8, 11.6),
                 (3.89, 14.26), (5.15, 9.53), (1.34, 6.44), (6.24, 6.17)],
        "pentagon": [(8, 1.9), (14.28, 6.46), (11.88, 13.84), (4.12, 13.84), (1.72, 6.46)],
        "cross": [(6, 1.8), (10, 1.8), (10, 6), (14.2, 6), (14.2, 10), (10, 10), (10, 14.2), (6, 14.2),
                  (6, 10), (1.8, 10), (1.8, 6), (6, 6)]
    ]

    func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height), scale = side / 16
        let origin = CGPoint(x: rect.midX - side / 2, y: rect.midY - side / 2)
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x * scale, y: origin.y + y * scale) }
        switch name {
        case "square":
            return Path(roundedRect: CGRect(origin: point(2.4, 2.4), size: CGSize(width: 11.2 * scale, height: 11.2 * scale)),
                        cornerRadius: 2.4 * scale, style: .circular)
        case let name where Self.polygons[name] != nil:
            var path = Path()
            let points = Self.polygons[name]!.map { point($0.0, $0.1) }
            path.move(to: points[0]); points.dropFirst().forEach { path.addLine(to: $0) }
            path.closeSubpath()
            return path
        default:
            return Path(ellipseIn: CGRect(origin: point(2, 2), size: CGSize(width: 12 * scale, height: 12 * scale)))
        }
    }
}

/// A bot's colored shape. Activity is shown beside it, not on it. The matching
/// stroke softens the corners exactly as the web mark does.
struct BotMark: View {
    let icon: NativeBotIcon
    var size: CGFloat = 16

    var body: some View {
        let color = NativeAppearance.shared.color("cat", icon.colorSlot)
        let shape = BotMarkShape(name: icon.shape)
        shape.fill(color)
            .overlay { shape.stroke(color, style: StrokeStyle(lineWidth: 1.2 * size / 16, lineJoin: .round)) }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

extension AppModel {
    /// Marks keyed by bot ID, including the daemon's fill-in for bots saved before icons existed.
    var botIcons: [String: NativeBotIcon] {
        NativeBotIcon.resolve(bots.map { ($0.id, NativeBotIcon(raw: $0.raw["icon"])) })
    }
    /// The bot whose home task or earlier home tasks (after a harness switch) match.
    func bot(owningTask taskID: String) -> NativeBot? {
        bots.first { $0.taskID == taskID || $0.previousTaskIDs.contains(taskID) }
    }
    func botIcon(forTask taskID: String) -> NativeBotIcon? {
        guard let owner = bot(owningTask: taskID) else { return nil }
        return botIcons[owner.id]
    }
}

extension AppModel {
    /// The bot that dispatched this task, for tasks an agent spawned from a bot's home thread.
    func dispatchingBot(of task: AgentTask) -> NativeBot? {
        let origin = task.raw["origin"]
        guard origin["kind"].string == "agent_spawn" else { return nil }
        return bot(owningTask: origin["parent_thread_id"].string)
    }
}
