import Foundation
import Observation

/// A report's Markdown body lives only on the daemon that recorded it.
@MainActor @Observable final class NotificationReportModel {
    private(set) var record: NotificationRecord?
    private(set) var error: String?
    private(set) var isLoading = false

    func load(id: String, hostID: String?, centre: NotificationCentreStore) async {
        isLoading = true
        defer { isLoading = false }
        do {
            record = try await centre.record(id: id, hostID: hostID)
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = (error as? PilotError)?.status == 404
                ? "This report is no longer available." : "Couldn’t load this report. \(error.localizedDescription)"
        }
    }
}

enum NotificationReviewDecision: String, CaseIterable, Identifiable, Sendable {
    case approve, requestChanges = "request_changes", reject
    var id: String { rawValue }
    var title: String {
        switch self {
        case .approve: "Approve"
        case .requestChanges: "Request changes"
        case .reject: "Reject"
        }
    }
}

struct NotificationReviewEvidence: Identifiable, Equatable {
    let raw: JSON
    var id: String { raw["id"].string }
    /// The agent's label, else whatever names the thing.
    var name: String {
        if let title = raw["title"].string.nonempty { return title }
        if let path = raw["original_path"].string.nonempty { return (path as NSString).lastPathComponent }
        return raw["url"].string.nonempty ?? "Evidence"
    }
    var symbol: String {
        switch raw["kind"].string {
        case "image": "photo"
        case "url": "link"
        default: "doc"
        }
    }
}

struct NotificationReviewItem: Identifiable, Equatable {
    let raw: JSON
    var id: String { raw["id"].string }
    var title: String { raw["title"].string }
    var note: String { raw["note"].string }
    var feedback: String { raw["feedback"].string }
    var evidence: [NotificationReviewEvidence] { raw["evidence"].array.map(NotificationReviewEvidence.init) }
}

struct NotificationReviewRecord: Equatable {
    let raw: JSON
    init(_ value: JSON) { raw = value }
    var id: String { raw["id"].string }
    var title: String { raw["title"].string }
    var ask: String { raw["ask"].string }
    var recommendation: String { raw["recommendation"].string }
    var body: String { raw["body"].string }
    var bot: String? { raw["bot"].string.nonempty }
    var status: String { raw["status"].string }
    var isOpen: Bool { status == "open" }
    var goingAheadAt: String? { raw["going_ahead_at"].string.nonempty }
    var overallNote: String? { raw["overall_note"].string.nonempty }
    var deliveryError: String? { raw["delivery"]["state"].string == "failed" ? raw["delivery"]["error"].string : nil }
    var items: [NotificationReviewItem] { raw["items"].array.map(NotificationReviewItem.init) }
    var sourceTaskID: String? { raw["source_thread_id"].string.nonempty }
    var statusTitle: String {
        switch status {
        case "open": "Waiting for you"
        case "approved": "Approved"
        case "changes_requested": "Changes requested"
        case "rejected": "Rejected"
        case "withdrawn": "Withdrawn"
        default: status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

/// One review, as the daemon has it. Answering is overall only here; per-item
/// decisions and evidence previews belong to a full Reviews view.
@MainActor @Observable final class NotificationReviewModel {
    private(set) var review: NotificationReviewRecord?
    private(set) var loadError: String?
    private(set) var responseError: String?
    private(set) var submitting: NotificationReviewDecision?
    var note = ""

    @ObservationIgnored private let id: String
    @ObservationIgnored private let hostID: String?
    @ObservationIgnored private let transport: NotificationCentreStore.Transport
    @ObservationIgnored private var loadRevision = 0

    init(id: String, hostID: String?, transport: @escaping NotificationCentreStore.Transport) {
        self.id = id
        self.hostID = hostID
        self.transport = transport
    }

    func load() async {
        loadRevision += 1
        let revision = loadRevision
        do {
            let response = try await transport(["api", "reviews", id], "GET", [], nil, hostID)
            // A read that began before an answer must not reopen the review.
            guard revision == loadRevision else { return }
            guard !response["data"]["id"].string.isEmpty else { throw PilotError("The daemon did not return this review.") }
            review = NotificationReviewRecord(response["data"])
            loadError = nil
        } catch {
            guard revision == loadRevision, review == nil else { return }
            loadError = (error as? PilotError)?.status == 404
                ? "This review is no longer available." : "Couldn’t load this review. \(error.localizedDescription)"
        }
    }

    func respond(_ decision: NotificationReviewDecision) async {
        guard submitting == nil else { return }
        submitting = decision
        responseError = nil
        loadRevision += 1
        defer { submitting = nil }
        var body: [String: JSON] = ["decision": .string(decision.rawValue)]
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { body["note"] = .string(trimmed) }
        do {
            // Control mutations report failure inside a 200 envelope.
            let response = try await transport(["api", "reviews", id, "respond"], "POST", [], .object(body), hostID)
            guard response["ok"].bool else {
                responseError = response["error"]["message"].string.nonempty ?? "The response wasn’t accepted."
                await load()
                return
            }
            note = ""
            if response["data"]["id"].string.isEmpty { await load() }
            else {
                // A read that began while the answer was on its way is older than this.
                loadRevision += 1
                review = NotificationReviewRecord(response["data"])
            }
        } catch {
            responseError = "The response wasn’t sent. \(error.localizedDescription)"
            await load()
        }
    }
}
