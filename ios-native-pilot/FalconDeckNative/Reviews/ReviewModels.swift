import Foundation

// The review inbox's wire types (docs/REVIEWS.md). The daemon owns the record;
// this client only reads it and answers it.

enum ReviewStatus: String, Codable, Sendable, CaseIterable {
    case open, approved, changesRequested = "changes_requested", rejected, withdrawn
    var isOpen: Bool { self == .open }
    var title: String {
        switch self {
        case .open: "Open"
        case .approved: "Approved"
        case .changesRequested: "Changes requested"
        case .rejected: "Rejected"
        case .withdrawn: "Withdrawn"
        }
    }
}

enum ReviewDecision: String, Codable, Sendable, CaseIterable {
    case approve, requestChanges = "request_changes", reject
    var title: String {
        switch self {
        case .approve: "Approve"
        case .requestChanges: "Request changes"
        case .reject: "Reject"
        }
    }
    /// What the response summary calls it, after "Result:".
    var pastTense: String {
        switch self {
        case .approve: "Approved"
        case .requestChanges: "Changes requested"
        case .reject: "Rejected"
        }
    }
    var symbol: String {
        switch self {
        case .approve: "hand.thumbsup"
        case .requestChanges: "arrow.uturn.backward"
        case .reject: "xmark"
        }
    }
}

enum ReviewEvidenceKind: String, Codable, Sendable { case file, image, url }

struct ReviewEvidence: Identifiable, Hashable, Sendable, Decodable {
    let id: String
    var kind: ReviewEvidenceKind
    var title: String?
    var caption: String?
    /// Absolute path on the computer to read with `file.stat`/`file.read_range`.
    var openPath: String?
    var originalPath: String?
    var snapshotted: Bool
    var url: String?
    var contentType: String?
    var sizeBytes: Int?

    private enum CodingKeys: String, CodingKey {
        case id, kind, title, caption, openPath = "open_path", originalPath = "original_path", snapshotted, url
        case contentType = "content_type", sizeBytes = "size_bytes"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        // A kind from a newer daemon still opens as a file.
        kind = (try? c.decode(ReviewEvidenceKind.self, forKey: .kind)) ?? .file
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        caption = try? c.decodeIfPresent(String.self, forKey: .caption)
        openPath = try? c.decodeIfPresent(String.self, forKey: .openPath)
        originalPath = try? c.decodeIfPresent(String.self, forKey: .originalPath)
        snapshotted = (try? c.decodeIfPresent(Bool.self, forKey: .snapshotted)) ?? false
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        contentType = try? c.decodeIfPresent(String.self, forKey: .contentType)
        sizeBytes = try? c.decodeIfPresent(Int.self, forKey: .sizeBytes)
    }
    init(id: String, kind: ReviewEvidenceKind, title: String? = nil, caption: String? = nil, openPath: String? = nil, originalPath: String? = nil,
         snapshotted: Bool = true, url: String? = nil, contentType: String? = nil, sizeBytes: Int? = nil) {
        self.id = id; self.kind = kind; self.title = title; self.caption = caption; self.openPath = openPath
        self.originalPath = originalPath; self.snapshotted = snapshotted; self.url = url; self.contentType = contentType; self.sizeBytes = sizeBytes
    }

    /// What to call it: the agent's title, else the file name or link host.
    var displayName: String {
        if let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        if kind == .url, let url, let host = URL(string: url)?.host { return host }
        if let path = openPath ?? originalPath, !path.isEmpty { return (path as NSString).lastPathComponent }
        if let url, let host = URL(string: url)?.host { return host }
        return kind == .url ? "Link" : "Attachment"
    }
    var linkURL: URL? {
        guard kind == .url, let url, let parsed = URL(string: url), ["http", "https"].contains(parsed.scheme?.lowercased() ?? "") else { return nil }
        return parsed
    }
    /// The file to hand to the viewer. Only the path matters: the daemon already
    /// froze a copy under its own review folder.
    func reference(workspaceID: String?, threadID: String?) -> FileReference? {
        guard kind != .url, let path = openPath, !path.isEmpty else { return nil }
        return FileReference(path: path, workspaceID: workspaceID, threadID: threadID)
    }
}

struct ReviewItem: Identifiable, Hashable, Sendable, Decodable {
    let id: String
    var title: String
    var note: String
    var evidence: [ReviewEvidence]
    var decision: ReviewDecision?
    var feedback: String?

    private enum CodingKeys: String, CodingKey { case id, title, note, evidence, decision, feedback }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        note = (try? c.decodeIfPresent(String.self, forKey: .note)) ?? ""
        evidence = (try? c.decodeIfPresent([ReviewEvidence].self, forKey: .evidence)) ?? []
        decision = try? c.decodeIfPresent(ReviewDecision.self, forKey: .decision)
        feedback = try? c.decodeIfPresent(String.self, forKey: .feedback)
    }
    init(id: String, title: String, note: String = "", evidence: [ReviewEvidence] = [], decision: ReviewDecision? = nil, feedback: String? = nil) {
        self.id = id; self.title = title; self.note = note; self.evidence = evidence; self.decision = decision; self.feedback = feedback
    }
}

/// Whether James's reply reached the agent. Tagged by `state`.
enum ReviewDelivery: Hashable, Sendable, Decodable {
    case delivered(at: Date)
    case failed(at: Date, error: String)

    private enum CodingKeys: String, CodingKey { case state, at, error }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let at = (try? c.decode(Date.self, forKey: .at)) ?? .distantPast
        switch try c.decode(String.self, forKey: .state) {
        case "delivered": self = .delivered(at: at)
        case "failed": self = .failed(at: at, error: (try? c.decodeIfPresent(String.self, forKey: .error)) ?? "")
        case let other: throw DecodingError.dataCorruptedError(forKey: .state, in: c, debugDescription: "Unknown delivery state \(other)")
        }
    }
    var failed: Bool { if case .failed = self { true } else { false } }
}

struct Review: Identifiable, Hashable, Sendable, Decodable {
    let id: String
    var title: String
    var ask: String
    var recommendation: String
    var goingAheadAt: Date?
    var body: String
    var status: ReviewStatus
    var items: [ReviewItem]
    var sourceThreadID: String?
    var sourceWorkspaceID: String?
    var bot: String?
    var createdAt: Date
    var updatedAt: Date
    var respondedAt: Date?
    var overallDecision: ReviewDecision?
    var overallNote: String?
    var delivery: ReviewDelivery?

    private enum CodingKeys: String, CodingKey {
        case id, title, ask, recommendation, body, status, items, bot, delivery
        case goingAheadAt = "going_ahead_at", sourceThreadID = "source_thread_id", sourceWorkspaceID = "source_workspace_id"
        case createdAt = "created_at", updatedAt = "updated_at", respondedAt = "responded_at"
        case overallDecision = "overall_decision", overallNote = "overall_note"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        ask = (try? c.decodeIfPresent(String.self, forKey: .ask)) ?? ""
        recommendation = (try? c.decodeIfPresent(String.self, forKey: .recommendation)) ?? ""
        goingAheadAt = try? c.decodeIfPresent(Date.self, forKey: .goingAheadAt)
        body = (try? c.decodeIfPresent(String.self, forKey: .body)) ?? ""
        status = try c.decode(ReviewStatus.self, forKey: .status)
        items = try c.decode([ReviewItem].self, forKey: .items)
        sourceThreadID = try? c.decodeIfPresent(String.self, forKey: .sourceThreadID)
        sourceWorkspaceID = try? c.decodeIfPresent(String.self, forKey: .sourceWorkspaceID)
        bot = try? c.decodeIfPresent(String.self, forKey: .bot)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = (try? c.decode(Date.self, forKey: .updatedAt)) ?? createdAt
        respondedAt = try? c.decodeIfPresent(Date.self, forKey: .respondedAt)
        overallDecision = try? c.decodeIfPresent(ReviewDecision.self, forKey: .overallDecision)
        overallNote = try? c.decodeIfPresent(String.self, forKey: .overallNote)
        // A delivery state this client does not know is shown as no delivery news.
        delivery = try? c.decodeIfPresent(ReviewDelivery.self, forKey: .delivery)
    }
    init(id: String, title: String, ask: String, recommendation: String, goingAheadAt: Date? = nil, body: String = "", status: ReviewStatus = .open,
         items: [ReviewItem], sourceThreadID: String? = nil, sourceWorkspaceID: String? = nil, bot: String? = nil, createdAt: Date, updatedAt: Date? = nil,
         respondedAt: Date? = nil, overallDecision: ReviewDecision? = nil, overallNote: String? = nil, delivery: ReviewDelivery? = nil) {
        self.id = id; self.title = title; self.ask = ask; self.recommendation = recommendation; self.goingAheadAt = goingAheadAt; self.body = body
        self.status = status; self.items = items; self.sourceThreadID = sourceThreadID; self.sourceWorkspaceID = sourceWorkspaceID; self.bot = bot
        self.createdAt = createdAt; self.updatedAt = updatedAt ?? createdAt; self.respondedAt = respondedAt
        self.overallDecision = overallDecision; self.overallNote = overallNote; self.delivery = delivery
    }

    var isOpen: Bool { status.isOpen }
    var botName: String? { bot?.trimmingCharacters(in: .whitespacesAndNewlines).nonempty }
    var deliveryFailed: Bool { delivery?.failed ?? false }
    /// "3 items", for list rows.
    var itemCountLabel: String { items.count == 1 ? "1 item" : "\(items.count) items" }

    /// One line saying what James decided, for answered rows.
    var outcomeSummary: String {
        if isOpen { return "Waiting on you" }
        var counts: [ReviewDecision: Int] = [:]
        for item in items { if let decision = item.decision { counts[decision, default: 0] += 1 } }
        let parts = ReviewDecision.allCases.compactMap { decision in
            counts[decision].map { count in
                let words = decision == .requestChanges && count == 1 ? "change requested" : decision.pastTense.lowercased()
                return "\(count) \(words)"
            }
        }
        return parts.isEmpty ? status.title : parts.joined(separator: ", ")
    }
}

enum ReviewDecoding {
    /// RFC 3339 with or without fractional seconds, as chrono writes it.
    static func date(_ text: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text)) ?? (try? Date.ISO8601FormatStyle().parse(text))
    }
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = ReviewDecoding.date(text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid date \(text)"))
            }
            return date
        }
        return decoder
    }()
    static func review(_ json: JSON) -> Review? {
        guard let data = try? json.data() else { return nil }
        return try? decoder.decode(Review.self, from: data)
    }
    /// A record this client cannot read is skipped; it never hides the others.
    static func reviews(_ json: JSON) -> [Review] { json.array.compactMap(review) }
}
