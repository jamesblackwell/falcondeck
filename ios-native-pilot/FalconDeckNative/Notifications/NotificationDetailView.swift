import SwiftUI

/// One notice or report: who sent it, the body, the way back to its thread, and
/// a reply that goes to that thread as an ordinary message. It opens with the
/// computer asleep when the relay holds a copy.
struct NotificationDetailView: View {
    let target: NotificationDetailTarget
    @Environment(AppModel.self) private var model
    @State private var detail: NotificationDetail?
    @State private var sending = false
    @State private var sent = false
    @State private var sendError: String?
    @FocusState private var focus: String?
    private var store: NotificationCentreStore { model.notificationCentre }

    var body: some View {
        Group {
            if let detail { content(detail) }
            else { HStack(spacing: 8) { ActivityDiamond(); Text("Loading…").font(.footnote).foregroundStyle(FD.secondary) } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).background(FD.background)
        .navigationTitle(detail?.record?.hasBody == true || detail?.onComputer == true ? "Report" : "Notice").navigationBarTitleDisplayMode(.inline)
        // A report that opened from the relay upgrades itself once the computer is back.
        .task(id: "\(target.id):\(model.connected)") {
            await store.restoreReplies(model: model)
            detail = await store.detail(for: target, model: model)
        }
        .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { focus = nil } } }
        .accessibilityIdentifier("notification-detail-screen")
    }

    @ViewBuilder private func content(_ detail: NotificationDetail) -> some View {
        let record = detail.record
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let record { NotificationDetailHeader(record: record) }
                if detail.fromRelay {
                    Label("Your computer is offline. This is the copy kept for you.", systemImage: "lock.icloud").font(.footnote).foregroundStyle(FD.secondary)
                        .accessibilityIdentifier("notification-relay-copy")
                }
                if detail.onComputer { onComputer(record) }
                else if let body = detail.body {
                    NativeMarkdown(text: body, foreground: FD.body)
                        .environment(\.fileContext, FileContext(workspaceID: record?.workspaceID, threadID: record?.threadID))
                        .accessibilityIdentifier("notification-body")
                } else if let preview = record?.preview.nonempty {
                    Text(preview).foregroundStyle(FD.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("notification-preview")
                }
                if let record { links(record) }
                if let record, let source = record.sourceThread { reply(record, source: source) }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 28).frame(maxWidth: 720).frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func onComputer(_ record: NotificationRecord?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let preview = record?.preview.nonempty { Text(preview).foregroundStyle(FD.body).fixedSize(horizontal: false, vertical: true) }
            Label("This report is on your computer", systemImage: "laptopcomputer").font(.subheadline.weight(.semibold)).foregroundStyle(FD.foreground)
                .accessibilityIdentifier("notification-on-computer")
            Text("It opens here once your computer is back online.").font(.footnote).foregroundStyle(FD.secondary)
        }
    }

    @ViewBuilder private func links(_ record: NotificationRecord) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if case .review(let id)? = record.target {
                NavigationLink { ReviewDetailView(reviewID: id) } label: { sourceLabel("Open review", symbol: "text.badge.checkmark") }
                    .buttonStyle(.plain).accessibilityIdentifier("notification-open-review")
            }
            if let source = record.sourceThread {
                Button { Task { await model.openTask(source.threadID, workspaceID: source.workspaceID) } } label: { sourceLabel("Open thread", symbol: "bubble.left.and.text.bubble.right") }
                    .buttonStyle(.plain).accessibilityIdentifier("notification-open-thread")
            }
        }
    }
    private func sourceLabel(_ title: String, symbol: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).foregroundStyle(FD.accent).frame(width: 22)
            Text(title).font(.subheadline.weight(.medium)).foregroundStyle(FD.foreground)
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(FD.muted)
        }.frame(minHeight: 44).contentShape(.rect)
    }

    // MARK: Reply

    private func reply(_ record: NotificationRecord, source: (workspaceID: String, threadID: String)) -> some View {
        let reachable = model.connected || model.demo
        let text = store.reply(record.id).trimmingCharacters(in: .whitespacesAndNewlines)
        return VStack(alignment: .leading, spacing: 10) {
            Text(record.bot.map { "Reply to \($0)" } ?? "Reply").reviewCaption()
            ReviewFeedbackField(
                text: Binding(get: { store.reply(record.id) }, set: { sent = false; sendError = nil; store.editReply(record.id, text: $0, model: model) }),
                prompt: "Sends as a message in the thread", dictationKey: "notification:\(record.id)", identifier: "notification-reply", focus: $focus,
                persist: { await store.persistReply(record.id, model: model) }, dictateLabel: "Dictate reply")
            HStack(spacing: 10) {
                if sent { Label("Sent", systemImage: "paperplane").font(.footnote).foregroundStyle(FD.secondary).accessibilityIdentifier("notification-reply-sent") }
                else if let sendError { Text(sendError).font(.footnote).foregroundStyle(FD.danger).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("notification-reply-error") }
                else if !reachable { Text("You can send this once your computer is back.").font(.footnote).foregroundStyle(FD.secondary) }
                Spacer(minLength: 4)
                Button { send(record, source: source) } label: {
                    if sending { ActivityDiamond() } else { Text("Send").font(.subheadline.weight(.semibold)).frame(minWidth: 56, minHeight: 32) }
                }
                .buttonStyle(.borderedProminent).tint(FD.accent).foregroundStyle(FD.background)
                .disabled(text.isEmpty || sending || !reachable).accessibilityIdentifier("notification-reply-send")
            }
        }.padding(.top, 6)
    }

    private func send(_ record: NotificationRecord, source: (workspaceID: String, threadID: String)) {
        let text = store.reply(record.id)
        focus = nil; sendError = nil; sending = true
        Task {
            defer { sending = false }
            do {
                try await model.sendNotificationReply(text, workspaceID: source.workspaceID, threadID: source.threadID)
                store.editReply(record.id, text: "", model: model)
                sent = true
            } catch { sendError = error.localizedDescription }
        }
    }
}

private struct NotificationDetailHeader: View {
    @Environment(AppModel.self) private var model
    let record: NotificationRecord
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if let bot = record.bot {
                    BotMark(icon: model.reviewBotIcon(named: bot), size: 14)
                    Text(bot).font(.caption.weight(.medium)).foregroundStyle(FD.secondary).lineLimit(1)
                } else {
                    Image(systemName: record.kind.symbol).font(.caption).foregroundStyle(FD.muted)
                    Text(record.kind.label).font(.caption.weight(.medium)).foregroundStyle(FD.secondary)
                }
                Text("·").foregroundStyle(FD.muted)
                Text(record.createdAt.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(FD.muted)
            }
            Text(record.title).font(.title3.weight(.semibold)).foregroundStyle(FD.foreground).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("notification-title")
        }.accessibilityElement(children: .contain)
    }
}
