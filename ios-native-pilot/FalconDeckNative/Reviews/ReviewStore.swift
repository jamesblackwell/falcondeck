import Foundation
import Observation

/// Why a response was not accepted, in words James can act on.
enum ReviewFailure: LocalizedError, Equatable {
    /// The agent withdrew the review, or it was answered elsewhere, meanwhile.
    case closed(String)
    var errorDescription: String? { if case .closed(let message) = self { message } else { nil } }
}

/// Reviews for the paired computer, and what James has typed against them.
/// The daemon owns the records; nothing here is a second source of truth, so a
/// refresh always wins over what was loaded before.
@MainActor @Observable
final class ReviewStore {
    private(set) var reviews: [Review] = []
    private(set) var loaded = false
    private(set) var loading = false
    private(set) var refreshError: String?
    /// The computer does not know the review RPCs (an older daemon).
    private(set) var unsupported = false
    private(set) var drafts: [String: ReviewDraft] = [:]
    private(set) var submitting: Set<String> = []
    /// Reviews that closed while James was answering, with the daemon's reason.
    private(set) var closedWhileAnswering: [String: String] = [:]

    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var mutationRevision = 0
    @ObservationIgnored private var draftSaves: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var draftsRestored = false
    @ObservationIgnored private var vaultCache: ReviewDraftVault?
    @ObservationIgnored private let draftRoot: URL?
    @ObservationIgnored private var demoSeeded = false

    init(draftRoot: URL? = nil) { self.draftRoot = draftRoot }

    // MARK: Visibility

    /// `preferences.review_inbox_enabled`. An older daemon omits it, which hides
    /// the entry. The demo has no daemon to ask, so it shows the inbox unless
    /// the setting was explicitly turned off.
    static func isEnabled(preferences: JSON, demo: Bool) -> Bool {
        let flag = preferences["review_inbox_enabled"]
        return demo ? flag != .bool(false) : flag == .bool(true)
    }
    func entryVisible(model: AppModel) -> Bool {
        Self.isEnabled(preferences: model.preferences, demo: model.demo) && !unsupported
    }

    // MARK: Lists

    var openReviews: [Review] { reviews.filter(\.isOpen).sorted { $0.createdAt > $1.createdAt } }
    /// Recently answered reviews only; the inbox is for what is waiting.
    var answeredReviews: [Review] {
        Array(reviews.filter { !$0.isOpen }.sorted { ($0.respondedAt ?? $0.updatedAt) > ($1.respondedAt ?? $1.updatedAt) }.prefix(Self.answeredLimit))
    }
    var openCount: Int { reviews.filter(\.isOpen).count }
    static let answeredLimit = 10
    func review(_ id: String) -> Review? { reviews.first { $0.id == id } }

    // MARK: Lifecycle

    /// Called when a connection starts. A reconnect keeps what is on screen; a
    /// new pairing or the demo starts clean, and forgetting a computer also
    /// removes the notes typed against it.
    func reset(clearData: Bool, forgotten: Bool) {
        refreshTask?.cancel(); refreshTask = nil
        refreshAgain = false; mutationRevision += 1; generation += 1; loading = false
        guard clearData else { return }
        for task in draftSaves.values { task.cancel() }
        draftSaves = [:]
        reviews = []; loaded = false; refreshError = nil; unsupported = false
        drafts = [:]; submitting = []; closedWhileAnswering = [:]
        draftsRestored = false; vaultCache = nil; demoSeeded = false
        if forgotten { ReviewDraftVault.purge(root: draftRoot) }
    }

    // MARK: Fetching

    func refresh(model: AppModel) async {
        guard Self.isEnabled(preferences: model.preferences, demo: model.demo) else { return }
        guard !loading else { refreshAgain = true; return }
        let gen = generation, current = model.connectionID, started = mutationRevision
        loading = true; refreshError = nil
        defer {
            if gen == generation {
                loading = false
                if refreshAgain { refreshAgain = false; scheduleRefresh(model: model) }
            }
        }
        if model.demo {
            if !demoSeeded { demoSeeded = true; reviews = ReviewDemo.reviews(now: .now) }
            loaded = true
            return
        }
        guard model.connected else { return }
        await restoreDrafts(model: model)
        do {
            async let open = model.relay.call("reviews.list", params: Self.listParameters(includeClosed: false, limit: 100))
            // Answered reviews are a courtesy; their failure must not hide the open ones.
            async let recent: JSON? = try? await model.relay.call("reviews.list", params: Self.listParameters(includeClosed: true, limit: 30))
            let (openResponse, recentResponse) = try await (open, recent)
            guard current == model.connectionID, gen == generation else { return }
            // A response captured before James answered cannot reopen that review.
            guard started == mutationRevision else { refreshAgain = true; return }
            let openRows = ReviewDecoding.reviews(openResponse["data"]).filter(\.isOpen)
            let closedRows = recentResponse.map { ReviewDecoding.reviews($0["data"]).filter { !$0.isOpen } } ?? reviews.filter { !$0.isOpen }
            reviews = openRows + closedRows
            loaded = true; unsupported = false
            // A review that vanished keeps no orphan notes; one that closed keeps them to read.
            for id in drafts.keys where !reviews.contains(where: { $0.id == id }) { discardDraft(id, model: model) }
        } catch {
            guard current == model.connectionID, gen == generation else { return }
            if Self.looksUnsupported(error) { unsupported = true; reviews = [] }
            else if !loaded { refreshError = "Couldn't load reviews. Pull to refresh." }
        }
    }

    func scheduleRefresh(model: AppModel) {
        guard refreshTask == nil else { return }
        let gen = generation
        refreshTask = Task {
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard gen == self.generation else { return }
            self.refreshTask = nil
            await self.refresh(model: model)
        }
    }

    /// The `control-state-changed` event names the domains that moved.
    func controlStateChanged(_ event: JSON, model: AppModel) {
        guard event["change"]["domains"].array.contains(.string("reviews")),
              Self.isEnabled(preferences: model.preferences, demo: model.demo) else { return }
        scheduleRefresh(model: model)
    }

    static func listParameters(includeClosed: Bool, limit: Int) -> JSON {
        .object(["filters": .object(includeClosed ? ["include_closed": .bool(true)] : [:]), "limit": .number(Double(limit))])
    }
    /// An older daemon answers an unknown RPC with an error naming the method.
    static func looksUnsupported(_ error: Error) -> Bool {
        let text = error.localizedDescription.lowercased()
        return ["unknown method", "unknown rpc", "unsupported", "not supported", "unrecognized", "no such method", "method not found"].contains { text.contains($0) }
    }

    // MARK: Drafts

    func draft(for id: String) -> ReviewDraft { drafts[id] ?? ReviewDraft() }

    /// Edits one review's draft. It lives in memory (so leaving the screen keeps
    /// it) and, when paired, in an encrypted device file (so relaunching does).
    func edit(_ id: String, model: AppModel, _ change: (inout ReviewDraft) -> Void) {
        var draft = self.draft(for: id)
        change(&draft)
        drafts[id] = draft.isEmpty ? nil : draft
        scheduleDraftSave(id, draft: draft, model: model)
    }

    /// Writes one review's notes now. Dictation waits on this before its audio is deleted.
    func persistNow(_ id: String, model: AppModel) async -> Bool {
        guard !model.demo else { return true }
        draftSaves[id]?.cancel(); draftSaves[id] = nil
        guard let vault = await vault(model: model) else { return false }
        do { try await vault.save(draft(for: id), reviewID: id); return true } catch { return false }
    }

    func discardDraft(_ id: String, model: AppModel) {
        drafts[id] = nil; closedWhileAnswering[id] = nil
        scheduleDraftSave(id, draft: ReviewDraft(), model: model)
    }

    private func scheduleDraftSave(_ id: String, draft: ReviewDraft, model: AppModel) {
        guard !model.demo else { return }
        draftSaves[id]?.cancel()
        let gen = generation
        draftSaves[id] = Task {
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard gen == self.generation else { return }
            let lease = model.backgroundExecution.begin("Save review notes")
            defer { lease.finish() }
            guard let vault = await self.vault(model: model), gen == self.generation else { return }
            try? await vault.save(draft, reviewID: id)
        }
    }

    /// Notes typed before the app last closed, unless James already typed more.
    func restoreDrafts(model: AppModel) async {
        guard !draftsRestored, !model.demo else { return }
        draftsRestored = true
        let gen = generation
        guard let vault = await vault(model: model), gen == generation else { draftsRestored = false; return }
        let saved = await vault.load()
        guard gen == generation else { return }
        for (id, draft) in saved where drafts[id] == nil && !draft.isEmpty { drafts[id] = draft }
    }

    private func vault(model: AppModel) async -> ReviewDraftVault? {
        if let vaultCache { return vaultCache }
        let loader = model.sessionLoader
        guard let session = await Task.detached(priority: .userInitiated, operation: { try? loader() }).value,
              let vault = ReviewDraftVault(session: session, root: draftRoot) else { return nil }
        vaultCache = vault
        return vault
    }

    // MARK: Responding

    /// Sends the draft. On failure the draft is untouched, so nothing typed is lost.
    @discardableResult
    func respond(_ id: String, model: AppModel) async throws -> Review {
        guard let review = review(id) else { throw PilotError("This review is no longer available.") }
        guard !submitting.contains(id) else { throw CancellationError() }
        let draft = self.draft(for: id).pruned(to: review)
        guard let request = draft.request(for: review) else { throw PilotError("Choose a decision for every item first.") }
        submitting.insert(id); closedWhileAnswering[id] = nil
        defer { submitting.remove(id) }
        let updated: Review
        if model.demo {
            updated = ReviewDemo.respond(review, request, now: .now)
        } else {
            let current = model.connectionID
            let result = try await model.relay.call("review.respond", params: request.json)
            guard current == model.connectionID else { throw CancellationError() }
            guard result["ok"].bool else {
                let failure = result["error"]
                let message = failure["suggested_action"].string.nonempty ?? failure["message"].string.nonempty ?? "The response could not be sent."
                if failure["code"].string == "review_closed" {
                    await fetchOne(id, model: model)
                    closedWhileAnswering[id] = failure["message"].string.nonempty ?? "This review is already closed."
                    throw ReviewFailure.closed(closedWhileAnswering[id] ?? message)
                }
                throw PilotError(message)
            }
            guard let decoded = ReviewDecoding.review(result["data"]) else {
                // The computer accepted it; show what it holds rather than a guess.
                await fetchOne(id, model: model)
                guard let confirmed = self.review(id), !confirmed.isOpen else { throw PilotError("Your response was sent. Pull to refresh to see it here.") }
                finishDraft(id, model: model)
                return confirmed
            }
            updated = decoded
        }
        mutationRevision += 1
        replace(updated)
        finishDraft(id, model: model)
        if !model.demo { scheduleRefresh(model: model) }
        return updated
    }

    private func finishDraft(_ id: String, model: AppModel) {
        drafts[id] = nil
        scheduleDraftSave(id, draft: ReviewDraft(), model: model)
    }

    private func replace(_ review: Review) {
        if let index = reviews.firstIndex(where: { $0.id == review.id }) { reviews[index] = review } else { reviews.append(review) }
    }

    /// One record by id, for when a response races a withdrawal.
    private func fetchOne(_ id: String, model: AppModel) async {
        let current = model.connectionID
        guard let result = try? await model.relay.call("review.get", params: .object(["id": .string(id)])),
              current == model.connectionID, let review = ReviewDecoding.review(result["data"]) else { return }
        mutationRevision += 1
        replace(review)
    }
}

@MainActor extension AppModel {
    /// The mark for a bot named on a review. A bot the app knows keeps its own
    /// mark; an unknown name gets a stable one so the same bot always looks alike.
    func reviewBotIcon(named name: String) -> NativeBotIcon {
        if let bot = bots.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }), let icon = botIcons[bot.id] { return icon }
        return ReviewBotMarks.fallback(for: name)
    }
}

enum ReviewBotMarks {
    static func fallback(for name: String) -> NativeBotIcon {
        // FNV-1a: stable across launches, unlike Swift's seeded hashValue.
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in name.lowercased().utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        let shapes = NativeBotIcon.shapes, colors = NativeBotIcon.colors
        return NativeBotIcon(shape: shapes[Int(hash % UInt64(shapes.count))], color: colors[Int((hash >> 8) % UInt64(colors.count))])
    }
}
