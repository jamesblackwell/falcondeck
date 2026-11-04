import SwiftUI

/// Lives in the window toolbar, so it stays reachable from every section.
struct NotificationBell: View {
    let store: AppStore

    var body: some View {
        @Bindable var centre = store.notifications
        if !centre.unsupported {
            Button { centre.isPresented.toggle() } label: {
                Label {
                    Text("Notifications")
                } icon: {
                    NotificationBellGlyph(count: centre.counts.unread)
                }
            }
            // A hosted toolbar view otherwise draws a resting border its neighbours lack.
            .buttonStyle(.borderless)
            .help(helpText(centre.counts.unread))
            .accessibilityLabel(helpText(centre.counts.unread))
            .accessibilityIdentifier("notification-bell")
            .popover(isPresented: $centre.isPresented, arrowEdge: .bottom) {
                NotificationCentreView(store: store)
            }
        }
    }

    private func helpText(_ unread: Int) -> String {
        unread == 0 ? "Notifications" : "Notifications, \(unread) unread"
    }
}

private struct NotificationBellGlyph: View {
    let count: Int

    var body: some View {
        // Sized to its neighbours. The frame keeps the badge on the bell's
        // shoulder, inside the toolbar item, so it never hides the bell.
        Image(systemName: "bell")
            .font(.system(size: 15))
            .frame(width: 30, height: 24)
            .overlay(alignment: .topTrailing) {
                if let label = NotificationBadge.label(count) {
                    Text(label)
                        .font(.system(size: 9, weight: .semibold).monospacedDigit())
                        .foregroundStyle(FDTheme.background)
                        .padding(.horizontal, 3)
                        .frame(minWidth: 13, minHeight: 13)
                        .background(FDTheme.info, in: .capsule)
                        .fixedSize()
                }
            }
    }
}

struct NotificationCentreView: View {
    let store: AppStore
    private var centre: NotificationCentreStore { store.notifications }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(FDTheme.hairline).frame(height: 1)
            if let message = centre.message {
                NotificationInlineMessage(message: message) { centre.dismissMessage() }
            }
            content
        }
        .frame(width: 396, height: 540)
        .presentationBackground(FDTheme.surface)
        .task { await centre.refresh() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Notifications")
                    .font(NativePreferences.shared.font(size: 14, weight: .semibold))
                    .foregroundStyle(FDTheme.foreground)
                Spacer()
                Button("Mark all read") { Task { await centre.markAllRead() } }
                    .buttonStyle(.plain)
                    .font(NativePreferences.shared.font(size: 12))
                    .foregroundStyle(centre.canMarkAllRead ? FDTheme.secondary : FDTheme.subtle)
                    .disabled(!centre.canMarkAllRead)
            }
            Picker("Filter", selection: Binding(get: { centre.filter }, set: { centre.setFilter($0) })) {
                ForEach(NotificationFilter.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 10)
    }

    @ViewBuilder private var content: some View {
        if centre.records.isEmpty {
            if let error = centre.loadError {
                NotificationListState(symbol: "exclamationmark.circle", title: "Couldn’t load notifications", detail: error) {
                    Task { await centre.refresh() }
                }
            } else if !centre.hasLoaded {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                switch centre.filter {
                case .all: NotificationListState(symbol: "bell", title: "No notifications yet", detail: "Finished tasks, questions and messages from your bots will collect here.")
                case .needsYou: NotificationListState(symbol: "checkmark.circle", title: "Nothing needs you", detail: "Requests and reviews waiting on a decision appear here.")
                case .bots: NotificationListState(symbol: "person.crop.circle", title: "Nothing from bots", detail: "Messages and reports from your bots appear here.")
                }
            }
        } else {
            list
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                ForEach(NotificationDayGrouping.sections(centre.records, date: NativeDates.parse)) { section in
                    Section {
                        ForEach(section.records) { record in
                            NotificationRow(record: record) { open(record) }
                        }
                    } header: {
                        Text(section.title)
                            .font(NativePreferences.shared.font(size: 11, weight: .medium))
                            .foregroundStyle(FDTheme.muted)
                            .padding(.horizontal, 14)
                            .padding(.top, 10)
                            .padding(.bottom, 4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(FDTheme.surface)
                            .accessibilityAddTraits(.isHeader)
                    }
                }
                NotificationListFooter(centre: centre)
            }
        }
    }

    private func open(_ record: NotificationRecord) {
        if store.openNotification(record, hostID: centre.hostID) { centre.isPresented = false }
    }
}

private struct NotificationListFooter: View {
    let centre: NotificationCentreStore

    var body: some View {
        Group {
            if centre.loadMoreError != nil {
                Button("Couldn’t load older notifications. Try again") { Task { await centre.loadMore() } }
                    .buttonStyle(.plain)
                    .foregroundStyle(FDTheme.secondary)
            } else if centre.nextBeforeSeq != nil {
                ProgressView().controlSize(.small).onAppear { Task { await centre.loadMore() } }
            } else if centre.hasLoaded {
                Text("No older notifications").foregroundStyle(FDTheme.subtle)
            }
        }
        .font(NativePreferences.shared.font(size: 12))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
    }
}

private struct NotificationRow: View {
    let record: NotificationRecord
    let open: () -> Void
    @State private var hovering = false

    private var presentation: NotificationRowPresentation { NotificationRowPresentation(record) }

    var body: some View {
        let presentation = presentation
        Button(action: open) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: presentation.symbol)
                    .font(.system(size: 13))
                    .foregroundStyle(presentation.symbolColor)
                    .frame(width: 18, height: 18)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(record.title)
                            .font(NativePreferences.shared.font(size: 13, weight: record.isRead ? .regular : .medium))
                            .foregroundStyle(record.wasDealtWith ? FDTheme.muted : record.isRead ? FDTheme.secondary : FDTheme.foreground)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Text(NativeDates.shortRelative(iso: record.createdAt) ?? "")
                            .font(NativePreferences.shared.font(size: 11).monospacedDigit())
                            .foregroundStyle(FDTheme.subtle)
                            .fixedSize()
                    }
                    let preview = NativePlainText.line(record.preview)
                    if !preview.isEmpty {
                        Text(preview)
                            .font(NativePreferences.shared.font(size: 12))
                            .foregroundStyle(record.wasDealtWith ? FDTheme.subtle : FDTheme.muted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    if let detail = presentation.detail {
                        Text(detail)
                            .font(NativePreferences.shared.font(size: 11))
                            .foregroundStyle(FDTheme.subtle)
                            .lineLimit(1)
                            .padding(.top, 1)
                    }
                }
            }
            .padding(.vertical, 8)
            .padding(.leading, 18)
            .padding(.trailing, 14)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(hovering ? FDTheme.raised : Color.clear)
        .overlay(alignment: .topLeading) {
            if !record.isRead {
                Circle().fill(FDTheme.info).frame(width: 6, height: 6).padding(.leading, 7).padding(.top, 14)
            }
        }
        .onHover { hovering = $0 }
        .help(NativeDates.absoluteLabel(iso: record.createdAt))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(presentation.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }
}

struct NotificationRowPresentation {
    let symbol: String
    let tone: Tone
    let detail: String?
    let accessibilityLabel: String

    enum Tone { case attention, failure, notice, quiet }

    init(_ record: NotificationRecord) {
        switch record.kind {
        case "input_required": (symbol, tone) = ("hand.raised", record.wasDealtWith ? .quiet : .attention)
        case "review": (symbol, tone) = ("checklist", record.wasDealtWith ? .quiet : .attention)
        case "error": (symbol, tone) = ("exclamationmark.circle", .failure)
        case "turn_complete": (symbol, tone) = ("checkmark.circle", .quiet)
        case "agent_notice": (symbol, tone) = (record.hasBody ? "doc.text" : "text.bubble", .notice)
        default: (symbol, tone) = ("bell", .quiet)
        }
        var parts: [String] = []
        if record.wasDealtWith { parts.append("Resolved") }
        if let bot = record.bot { parts.append(bot) }
        if record.repeatCount > 0 { parts.append("\(record.repeatCount + 1) times") }
        detail = parts.isEmpty ? nil : parts.joined(separator: " · ")
        var spoken = record.isRead ? [] : ["Unread"]
        spoken += [record.title, record.preview] + parts
        accessibilityLabel = spoken.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

private extension NotificationRowPresentation {
    @MainActor var symbolColor: Color {
        switch tone {
        case .attention: FDTheme.warning
        case .failure: FDTheme.danger
        case .notice: FDTheme.accent
        case .quiet: FDTheme.muted
        }
    }
}

private struct NotificationListState: View {
    let symbol: String
    let title: String
    let detail: String
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 20, weight: .light))
                .foregroundStyle(FDTheme.subtle)
            Text(title)
                .font(NativePreferences.shared.font(size: 13, weight: .medium))
                .foregroundStyle(FDTheme.secondary)
            Text(detail)
                .font(NativePreferences.shared.font(size: 12))
                .foregroundStyle(FDTheme.muted)
                .multilineTextAlignment(.center)
                .lineLimit(4)
                .frame(maxWidth: 260)
            if let retry {
                Button("Try again", action: retry).controlSize(.small).padding(.top, 4)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct NotificationInlineMessage: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(message)
                .foregroundStyle(FDTheme.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) { Image(systemName: "xmark") }
                .buttonStyle(.plain)
                .foregroundStyle(FDTheme.muted)
                .accessibilityLabel("Dismiss message")
        }
        .font(NativePreferences.shared.font(size: 12))
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(FDTheme.raised)
    }
}
