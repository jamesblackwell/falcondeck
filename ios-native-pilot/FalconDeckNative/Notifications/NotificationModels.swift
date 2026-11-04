import Foundation

/// What kind of attention event a record is. A kind this client does not know
/// still shows; it just has no special treatment.
enum NotificationKind: String, Sendable, Hashable {
    case inputRequired = "input_required", review, turnComplete = "turn_complete", error, agentNotice = "agent_notice", other
    init(wire: String) { self = Self(rawValue: wire) ?? .other }
    var needsYou: Bool { self == .inputRequired || self == .review }
    var symbol: String {
        switch self {
        case .inputRequired: "questionmark.bubble"
        case .review: "text.badge.checkmark"
        case .turnComplete: "checkmark.circle"
        case .error: "exclamationmark.triangle"
        case .agentNotice: "doc.text"
        case .other: "bell"
        }
    }
    var label: String {
        switch self {
        case .inputRequired: "Input needed"
        case .review: "Review"
        case .turnComplete: "Finished"
        case .error: "Failed"
        case .agentNotice: "Notice"
        case .other: "Notification"
        }
    }
}

/// The list filters every client offers. The daemon applies them.
enum NotificationFilter: String, CaseIterable, Sendable, Hashable {
    case all, needsYou = "needs_you", bots
    var title: String {
        switch self {
        case .all: "All"
        case .needsYou: "Needs you"
        case .bots: "From bots"
        }
    }
}

enum NotificationTarget: Hashable, Sendable {
    case thread(workspaceID: String, threadID: String)
    case review(String)
    init?(_ json: JSON) {
        switch json["type"].string {
        case "thread":
            guard !json["workspace_id"].string.isEmpty, !json["thread_id"].string.isEmpty else { return nil }
            self = .thread(workspaceID: json["workspace_id"].string, threadID: json["thread_id"].string)
        case "review":
            guard !json["review_id"].string.isEmpty else { return nil }
            self = .review(json["review_id"].string)
        default: return nil
        }
    }
}

/// Where a record's long body is hosted for reading while the Mac is asleep.
struct NotificationReportRef: Hashable, Sendable {
    let reportID: String
    let expiresAt: Date?
    let hosted: Bool
}

/// What tapping a record does.
enum NotificationAction: Equatable {
    case detail
    case thread(workspaceID: String, threadID: String)
    case review(String)
}

/// One entry in the notification centre. The daemon owns these; this is a view of one.
struct NotificationRecord: Identifiable, Hashable, Sendable {
    let id: String
    let seq: Int
    let kind: NotificationKind
    let title: String
    let preview: String
    let bot: String?
    let threadID: String?
    let workspaceID: String?
    let createdAt: Date
    var readAt: Date?
    let resolvedAt: Date?
    let target: NotificationTarget?
    let hasBody: Bool
    let body: String?
    let report: NotificationReportRef?
    let repeatCount: Int
    /// The wire form, for the disposable offline preview.
    private(set) var raw: JSON

    init(id: String, seq: Int, kind: NotificationKind, title: String, preview: String, bot: String? = nil, threadID: String? = nil, workspaceID: String? = nil,
         createdAt: Date, readAt: Date? = nil, resolvedAt: Date? = nil, target: NotificationTarget? = nil, hasBody: Bool = false, body: String? = nil,
         report: NotificationReportRef? = nil, repeatCount: Int = 0) {
        self.id = id; self.seq = seq; self.kind = kind; self.title = title; self.preview = preview; self.bot = bot
        self.threadID = threadID; self.workspaceID = workspaceID; self.createdAt = createdAt; self.readAt = readAt; self.resolvedAt = resolvedAt
        self.target = target; self.hasBody = hasBody; self.body = body; self.report = report; self.repeatCount = repeatCount
        raw = .null
    }

    /// A record this client cannot read returns nil; it never hides the others.
    init?(_ json: JSON) {
        guard !json["id"].string.isEmpty, let seq = json["seq"].optionalInt, !json["kind"].string.isEmpty,
              let createdAt = ReviewDecoding.date(json["created_at"].string) else { return nil }
        self.init(id: json["id"].string, seq: seq, kind: NotificationKind(wire: json["kind"].string), title: json["title"].string, preview: json["preview"].string,
                  bot: json["bot"].string.trimmingCharacters(in: .whitespacesAndNewlines).nonempty, threadID: json["thread_id"].string.nonempty,
                  workspaceID: json["workspace_id"].string.nonempty, createdAt: createdAt,
                  readAt: ReviewDecoding.date(json["read_at"].string), resolvedAt: ReviewDecoding.date(json["resolved_at"].string),
                  target: NotificationTarget(json["target"]), hasBody: json["has_body"].bool, body: json["body"].string.nonempty,
                  report: json["report"]["report_id"].string.nonempty.map {
                      NotificationReportRef(reportID: $0, expiresAt: ReviewDecoding.date(json["report"]["expires_at"].string), hosted: json["report"]["hosted"].bool)
                  },
                  repeatCount: json["repeat_count"].int)
        raw = json.setting("body", .null)
    }

    var isRead: Bool { readAt != nil }
    var isResolved: Bool { resolvedAt != nil }
    var isWaiting: Bool { kind.needsYou && resolvedAt == nil }
    /// Same rules as the daemon, for rows it did not serve (reports read offline).
    func matches(_ filter: NotificationFilter) -> Bool {
        switch filter {
        case .all: true
        case .needsYou: isWaiting
        case .bots: bot != nil || kind == .agentNotice
        }
    }

    func markedRead(at date: Date) -> NotificationRecord {
        var copy = self
        copy.readAt = date
        if raw != .null { copy.raw = raw.setting("read_at", .string(date.ISO8601Format())) }
        return copy
    }

    func markedUnread() -> NotificationRecord {
        var copy = self
        copy.readAt = nil
        if raw != .null { copy.raw = raw.setting("read_at", .null) }
        return copy
    }

    /// The thread a record came from, or the one it points at.
    var sourceThread: (workspaceID: String, threadID: String)? {
        if case .thread(let workspace, let thread)? = target { return (workspace, thread) }
        if let workspaceID, let threadID { return (workspaceID, threadID) }
        return nil
    }
    var action: NotificationAction {
        if hasBody || kind == .agentNotice { return .detail }
        switch target {
        case .review(let id): return .review(id)
        case .thread(let workspace, let thread): return .thread(workspaceID: workspace, threadID: thread)
        case nil: break
        }
        if let source = sourceThread { return .thread(workspaceID: source.workspaceID, threadID: source.threadID) }
        return .detail
    }
}

/// Counts across the whole store, whatever the filter.
struct NotificationCounts: Equatable, Sendable {
    var unread = 0
    var needsYou = 0
    /// Newest `seq`. Sent back as `up_to_seq`, so mark-all cannot swallow a
    /// record that arrived after James last looked. Never a count.
    var latestSeq = 0
    init(unread: Int = 0, needsYou: Int = 0, latestSeq: Int = 0) { self.unread = unread; self.needsYou = needsYou; self.latestSeq = latestSeq }
    init(_ json: JSON) {
        self.init(unread: json["unread_count"].int, needsYou: json["needs_you_count"].int, latestSeq: json["latest_seq"].int)
    }
}

struct NotificationListResponse: Equatable, Sendable {
    let items: [NotificationRecord]
    let nextBeforeSeq: Int?
    let counts: NotificationCounts
    init(_ json: JSON) {
        items = json["items"].array.compactMap(NotificationRecord.init)
        nextBeforeSeq = json["next_before_seq"].optionalInt
        counts = NotificationCounts(json)
    }
}

/// One day of the list.
struct NotificationDaySection: Identifiable, Equatable {
    let id: Date
    let title: String
    var records: [NotificationRecord]
}

enum NotificationDays {
    /// Groups records by the day they happened, newest day first. Records keep
    /// their order inside a day, which for daemon rows is `seq`.
    static func sections(_ records: [NotificationRecord], now: Date, calendar: Calendar = .current) -> [NotificationDaySection] {
        var sections: [NotificationDaySection] = []
        var positions: [Date: Int] = [:]
        for record in records {
            let day = calendar.startOfDay(for: record.createdAt)
            if let index = positions[day] { sections[index].records.append(record) }
            else {
                positions[day] = sections.count
                sections.append(NotificationDaySection(id: day, title: title(day, now: now, calendar: calendar), records: [record]))
            }
        }
        return sections.sorted { $0.id > $1.id }
    }
    static func title(_ day: Date, now: Date, calendar: Calendar = .current) -> String {
        let today = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: day, to: today).day ?? 0
        if days <= 0 { return "Today" }
        if days == 1 { return "Yesterday" }
        var style = Date.FormatStyle(timeZone: calendar.timeZone)
        style.calendar = calendar
        if days < 7 { return day.formatted(style.weekday(.wide)) }
        if calendar.component(.year, from: day) == calendar.component(.year, from: now) { return day.formatted(style.day().month(.abbreviated)) }
        return day.formatted(style.day().month(.abbreviated).year())
    }
}

/// What the detail screen opens: a record, its relay report, or both. A push
/// can arrive before the record has ever been loaded.
struct NotificationDetailTarget: Hashable, Identifiable, Sendable {
    let notificationID: String?
    let reportID: String?
    var id: String { notificationID ?? "report:\(reportID ?? "")" }
    init(notificationID: String?, reportID: String? = nil) { self.notificationID = notificationID; self.reportID = reportID }
    init(_ record: NotificationRecord) { self.init(notificationID: record.id, reportID: record.report?.reportID) }
}

/// What the detail screen shows.
struct NotificationDetail: Equatable, Sendable {
    var record: NotificationRecord?
    var body: String?
    /// The text came from the relay copy, because the computer is out of reach.
    var fromRelay = false
    /// The body exists but can only be read on the computer right now.
    var onComputer = false
}
