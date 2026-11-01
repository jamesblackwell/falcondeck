import Foundation

/// What James has chosen and typed so far. Pure value, so validation and the
/// request it produces are testable without a daemon. Mirrors
/// `client-core/src/reviews.ts` (`itemsAwaitingDecision`, `buildRespondArgs`).
struct ReviewDraft: Codable, Equatable, Sendable {
    struct Entry: Codable, Equatable, Sendable {
        var decision: ReviewDecision?
        var feedback = ""
    }
    var items: [String: Entry] = [:]
    var overallDecision: ReviewDecision?
    var overallNote = ""

    var isEmpty: Bool {
        overallDecision == nil && overallNote.trimmed.isEmpty && items.values.allSatisfy { $0.decision == nil && $0.feedback.trimmed.isEmpty }
    }

    func decision(for itemID: String) -> ReviewDecision? { items[itemID]?.decision }
    func feedback(for itemID: String) -> String { items[itemID]?.feedback ?? "" }

    /// Tapping the chosen decision again takes it back.
    mutating func choose(_ decision: ReviewDecision, for itemID: String) {
        var entry = items[itemID] ?? Entry()
        entry.decision = entry.decision == decision ? nil : decision
        items[itemID] = entry
    }
    mutating func setFeedback(_ text: String, for itemID: String) {
        var entry = items[itemID] ?? Entry()
        entry.feedback = text
        items[itemID] = entry
    }
    mutating func chooseOverall(_ decision: ReviewDecision) {
        overallDecision = overallDecision == decision ? nil : decision
    }

    /// Items still lacking a decision: their own, or an overall one.
    func awaiting(in review: Review) -> [ReviewItem] {
        if overallDecision != nil { return [] }
        return review.items.filter { decision(for: $0.id) == nil }
    }
    func isComplete(for review: Review) -> Bool { review.isOpen && !review.items.isEmpty && awaiting(in: review).isEmpty }
    /// Items James decided himself.
    func decidedCount(in review: Review) -> Int { review.items.filter { decision(for: $0.id) != nil }.count }

    /// The decision an item will carry: its own, else the overall one.
    func effectiveDecision(for itemID: String) -> ReviewDecision? { decision(for: itemID) ?? overallDecision }

    /// A short line for the submit bar: what is still missing, or that it is ready.
    func statusLine(for review: Review) -> String {
        let missing = awaiting(in: review)
        if missing.isEmpty {
            if let overall = overallDecision, decidedCount(in: review) < review.items.count { return "Ready · \(overall.pastTense.lowercased()) for the rest" }
            return "Ready to send"
        }
        let names = missing.prefix(2).map(\.title).joined(separator: ", ")
        let more = missing.count > 2 ? " and \(missing.count - 2) more" : ""
        return "Needs a decision on \(names)\(more)"
    }

    /// Keeps only what still belongs to the review: items an agent removed or
    /// that never existed cannot be sent.
    func pruned(to review: Review) -> ReviewDraft {
        var copy = self
        let ids = Set(review.items.map(\.id))
        copy.items = items.filter { ids.contains($0.key) }
        return copy
    }

    /// The `review.respond` arguments, or nil until the draft is complete.
    func request(for review: Review) -> ReviewResponseRequest? {
        guard isComplete(for: review) else { return nil }
        var responses: [ReviewResponseRequest.Item] = []
        for item in review.items {
            let text = feedback(for: item.id).trimmed
            if let own = decision(for: item.id) {
                responses.append(.init(itemID: item.id, decision: own, feedback: text.nonempty))
            } else if let overall = overallDecision, !text.isEmpty {
                // The daemon only keeps feedback that arrives with an item response, so
                // an item with words but no verdict of its own carries the overall one.
                responses.append(.init(itemID: item.id, decision: overall, feedback: text))
            }
        }
        return ReviewResponseRequest(reviewID: review.id, items: responses, decision: overallDecision, note: overallNote.trimmed.nonempty)
    }
}

struct ReviewResponseRequest: Equatable, Sendable {
    struct Item: Equatable, Sendable {
        var itemID: String
        var decision: ReviewDecision
        var feedback: String?
    }
    var reviewID: String
    var items: [Item]
    var decision: ReviewDecision?
    var note: String?

    var json: JSON {
        var fields: [String: JSON] = ["review_id": .string(reviewID)]
        if !items.isEmpty {
            fields["items"] = .array(items.map { item in
                var entry: [String: JSON] = ["item_id": .string(item.itemID), "decision": .string(item.decision.rawValue)]
                if let feedback = item.feedback { entry["feedback"] = .string(feedback) }
                return .object(entry)
            })
        }
        if let decision { fields["decision"] = .string(decision.rawValue) }
        if let note { fields["note"] = .string(note) }
        return .object(fields)
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
