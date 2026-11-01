import SwiftUI

enum ReviewFormat {
    /// "now", "4m", "3h", "2d", "12 Oct", like the task lists.
    static func age(_ date: Date, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        if seconds < 7 * 86_400 { return "\(Int(seconds / 86_400))d" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    /// When the agent will proceed by itself. Display only; the daemon never acts on it.
    static func goingAhead(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        if date <= now { return "Going ahead now" }
        if calendar.isDate(date, inSameDayAs: now) { return "Going ahead at \(date.formatted(date: .omitted, time: .shortened))" }
        return "Going ahead \(date.formatted(.dateTime.weekday(.abbreviated).hour().minute()))"
    }
}

extension ReviewDecision {
    @MainActor var tint: Color {
        switch self {
        case .approve: FD.success
        case .requestChanges: FD.warning
        case .reject: FD.danger
        }
    }
}

extension ReviewStatus {
    @MainActor var tint: Color {
        switch self {
        case .open: FD.accent
        case .approved: FD.success
        case .changesRequested: FD.warning
        case .rejected: FD.danger
        case .withdrawn: FD.muted
        }
    }
    var symbol: String {
        switch self {
        case .open: "circle.dotted"
        case .approved: "checkmark.circle.fill"
        case .changesRequested: "arrow.uturn.backward.circle.fill"
        case .rejected: "xmark.circle.fill"
        case .withdrawn: "arrow.uturn.left.circle"
        }
    }
}

/// The monospaced section label used across the sidebar and sheets.
private struct ReviewCaption: ViewModifier {
    func body(content: Content) -> some View {
        content.font(.system(.caption2, design: .monospaced).weight(.medium)).tracking(0.8).textCase(.uppercase).foregroundStyle(FD.muted)
    }
}
extension View { func reviewCaption() -> some View { modifier(ReviewCaption()) } }

/// A bot's mark and name, or a neutral mark when the review came from no bot.
struct ReviewSender: View {
    @Environment(AppModel.self) private var model
    let name: String?
    var body: some View {
        HStack(spacing: 6) {
            if let name { BotMark(icon: model.reviewBotIcon(named: name), size: 14) }
            else { Image(systemName: "text.badge.checkmark").font(.caption).foregroundStyle(FD.muted) }
            Text(name ?? "Review").font(.caption.weight(.medium)).foregroundStyle(FD.secondary).lineLimit(1)
        }
    }
}
