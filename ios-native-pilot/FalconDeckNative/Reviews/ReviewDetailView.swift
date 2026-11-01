import SwiftUI

/// One review: the question and recommendation, then each item as a card with
/// its evidence, a decision and feedback, and a submit bar that stays in reach.
struct ReviewDetailView: View {
    let reviewID: String
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var overallOpen = false
    @State private var submitError: String?
    @State private var sent = 0
    @FocusState private var focus: String?
    private var store: ReviewStore { model.reviews }

    var body: some View {
        Group {
            if let review = store.review(reviewID) { content(review) }
            else if store.loaded || store.loading {
                ContentUnavailableView("Review not found", systemImage: "questionmark.folder", description: Text("It may have been removed on your computer."))
            } else { HStack(spacing: 8) { ActivityDiamond(); Text("Loading…").font(.footnote).foregroundStyle(FD.secondary) } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).background(FD.background)
        .navigationTitle("Review").navigationBarTitleDisplayMode(.inline)
        .task { await store.refresh(model: model) }
        .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { focus = nil } } }
        .onAppear { MinuteClock.shared.start() }
    }

    @ViewBuilder private func content(_ review: Review) -> some View {
        let draft = store.draft(for: review.id)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ReviewHeader(review: review).id("top")
                    if !review.isOpen { ReviewClosedBanner(review: review) }
                    if !review.recommendation.isEmpty { ReviewRecommendation(text: review.recommendation) }
                    if !review.body.isEmpty {
                        NativeMarkdown(text: review.body, font: .subheadline, foreground: FD.body)
                            .environment(\.fileContext, FileContext(workspaceID: review.sourceWorkspaceID, threadID: review.sourceThreadID))
                            .accessibilityIdentifier("review-body")
                    }
                    Text("Items · \(review.items.count)").reviewCaption().padding(.top, 2)
                    ForEach(Array(review.items.enumerated()), id: \.element.id) { index, item in
                        ReviewItemCard(review: review, item: item, index: index, focus: $focus)
                    }
                    if review.isOpen { overall(review, draft: draft) }
                    else { ReviewOutcomeNote(review: review) }
                    if !review.isOpen, !draft.isEmpty { ReviewUnsentNotes(review: review, draft: draft) }
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 28).frame(maxWidth: 720).frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively).accessibilityIdentifier("review-screen")
            .onChange(of: sent) { _, _ in withAnimation { proxy.scrollTo("top", anchor: .top) } }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if review.isOpen {
                ReviewSubmitBar(review: review, draft: draft, submitting: store.submitting.contains(review.id), error: $submitError,
                                connected: model.connected || model.demo) { submit(review) }
            }
        }
    }

    // MARK: Whole-review answer

    @ViewBuilder private func overall(_ review: Review, draft: ReviewDraft) -> some View {
        let expanded = overallOpen || draft.overallDecision != nil || !draft.overallNote.isEmpty
        VStack(alignment: .leading, spacing: 12) {
            Button { withAnimation(.snappy) { overallOpen.toggle() } } label: {
                HStack(spacing: 10) {
                    Image(systemName: "checklist").foregroundStyle(FD.accent).frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Answer everything at once").font(.subheadline.weight(.semibold)).foregroundStyle(FD.foreground)
                        Text("One decision for items you don't answer one by one.").font(.caption).foregroundStyle(FD.secondary).multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 4)
                    NativeDisclosureChevron(expanded: expanded).foregroundStyle(FD.muted)
                }.frame(minHeight: 44).contentShape(.rect)
            }.buttonStyle(.plain).accessibilityIdentifier("review-overall-toggle").accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded {
                ReviewDecisionChips(selected: draft.overallDecision, identifier: "review-overall-decision") { decision in
                    store.edit(review.id, model: model) { $0.chooseOverall(decision) }
                }
                ReviewFeedbackField(
                    text: Binding(get: { store.draft(for: review.id).overallNote }, set: { value in store.edit(review.id, model: model) { $0.overallNote = value } }),
                    prompt: "A note on the whole review (optional)", dictationKey: "review:\(review.id):overall", identifier: "review-overall-note",
                    focus: $focus, persist: { await store.persistNow(review.id, model: model) })
            }
        }
        .padding(16).background(FD.surface, in: .rect(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(FD.hairline))
    }

    private func submit(_ review: Review) {
        focus = nil; submitError = nil
        Task {
            do { try await store.respond(review.id, model: model); sent += 1 }
            catch is CancellationError { }
            catch let failure as ReviewFailure { submitError = failure.localizedDescription }
            catch { submitError = error.localizedDescription }
        }
    }
}

private struct ReviewHeader: View {
    let review: Review
    private let clock = MinuteClock.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ReviewSender(name: review.botName)
                Text("·").foregroundStyle(FD.muted)
                Text("\(review.id) · \(ReviewFormat.age(review.createdAt, now: clock.now))").font(.caption).foregroundStyle(FD.muted)
            }
            Text(review.title).font(.title2.weight(.bold)).foregroundStyle(FD.foreground).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader).accessibilityIdentifier("review-title")
            if !review.ask.isEmpty {
                Text(review.ask).font(.headline).foregroundStyle(FD.body).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("review-ask")
            }
            if review.isOpen, let at = review.goingAheadAt {
                Label("\(ReviewFormat.goingAhead(at, now: clock.now)) unless you say no", systemImage: "clock")
                    .font(.footnote.weight(.medium)).foregroundStyle(FD.warning)
                    .padding(.horizontal, 10).padding(.vertical, 6).background(FD.warning.opacity(0.12), in: .capsule)
                    .accessibilityIdentifier("review-going-ahead")
            }
        }
    }
}

private struct ReviewRecommendation: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Recommendation", systemImage: "hand.thumbsup").reviewCaption()
            Text(text).font(.subheadline).foregroundStyle(FD.foreground).fixedSize(horizontal: false, vertical: true)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(FD.accent.opacity(0.10), in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(FD.accent.opacity(0.28)))
        .accessibilityElement(children: .combine).accessibilityIdentifier("review-recommendation")
    }
}

// MARK: Items

private struct ReviewItemCard: View {
    @Environment(AppModel.self) private var model
    let review: Review
    let item: ReviewItem
    let index: Int
    var focus: FocusState<String?>.Binding
    private var store: ReviewStore { model.reviews }

    var body: some View {
        let draft = store.draft(for: review.id)
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Item \(index + 1) of \(review.items.count)").reviewCaption()
                Spacer(minLength: 4)
                if review.isOpen, let decision = draft.decision(for: item.id) {
                    Label(decision.pastTense, systemImage: "checkmark").font(.caption.weight(.semibold)).foregroundStyle(decision.tint)
                }
            }
            Text(item.title).font(.headline).foregroundStyle(FD.foreground).fixedSize(horizontal: false, vertical: true)
            if !item.note.isEmpty { Text(item.note).font(.subheadline).foregroundStyle(FD.body).fixedSize(horizontal: false, vertical: true) }
            if !item.evidence.isEmpty { ReviewEvidenceGallery(review: review, item: item) }
            if review.isOpen {
                ReviewDecisionChips(selected: draft.decision(for: item.id), identifier: "review-decision-\(item.id)") { decision in
                    store.edit(review.id, model: model) { $0.choose(decision, for: item.id) }
                }
                if draft.decision(for: item.id) == nil, let overall = draft.overallDecision {
                    Text("Will use your overall answer: \(overall.pastTense.lowercased())").font(.caption).foregroundStyle(overall.tint)
                }
                ReviewFeedbackField(
                    text: Binding(get: { store.draft(for: review.id).feedback(for: item.id) }, set: { value in store.edit(review.id, model: model) { $0.setFeedback(value, for: item.id) } }),
                    prompt: review.botName.map { "Feedback for \($0) (optional)" } ?? "Feedback (optional)",
                    dictationKey: "review:\(review.id):\(item.id)", identifier: "review-feedback-\(item.id)", focus: focus,
                    persist: { await store.persistNow(review.id, model: model) })
            } else { ReviewAnsweredItem(item: item, overall: review.overallDecision) }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(FD.surface, in: .rect(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(FD.hairline))
        .accessibilityElement(children: .contain).accessibilityIdentifier("review-item-\(item.id)")
    }
}

private struct ReviewAnsweredItem: View {
    let item: ReviewItem
    let overall: ReviewDecision?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let decision = item.decision {
                Label(decision.pastTense, systemImage: decision.symbol).font(.subheadline.weight(.semibold)).foregroundStyle(decision.tint)
                    .padding(.horizontal, 12).padding(.vertical, 8).background(decision.tint.opacity(0.14), in: .capsule)
                    .accessibilityIdentifier("review-answer-\(item.id)")
            }
            if let feedback = item.feedback?.nonempty {
                Text(feedback).font(.subheadline).foregroundStyle(FD.foreground).fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 12).overlay(alignment: .leading) { Rectangle().fill(FD.line).frame(width: 2) }
            }
        }
    }
}

// MARK: Closed state

private struct ReviewClosedBanner: View {
    let review: Review
    private let clock = MinuteClock.shared
    private var who: String { review.botName ?? "the agent" }
    private var answeredAgo: String {
        let date = review.respondedAt ?? review.updatedAt
        if clock.now.timeIntervalSince(date) < 60 { return "just now" }
        return date.formatted(.relative(presentation: .named, unitsStyle: .wide))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: review.status.symbol).font(.title3).foregroundStyle(review.status.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(review.status == .withdrawn ? "\(who) withdrew this review" : review.status.title).font(.headline).foregroundStyle(FD.foreground)
                    Text(review.status == .withdrawn ? "No answer is needed." : "You answered \(answeredAgo)")
                        .font(.footnote).foregroundStyle(FD.secondary)
                }
                Spacer(minLength: 0)
            }.accessibilityElement(children: .combine).accessibilityIdentifier("review-closed-banner")
            if review.deliveryFailed {
                Label("Couldn't reach \(who). Your answer is saved here, but \(who) hasn't seen it.", systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote).foregroundStyle(FD.warning).fixedSize(horizontal: false, vertical: true)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading).background(FD.warning.opacity(0.12), in: .rect(cornerRadius: 10))
                    .accessibilityIdentifier("review-delivery-failed")
            } else if case .delivered = review.delivery {
                Label("Sent to \(who)", systemImage: "paperplane").font(.footnote).foregroundStyle(FD.secondary).accessibilityIdentifier("review-delivered")
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(review.status.tint.opacity(0.10), in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(review.status.tint.opacity(0.3)))
    }
}

private struct ReviewOutcomeNote: View {
    let review: Review
    var body: some View {
        if review.overallDecision != nil || review.overallNote?.nonempty != nil {
            VStack(alignment: .leading, spacing: 8) {
                Text("Whole review").reviewCaption()
                if let decision = review.overallDecision { Label(decision.pastTense, systemImage: decision.symbol).font(.subheadline.weight(.semibold)).foregroundStyle(decision.tint) }
                if let note = review.overallNote?.nonempty { Text(note).font(.subheadline).foregroundStyle(FD.foreground).fixedSize(horizontal: false, vertical: true) }
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading).background(FD.surface, in: .rect(cornerRadius: 18))
        }
    }
}

/// Words typed for a review that closed before they were sent. Kept, never lost.
private struct ReviewUnsentNotes: View {
    @Environment(AppModel.self) private var model
    let review: Review
    let draft: ReviewDraft
    private var text: String {
        var lines: [String] = []
        for item in review.items {
            let feedback = draft.feedback(for: item.id).trimmingCharacters(in: .whitespacesAndNewlines)
            if !feedback.isEmpty { lines.append("\(item.title): \(feedback)") }
        }
        let note = draft.overallNote.trimmingCharacters(in: .whitespacesAndNewlines)
        if !note.isEmpty { lines.append("Overall: \(note)") }
        return lines.joined(separator: "\n\n")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Your unsent notes").reviewCaption()
            if let reason = model.reviews.closedWhileAnswering[review.id] { Text(reason).font(.footnote).foregroundStyle(FD.secondary) }
            if !text.isEmpty { Text(text).font(.subheadline).foregroundStyle(FD.foreground).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
            HStack(spacing: 12) {
                if !text.isEmpty { Button("Copy notes", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }.buttonStyle(.bordered) }
                Button("Discard", systemImage: "trash", role: .destructive) { model.reviews.discardDraft(review.id, model: model) }.buttonStyle(.bordered)
            }.font(.subheadline)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading).background(FD.surface, in: .rect(cornerRadius: 18))
        .accessibilityIdentifier("review-unsent-notes")
    }
}

// MARK: Submit

private struct ReviewSubmitBar: View {
    let review: Review
    let draft: ReviewDraft
    let submitting: Bool
    @Binding var error: String?
    let connected: Bool
    let submit: () -> Void
    private var complete: Bool { draft.isComplete(for: review) }
    private var ready: Bool { complete && !submitting && connected }
    private var progress: String {
        draft.overallDecision != nil ? "Overall answer chosen" : "\(draft.decidedCount(in: review)) of \(review.items.count) decided"
    }
    var body: some View {
        VStack(spacing: 8) {
            if let error {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(FD.danger)
                    Text(error).font(.footnote).foregroundStyle(FD.foreground).frame(maxWidth: .infinity, alignment: .leading)
                    Button { self.error = nil } label: { Image(systemName: "xmark").font(.footnote.weight(.semibold)).foregroundStyle(FD.muted).frame(width: 28, height: 28) }
                        .accessibilityLabel("Dismiss error")
                }.accessibilityIdentifier("review-submit-error")
            }
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(progress).font(.subheadline.weight(.semibold)).foregroundStyle(FD.foreground).accessibilityIdentifier("review-progress")
                    Text(connected ? draft.statusLine(for: review) : "Connect to your computer to send").font(.caption)
                        .foregroundStyle(complete && connected ? FD.success : FD.secondary).lineLimit(2).accessibilityIdentifier("review-submit-status")
                }
                Spacer(minLength: 8)
                Button(action: submit) {
                    Group { if submitting { ActivityDiamond(color: FD.background) } else { Text("Submit").font(.subheadline.weight(.semibold)) } }
                        .frame(minWidth: 84, minHeight: 44)
                }
                .buttonStyle(.plain).foregroundStyle(ready ? FD.background : FD.muted)
                .background(ready ? FD.accent : FD.raised, in: .capsule).overlay(Capsule().strokeBorder(ready ? Color.clear : FD.line))
                .disabled(!ready).accessibilityIdentifier("review-submit")
                .sensoryFeedback(.success, trigger: review.isOpen) { old, new in old && !new }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .glassEffect(.regular, in: .rect(cornerRadius: 28))
        .padding(.horizontal, 12).padding(.bottom, 6)
    }
}
