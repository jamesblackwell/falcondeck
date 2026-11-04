import SwiftUI

/// A report or review opened from the centre, in the main column so it can be
/// read and copied from beside the sidebar. It joins the back/forward history.
struct NotificationReaderView: View {
    let store: AppStore
    let reader: NotificationReader
    @State private var message: String?

    var body: some View {
        VStack(spacing: 0) {
            if let message { NotificationInlineMessage(message: message) { self.message = nil } }
            switch reader {
            case .report(let id, let hostID):
                NotificationReportView(store: store, id: id, hostID: hostID, openSource: openSource)
            case .review(let id, let hostID):
                NotificationReviewView(store: store, id: id, hostID: hostID, openSource: openTask)
            }
        }
        .background(FDTheme.background)
        .environment(\.transcriptOpenThread, { id in
            openTask(reader.hostID.map { NativeHostManager.namespace(hostID: $0, id: id) } ?? id)
        })
    }

    private func openSource(_ target: NotificationTarget) {
        switch target {
        case .thread(_, let taskID): openTask(taskID)
        case .review(let id): store.selectNotificationReader(.review(id: id, hostID: reader.hostID))
        }
    }

    private func openTask(_ id: String) {
        if !store.openNotificationTask(id) { message = AppStore.missingTaskMessage }
    }
}

/// The reading column shared by reports and reviews.
private struct NotificationReaderColumn<Header: View, Content: View>: View {
    let store: AppStore
    @ViewBuilder var header: Header
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Button { Task { await store.closeNotificationReader() } } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(NativeIconButtonStyle())
                    .help("Back")
                    .accessibilityLabel("Back")
                header
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .overlay(alignment: .bottom) { Rectangle().fill(FDTheme.hairline).frame(height: 1) }
            ScrollView {
                content
                    .padding(.horizontal, 28)
                    .padding(.vertical, 22)
                    .frame(maxWidth: 760, alignment: .leading)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

private struct NotificationReaderTitle: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(NativePreferences.shared.font(size: 15, weight: .semibold))
                .foregroundStyle(FDTheme.foreground)
                .lineLimit(2)
                .textSelection(.enabled)
            if !detail.isEmpty {
                Text(detail)
                    .font(NativePreferences.shared.font(size: 12))
                    .foregroundStyle(FDTheme.muted)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct NotificationReaderFailure: View {
    let store: AppStore
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Text(message)
                .font(NativePreferences.shared.font(size: 13))
                .foregroundStyle(FDTheme.secondary)
                .multilineTextAlignment(.center)
            HStack {
                Button("Back") { Task { await store.closeNotificationReader() } }
                Button("Try again", action: retry)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct NotificationReportView: View {
    let store: AppStore
    let id: String
    let hostID: String?
    let openSource: (NotificationTarget) -> Void
    @State private var model = NotificationReportModel()

    var body: some View {
        Group {
            if let record = model.record {
                NotificationReaderColumn(store: store) {
                    NotificationReaderTitle(title: record.title, detail: detail(record))
                    if let target = record.target {
                        Button(target.isReview ? "Open review" : "Open task") { openSource(target) }
                            .controlSize(.small)
                    }
                } content: {
                    NativeMarkdownView(text: record.body ?? record.preview, fontSize: 14)
                }
            } else if let error = model.error {
                NotificationReaderFailure(store: store, message: error) {
                    Task { await model.load(id: id, hostID: hostID, centre: store.notifications) }
                }
            } else {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await model.load(id: id, hostID: hostID, centre: store.notifications) }
    }

    private func detail(_ record: NotificationRecord) -> String {
        [record.bot, NativeDates.absoluteLabel(iso: record.createdAt).nonempty].compactMap { $0 }.joined(separator: " · ")
    }
}

private extension NotificationTarget {
    var isReview: Bool { if case .review = self { true } else { false } }
}

private struct NotificationReviewView: View {
    let store: AppStore
    let id: String
    let hostID: String?
    let openSource: (String) -> Void
    @State private var model: NotificationReviewModel?

    var body: some View {
        Group {
            if let model, let review = model.review {
                NotificationReaderColumn(store: store) {
                    NotificationReaderTitle(title: review.title, detail: detail(review))
                    if let source = review.sourceTaskID {
                        Button("Open task") { openSource(source) }.controlSize(.small)
                    }
                } content: {
                    NotificationReviewContent(model: model, review: review)
                }
            } else if let model, let error = model.loadError {
                NotificationReaderFailure(store: store, message: error) { Task { await model.load() } }
            } else {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: store.notifications.reviewRevision) {
            let model = model ?? makeModel()
            self.model = model
            await model.load()
        }
    }

    private func makeModel() -> NotificationReviewModel {
        let store = store
        return NotificationReviewModel(id: id, hostID: hostID) { path, method, query, body, host in
            try await store.request(path, method: method, query: query, body: body, hostID: host)
        }
    }

    private func detail(_ review: NotificationReviewRecord) -> String {
        [review.bot, NativeDates.absoluteLabel(iso: review.raw["created_at"].string).nonempty].compactMap { $0 }.joined(separator: " · ")
    }
}

private struct NotificationReviewContent: View {
    @Bindable var model: NotificationReviewModel
    let review: NotificationReviewRecord

    private var statusColor: Color {
        switch review.status {
        case "open": FDTheme.warning
        case "approved": FDTheme.accent
        case "changes_requested": FDTheme.warning
        case "rejected": FDTheme.danger
        default: FDTheme.muted
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Circle().fill(statusColor).frame(width: 6, height: 6)
                    Text(review.statusTitle)
                }
                .font(NativePreferences.shared.font(size: 12, weight: .medium))
                .foregroundStyle(FDTheme.secondary)
                Text(review.ask)
                    .font(NativePreferences.shared.font(size: 16, weight: .medium))
                    .foregroundStyle(FDTheme.foreground)
                    .textSelection(.enabled)
                if review.isOpen, let at = review.goingAheadAt.flatMap(NativeDates.parse) {
                    Text("Going ahead \(at.formatted(date: .abbreviated, time: .shortened)) unless you say no")
                        .font(NativePreferences.shared.font(size: 12))
                        .foregroundStyle(FDTheme.warning)
                }
            }
            NotificationReviewSection("Recommendation") {
                NativeMarkdownView(text: review.recommendation, fontSize: 14)
            }
            if !review.body.isEmpty {
                NotificationReviewSection("Context") { NativeMarkdownView(text: review.body, fontSize: 14) }
            }
            if !review.items.isEmpty {
                NotificationReviewSection(review.items.count == 1 ? "Item" : "Items") {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(review.items) { NotificationReviewItemRow(item: $0) }
                    }
                }
            }
            if let note = review.overallNote {
                NotificationReviewSection("Your note") {
                    Text(note)
                        .font(NativePreferences.shared.font(size: 14))
                        .foregroundStyle(FDTheme.secondary)
                        .textSelection(.enabled)
                }
            }
            if let failure = review.deliveryError {
                Text("Your response is saved, but the task couldn’t receive it: \(failure)")
                    .font(NativePreferences.shared.font(size: 12))
                    .foregroundStyle(FDTheme.danger)
                    .textSelection(.enabled)
            }
            if review.isOpen { response }
        }
    }

    private var response: some View {
        VStack(alignment: .leading, spacing: 10) {
            Rectangle().fill(FDTheme.hairline).frame(height: 1)
            TextField("Add a note (optional)", text: $model.note, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .font(NativePreferences.shared.font(size: 13))
                .padding(8)
                .background(FDTheme.raised, in: .rect(cornerRadius: 7))
                .accessibilityLabel("Note to the agent")
            if let error = model.responseError {
                Text(error)
                    .font(NativePreferences.shared.font(size: 12))
                    .foregroundStyle(FDTheme.danger)
                    .textSelection(.enabled)
            }
            HStack(spacing: 8) {
                Button("Approve") { respond(.approve) }.buttonStyle(.borderedProminent)
                Button("Request changes") { respond(.requestChanges) }
                Button("Reject", role: .destructive) { respond(.reject) }
                if model.submitting != nil { ProgressView().controlSize(.small) }
            }
            .disabled(model.submitting != nil)
        }
    }

    private func respond(_ decision: NotificationReviewDecision) {
        Task { await model.respond(decision) }
    }
}

private struct NotificationReviewSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(NativePreferences.shared.font(size: 11, weight: .medium))
                .foregroundStyle(FDTheme.muted)
                .accessibilityAddTraits(.isHeader)
            content
        }
    }
}

private struct NotificationReviewItemRow: View {
    let item: NotificationReviewItem

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(item.title)
                .font(NativePreferences.shared.font(size: 13, weight: .medium))
                .foregroundStyle(FDTheme.foreground)
                .textSelection(.enabled)
            if !item.note.isEmpty {
                Text(item.note)
                    .font(NativePreferences.shared.font(size: 13))
                    .foregroundStyle(FDTheme.secondary)
                    .textSelection(.enabled)
            }
            if !item.feedback.isEmpty {
                Text(item.feedback)
                    .font(NativePreferences.shared.font(size: 13))
                    .foregroundStyle(FDTheme.muted)
                    .textSelection(.enabled)
            }
            ForEach(item.evidence) { evidence in
                Label(evidence.name, systemImage: evidence.symbol)
                    .font(NativePreferences.shared.font(size: 12))
                    .foregroundStyle(FDTheme.muted)
                    .lineLimit(1)
            }
        }
    }
}
