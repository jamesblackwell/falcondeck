import SwiftUI

/// The inbox: what is waiting on James, then a short run of what he answered.
struct ReviewsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var textSize
    /// The detail stack's path only holds `DetailDestination`s, so a review is
    /// pushed with its own destination rather than a value on that path.
    @State private var openID: String?
    private var store: ReviewStore { model.reviews }

    var body: some View {
        Group {
            if !store.entryVisible(model: model) {
                ContentUnavailableView("Review inbox is off", systemImage: "text.badge.checkmark",
                    description: Text("Turn it on in Settings on your computer to receive reviews from your bots."))
            } else { inbox }
        }
        .background(FD.background)
        .navigationDestination(item: $openID) { ReviewDetailView(reviewID: $0) }
        .onChange(of: model.requestedReviewID, initial: true) { _, requested in
            guard let requested else { return }
            openID = requested; model.requestedReviewID = nil
        }
        .accessibilityIdentifier("reviews-screen")
    }

    private var inbox: some View {
        let open = store.openReviews, answered = store.answeredReviews
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if let error = store.refreshError { Text(error).font(.footnote).foregroundStyle(FD.danger).padding(.horizontal, 4) }
                if !open.isEmpty {
                    Text("Waiting on you · \(open.count)").reviewCaption().padding(.horizontal, 4).padding(.top, 4)
                    ForEach(open) { review in
                        Button { openID = review.id } label: { ReviewRow(review: review) }
                            .buttonStyle(.plain).accessibilityIdentifier("review-row-\(review.id)")
                    }
                }
                if !answered.isEmpty {
                    Text("Answered").reviewCaption().padding(.horizontal, 4).padding(.top, open.isEmpty ? 4 : 18)
                    ForEach(answered) { review in
                        Button { openID = review.id } label: { AnsweredReviewRow(review: review) }
                            .buttonStyle(.plain).accessibilityIdentifier("review-row-\(review.id)")
                    }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12).frame(maxWidth: 720).frame(maxWidth: .infinity)
        }
        .overlay {
            if open.isEmpty && answered.isEmpty && store.refreshError == nil {
                if !store.loaded && !model.connected && !model.demo {
                    ContentUnavailableView("Waiting for your computer", systemImage: "wifi.slash",
                        description: Text("Reviews load once the app reaches your computer.")).allowsHitTesting(false)
                } else if store.loading || !store.loaded {
                    HStack(spacing: 8) { ActivityDiamond(); Text("Loading reviews…").font(.footnote).foregroundStyle(FD.secondary) }
                } else {
                    ContentUnavailableView("Nothing to review", systemImage: "checkmark.circle",
                        description: Text("When a bot needs a decision, it shows up here.")).allowsHitTesting(false)
                }
            }
        }
        .refreshable { await store.refresh(model: model) }
        .task(id: "\(model.connectionID):\(model.connected)") { await store.refresh(model: model) }
        .onAppear { MinuteClock.shared.start() }
    }
}

private struct ReviewRow: View {
    let review: Review
    private let clock = MinuteClock.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                ReviewSender(name: review.botName)
                Spacer(minLength: 4)
                Text(ReviewFormat.age(review.createdAt, now: clock.now)).font(.caption).foregroundStyle(FD.muted)
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(FD.muted)
            }
            Text(review.title).font(.headline).foregroundStyle(FD.foreground).multilineTextAlignment(.leading).lineLimit(2)
            if !review.ask.isEmpty { Text(review.ask).font(.subheadline).foregroundStyle(FD.secondary).multilineTextAlignment(.leading).lineLimit(3) }
            HStack(spacing: 12) {
                Label(review.itemCountLabel, systemImage: "square.stack").foregroundStyle(FD.muted)
                if let at = review.goingAheadAt {
                    Label(ReviewFormat.goingAhead(at, now: clock.now), systemImage: "clock").foregroundStyle(FD.warning)
                }
            }.font(.caption).labelStyle(.titleAndIcon).padding(.top, 2)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).contentShape(.rect(cornerRadius: 16))
        .background(FD.surface, in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(FD.hairline))
        .accessibilityElement(children: .combine)
    }
}

/// Answered reviews stay quiet: outcome first, no ask.
private struct AnsweredReviewRow: View {
    let review: Review
    private let clock = MinuteClock.shared
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: review.status.symbol).font(.body).foregroundStyle(review.status.tint).frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(review.title).font(.subheadline.weight(.medium)).foregroundStyle(FD.body).lineLimit(1)
                HStack(spacing: 6) {
                    if let bot = review.botName { Text(bot) }
                    Text(review.outcomeSummary).lineLimit(1)
                }.font(.caption).foregroundStyle(FD.secondary)
                if review.deliveryFailed {
                    Label("Couldn't reach \(review.botName ?? "the agent")", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption).foregroundStyle(FD.warning)
                }
            }
            Spacer(minLength: 4)
            Text(ReviewFormat.age(review.respondedAt ?? review.updatedAt, now: clock.now)).font(.caption).foregroundStyle(FD.muted)
        }
        .padding(.horizontal, 14).padding(.vertical, 10).frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
        .contentShape(.rect(cornerRadius: 14))
        .background(FD.surface.opacity(0.6), in: .rect(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }
}

/// The sidebar's Reviews row. It owns the badge and is the only thing in the
/// sidebar that knows reviews exist; it vanishes when the inbox is off or the
/// computer is too old to have one.
struct ReviewsSidebarRow: View {
    @Environment(AppModel.self) private var model
    let selected: Bool
    let open: () -> Void
    private var store: ReviewStore { model.reviews }
    var body: some View {
        if store.entryVisible(model: model) {
            let count = store.openCount
            Button(action: open) {
                HStack(spacing: 8) {
                    Label("Reviews", systemImage: "text.badge.checkmark").font(.subheadline)
                    Spacer(minLength: 4)
                    if count > 0 {
                        Text("\(count)").font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(FD.background)
                            .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20).background(FD.accent, in: .capsule)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 12)
                .background(selected ? FD.raised : .clear, in: .rect(cornerRadius: 8)).contentShape(.rect)
            }
            .buttonStyle(.plain).foregroundStyle(FD.foreground)
            .accessibilityLabel("Reviews").accessibilityValue(count > 0 ? "\(count) open" : "").accessibilityIdentifier("sidebar-reviews")
            .task(id: "\(model.connectionID):\(model.connected)") { await store.refresh(model: model) }
        }
    }
}
