import Foundation

enum NotificationFilter: String, CaseIterable, Identifiable, Sendable {
    case all, needsYou = "needs_you", bots
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "All"
        case .needsYou: "Needs you"
        case .bots: "From bots"
        }
    }
}

/// Where tapping a record goes, as the daemon stated it.
enum NotificationTarget: Equatable, Sendable {
    case thread(projectID: String, taskID: String)
    case review(String)
}

/// Where a tap lands in this app. A body wins: the report is what was sent, and
/// its `target` is then the way back to the source.
enum NotificationDestination: Equatable, Sendable {
    case report(String)
    case thread(projectID: String, taskID: String)
    case review(String)
    case nothing
}

/// One row of the centre. The daemon owns these; `raw` keeps unknown fields so a
/// newer daemon's kinds still render.
struct NotificationRecord: Identifiable, Equatable, Sendable {
    let raw: JSON
    init(_ value: JSON) { raw = value }

    var id: String { raw["id"].string }
    var seq: Int { raw["seq"].int }
    var kind: String { raw["kind"].string }
    var title: String { raw["title"].string }
    var preview: String { raw["preview"].string }
    var bot: String? { raw["bot"].string.nonempty }
    var threadID: String? { raw["thread_id"].string.nonempty }
    var workspaceID: String? { raw["workspace_id"].string.nonempty }
    var createdAt: String { raw["created_at"].string }
    var isRead: Bool { raw["read_at"].string.nonempty != nil }
    var isResolved: Bool { raw["resolved_at"].string.nonempty != nil }
    var hasBody: Bool { raw["has_body"].bool }
    var body: String? { raw["body"].string.nonempty }
    var repeatCount: Int { raw["repeat_count"].int }
    var isAgentNotice: Bool { kind == "agent_notice" }

    var asksForDecision: Bool { kind == "input_required" || kind == "review" }
    /// A request or review that stopped waiting on James.
    var wasDealtWith: Bool { asksForDecision && isResolved }

    /// Mirrors `NotificationRecord::matches` so switching filter narrows at once.
    func matches(_ filter: NotificationFilter) -> Bool {
        switch filter {
        case .all: true
        case .needsYou: asksForDecision && !isResolved
        case .bots: bot != nil || isAgentNotice
        }
    }

    var target: NotificationTarget? {
        let target = raw["target"]
        switch target["type"].string {
        case "thread":
            guard let project = target["workspace_id"].string.nonempty,
                  let task = target["thread_id"].string.nonempty else { return nil }
            return .thread(projectID: project, taskID: task)
        case "review": return target["review_id"].string.nonempty.map(NotificationTarget.review)
        default: return nil
        }
    }

    var destination: NotificationDestination {
        if hasBody { return .report(id) }
        switch target {
        case .thread(let project, let task): return .thread(projectID: project, taskID: task)
        case .review(let id): return .review(id)
        case nil: return .nothing
        }
    }

    func markedRead(at timestamp: String) -> NotificationRecord {
        NotificationRecord(raw.setting("read_at", .string(timestamp)))
    }
}

/// The store-wide numbers on the bell, whatever the filter.
struct NotificationCounts: Equatable, Sendable {
    var unread = 0
    var needsYou = 0
    var latestSeq = 0
    init() {}
    init(_ value: JSON) {
        unread = value["unread_count"].int
        needsYou = value["needs_you_count"].int
        latestSeq = value["latest_seq"].int
    }
}

struct NotificationDaySection: Identifiable, Equatable {
    let id: String
    let title: String
    var records: [NotificationRecord]
}

enum NotificationDayGrouping {
    /// Groups by the viewer's calendar day. Order within the list is the
    /// daemon's; a day is never split even if a clock stepped backwards.
    static func sections(_ records: [NotificationRecord], now: Date = Date(), calendar: Calendar = .current,
                         locale: Locale = .current, date: (String) -> Date?) -> [NotificationDaySection] {
        var result: [NotificationDaySection] = []
        var positions: [String: Int] = [:]
        for record in records {
            let day = date(record.createdAt).map { calendar.startOfDay(for: $0) }
            let key = day.map { String(Int($0.timeIntervalSince1970)) } ?? "unknown"
            if let index = positions[key] {
                result[index].records.append(record)
            } else {
                positions[key] = result.count
                result.append(.init(id: key, title: title(day, now: now, calendar: calendar, locale: locale), records: [record]))
            }
        }
        return result
    }

    private static func title(_ day: Date?, now: Date, calendar: Calendar, locale: Locale) -> String {
        guard let day else { return "Earlier" }
        if calendar.isDate(day, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        let sameYear = calendar.component(.year, from: day) == calendar.component(.year, from: now)
        formatter.setLocalizedDateFormatFromTemplate(sameYear ? "EEEdMMM" : "dMMMy")
        return formatter.string(from: day)
    }
}

enum NotificationBadge {
    static func label(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count > 99 ? "99+" : String(count)
    }
}
