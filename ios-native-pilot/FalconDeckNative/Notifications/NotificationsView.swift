import SwiftUI

/// Everything that asked for James's attention, by day. The daemon holds the
/// history; this shows it, and keeps reading while the computer is asleep.
struct NotificationsView: View {
    @Environment(AppModel.self) private var model
    /// Pushes live on the shared detail path, so opening a thread from anywhere
    /// clears them along with this screen.
    @Binding var path: [DetailDestination]
    private let clock = MinuteClock.shared
    private var store: NotificationCentreStore { model.notificationCentre }

    var body: some View {
        Group {
            if store.entryVisible { history }
            else {
                ContentUnavailableView("Notifications aren't available", systemImage: "bell.slash",
                    description: Text("Update FalconDeck on your computer to see your notification history here."))
            }
        }
        .background(FD.background)
        .accessibilityIdentifier("notifications-screen")
    }

    private var history: some View {
        let offline = store.isOffline(model)
        let sections = NotificationDays.sections(store.visibleRecords(offline: offline), now: clock.now)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if offline { NotificationOfflineNote(reportsReady: !store.reportRecords.isEmpty).padding(.bottom, 14) }
                if let error = store.refreshError ?? store.actionError {
                    Text(error).font(.footnote).foregroundStyle(FD.danger).padding(.horizontal, 4).padding(.bottom, 10).accessibilityIdentifier("notifications-error")
                }
                ForEach(sections) { section in
                    Text(section.title).reviewCaption().padding(.horizontal, 4).padding(.bottom, 8)
                    VStack(spacing: 0) {
                        ForEach(section.records) { record in
                            Button { open(record) } label: { NotificationRow(record: record) }
                                .buttonStyle(.plain).accessibilityIdentifier("notification-row-\(record.id)")
                                .contextMenu {
                                    if !record.isRead { Button("Mark as read", systemImage: "checkmark") { Task { await store.markRead(record.id, model: model) } } }
                                }
                            if record.id != section.records.last?.id { Divider().overlay(FD.hairline).padding(.leading, 48) }
                        }
                    }
                    .background(FD.surface, in: .rect(cornerRadius: 16)).clipShape(.rect(cornerRadius: 16))
                    .padding(.bottom, 20)
                }
                if store.hasMore && !offline { loadMore }
            }
            .padding(.horizontal, 16).padding(.vertical, 12).frame(maxWidth: 720).frame(maxWidth: .infinity)
        }
        .overlay { if sections.isEmpty && store.refreshError == nil { placeholder(offline: offline) } }
        .safeAreaBar(edge: .top, spacing: 0) { filterBar }
        .scrollEdgeEffectStyle(.hard, for: .top)
        .refreshable { await store.refresh(model: model, immediate: true) }
        .task(id: store.filter) { await store.refresh(model: model) }
        .onAppear { MinuteClock.shared.start() }
        .toolbar {
            if store.unreadCount(offline: false) > 0 {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Mark all read") { Task { await store.markAllRead(model: model) } }
                        .disabled(offline).accessibilityIdentifier("notifications-mark-all")
                }
            }
        }
    }

    private var filterBar: some View {
        Picker("Filter", selection: Binding(get: { store.filter }, set: { store.setFilter($0) })) {
            ForEach(NotificationFilter.allCases, id: \.self) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented).padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 8)
        .frame(maxWidth: 720).frame(maxWidth: .infinity).accessibilityIdentifier("notifications-filter")
    }

    @ViewBuilder private var loadMore: some View {
        HStack(spacing: 8) {
            if store.loadingMore { ActivityDiamond(); Text("Loading earlier…").font(.footnote).foregroundStyle(FD.secondary) }
            else {
                Button(store.loadMoreFailed ? "Couldn't load more. Try again" : "Load earlier") { Task { await store.loadMore(model: model) } }
                    .font(.footnote.weight(.medium)).frame(minHeight: 44).accessibilityIdentifier("notifications-load-more")
            }
        }
        .frame(maxWidth: .infinity)
        // Reaching the end loads the next page; a failure waits for a tap.
        .onAppear { if !store.loadMoreFailed { Task { await store.loadMore(model: model) } } }
    }

    @ViewBuilder private func placeholder(offline: Bool) -> some View {
        if offline {
            ContentUnavailableView("Waiting for your computer", systemImage: "wifi.slash",
                description: Text("Your notifications load once the app reaches your computer.")).allowsHitTesting(false)
        } else if store.loading || !store.loaded {
            HStack(spacing: 8) { ActivityDiamond(); Text("Loading notifications…").font(.footnote).foregroundStyle(FD.secondary) }
        } else {
            switch store.filter {
            case .all: ContentUnavailableView("No notifications yet", systemImage: "bell", description: Text("When something needs your attention, it stays here.")).allowsHitTesting(false)
            case .needsYou: ContentUnavailableView("Nothing needs you", systemImage: "checkmark.circle", description: Text("Requests and reviews waiting on you show up here.")).allowsHitTesting(false)
            case .bots: ContentUnavailableView("Nothing from your bots", systemImage: "bell", description: Text("Notices and reports from your bots show up here.")).allowsHitTesting(false)
            }
        }
    }

    private func open(_ record: NotificationRecord) {
        Task { await store.markRead(record.id, model: model) }
        switch record.action {
        case .detail: path = [.notificationDetail(NotificationDetailTarget(record))]
        case .review(let id): path = [.review(id)]
        case .thread(let workspaceID, let threadID): Task { await model.openTask(threadID, workspaceID: workspaceID) }
        }
    }
}

private struct NotificationOfflineNote: View {
    let reportsReady: Bool
    var body: some View {
        Label(reportsReady ? "Your computer is offline. Showing what was last loaded, plus reports kept for you." : "Your computer is offline. Showing what was last loaded.", systemImage: "wifi.slash")
            .font(.footnote).foregroundStyle(FD.secondary).labelStyle(.titleAndIcon).frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4).accessibilityIdentifier("notifications-offline")
    }
}

private struct NotificationRow: View {
    @Environment(AppModel.self) private var model
    let record: NotificationRecord
    private let clock = MinuteClock.shared
    /// Answered requests and reviews step back; they are history now.
    private var quiet: Bool { record.isResolved }
    private var tint: Color {
        switch record.kind {
        case _ where quiet: FD.muted
        case .error: FD.danger
        case .inputRequired, .review: FD.warning
        case .agentNotice: FD.accent
        default: FD.secondary
        }
    }
    private var symbol: String {
        if quiet { return "checkmark.circle" }
        if record.kind == .agentNotice, !record.hasBody { return "bell" }
        return record.kind.symbol
    }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.system(size: 17)).foregroundStyle(tint).frame(width: 22, height: 20)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(record.title).font(.subheadline.weight(record.isRead ? .regular : .semibold))
                        .foregroundStyle(quiet ? FD.secondary : record.isRead ? FD.body : FD.foreground).lineLimit(2).multilineTextAlignment(.leading)
                    Spacer(minLength: 4)
                    Text(ReviewFormat.age(record.createdAt, now: clock.now)).font(.caption).foregroundStyle(FD.muted).fixedSize()
                    if !record.isRead { Circle().fill(FD.unread).frame(width: 8, height: 8).accessibilityHidden(true).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 } }
                }
                if !record.preview.isEmpty {
                    Text(record.preview).font(.footnote).foregroundStyle(quiet ? FD.muted : FD.secondary).lineLimit(2).multilineTextAlignment(.leading)
                }
                if let bot = record.bot {
                    HStack(spacing: 5) {
                        BotMark(icon: model.reviewBotIcon(named: bot), size: 12)
                        Text(bot).font(.caption).foregroundStyle(FD.muted).lineLimit(1)
                    }.padding(.top, 2)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityValue(record.isRead ? "" : "Unread")
    }
}

/// The sidebar's Notifications row. It owns the unread badge, and vanishes
/// when the computer is too old to have a centre.
struct NotificationsSidebarRow: View {
    @Environment(AppModel.self) private var model
    let selected: Bool
    let open: () -> Void
    private var store: NotificationCentreStore { model.notificationCentre }
    var body: some View {
        if store.entryVisible {
            let count = store.unreadCount(offline: store.isOffline(model))
            Button(action: open) {
                HStack(spacing: 8) {
                    Label("Notifications", systemImage: "bell").font(.subheadline)
                    Spacer(minLength: 4)
                    if count > 0 {
                        Text(count > 99 ? "99+" : "\(count)").font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(FD.background)
                            .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20).background(FD.accent, in: .capsule)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 12)
                .background(selected ? FD.raised : .clear, in: .rect(cornerRadius: 8)).contentShape(.rect)
            }
            .buttonStyle(.plain).foregroundStyle(FD.foreground)
            .accessibilityLabel("Notifications").accessibilityValue(count > 0 ? "\(count) unread" : "").accessibilityIdentifier("sidebar-notifications")
            // Connecting refreshes the store; this covers the demo and the computer being away.
            .task(id: "\(model.connectionID):\(model.connected):\(model.demo)") { if model.demo || !model.connected { await store.refresh(model: model) } }
        }
    }
}
