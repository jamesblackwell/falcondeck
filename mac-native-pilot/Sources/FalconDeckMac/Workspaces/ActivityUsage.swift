import AppKit
import SwiftUI

enum NativeActivitySection: String, CaseIterable, Identifiable {
    case blocked = "Needs you", failed = "Failed", ready = "Ready to review", running = "Working", recent = "Recent"
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .blocked: "hand.raised"
        case .failed: "exclamationmark.circle"
        case .ready: "checkmark.circle"
        case .running: "diamond"
        case .recent: "clock"
        }
    }
    @MainActor var color: Color {
        switch self {
        case .blocked: FDTheme.warning
        case .failed: FDTheme.danger
        case .ready: FDTheme.info
        case .running: FDTheme.accent
        case .recent: FDTheme.muted
        }
    }
    static func section(_ task: AgentTask) -> Self {
        if task.awaitingInput { return .blocked }
        if (task.status == "error" || task.raw["attention"]["level"].string == "error"), task.unread { return .failed }
        if task.running || (task.status == "idle" && task.raw["attention"]["background_task_count"].int > 0) { return .running }
        if task.status == "idle", task.unread { return .ready }
        return .recent
    }
}

struct NativeActivityView: View {
    @Bindable var store: AppStore
    var allowsPopOut = true
    @AppStorage("native.activity.layout") private var layout = "inbox"
    @State private var search = ""
    @State private var unreadOnly = false
    @State private var error: String?
    @State private var pendingIDs: Set<String> = []
    @State private var preview: AgentTask?

    private var rows: [AgentTask] {
        let hidden = Set(store.preferences["hidden_workspace_ids"].array.map(\.string))
        return store.tasks.filter { task in
            guard !task.raw["is_archived"].bool else { return false }
            let project = store.allProjects.first { $0.id == task.projectID }
            if hidden.contains(task.projectID), project?.raw["kind"].string != "casual" { return false }
            if unreadOnly && !Self.isUnread(task) { return false }
            if !search.isEmpty && ![task.title, task.preview, project?.name ?? ""].contains(where: { $0.localizedCaseInsensitiveContains(search) }) { return false }
            if NativeActivitySection.section(task) != .recent { return true }
            guard task.raw["attention"]["last_agent_activity_seq"].int > 0,
                  let date = NativeWorkspaceDates.parse(task.updatedAt) else { return false }
            return date.timeIntervalSinceNow > -7 * 24 * 60 * 60
        }.sorted {
            if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
            return $0.id < $1.id
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let error { NativeWorkspaceNotice(message: error) { self.error = nil } }
            if rows.isEmpty {
                NativeEmptyState(symbol: "tray", title: search.isEmpty ? "All quiet" : "No matching tasks", detail: search.isEmpty ? "Running tasks, approvals and new replies across your projects appear here." : "Try another title, message or project name.")
            } else if layout == "board" {
                board
            } else {
                inbox
            }
        }
        .background(FDTheme.background)
        .sheet(item: $preview) { task in NativeActivityPreview(store: store, task: task) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Activity").font(NativePreferences.shared.font(size: 18, weight: .semibold)).foregroundStyle(FDTheme.foreground)
                    Text(store.isConnected ? "Live across all your projects" : "Reconnecting · showing last known activity")
                        .font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted)
                }
                Spacer()
                Picker("Layout", selection: $layout) {
                    Image(systemName: "list.bullet").tag("inbox").help("Inbox")
                    Image(systemName: "rectangle.split.3x1").tag("board").help("Board")
                }.pickerStyle(.segmented).frame(width: 88)
                if allowsPopOut {
                    Button { NativeActivityWindow.shared.show(store: store) } label: { Image(systemName: "arrow.up.right.square") }
                        .buttonStyle(NativeIconButtonStyle()).help("Open Activity in a separate window")
                }
            }
            HStack(spacing: 14) {
                HStack(spacing: 7) {
                    Image(systemName: "magnifyingglass").foregroundStyle(FDTheme.muted)
                    TextField("Search activity", text: $search).textFieldStyle(.plain)
                }.padding(8).background(FDTheme.raised, in: .rect(cornerRadius: 7))
                Toggle("Unread", isOn: $unreadOnly).toggleStyle(.checkbox).fixedSize()
                Button("Mark all read") { Task { await markAllRead() } }
                    .disabled(!store.isConnected || !pendingIDs.isEmpty || !rows.contains(where: { $0.unread && NativeActivitySection.section($0) != .running }))
            }.font(NativePreferences.shared.font(size: 13))
        }.padding(24)
            .overlay(alignment: .bottom) { Rectangle().fill(FDTheme.hairline).frame(height: 1) }
    }

    private var inbox: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                let needsYou = rows.filter { [.blocked, .failed].contains(NativeActivitySection.section($0)) }
                let feed = rows.filter { ![.blocked, .failed].contains(NativeActivitySection.section($0)) }
                if !needsYou.isEmpty { activityGroup("Needs you", tasks: needsYou) }
                if !feed.isEmpty { activityGroup("Latest activity", tasks: feed) }
            }.padding(24)
        }
    }

    private var board: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 14) {
                ForEach(NativeActivitySection.allCases) { section in
                    let tasks = rows.filter { task in
                        guard NativeActivitySection.section(task) == section else { return false }
                        if section != .recent { return true }
                        return NativeWorkspaceDates.parse(task.updatedAt).map { $0.timeIntervalSinceNow > -6 * 60 * 60 } ?? false
                    }
                    if !tasks.isEmpty {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 8) {
                                Label("\(section.rawValue) · \(tasks.count)", systemImage: section.symbol)
                                    .font(NativePreferences.shared.font(size: 13, weight: .semibold)).foregroundStyle(section.color).padding(.bottom, 6)
                                ForEach(Array(tasks.prefix(section == .recent ? 12 : tasks.count))) { task in activityRow(task) }
                            }.padding(12)
                        }.frame(width: 310).background(FDTheme.surface, in: .rect(cornerRadius: 10))
                    }
                }
            }.padding(24)
        }
    }

    private func activityGroup(_ title: String, tasks: [AgentTask]) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("\(title) · \(tasks.count)").font(NativePreferences.shared.font(size: 13, weight: .semibold)).foregroundStyle(FDTheme.muted)
            LazyVStack(spacing: 1) { ForEach(tasks) { task in activityRow(task) } }
        }
    }

    private func activityRow(_ task: AgentTask) -> some View {
        let section = NativeActivitySection.section(task)
        return Button { Task { await store.selectTask(task.id) } } label: {
            HStack(alignment: .top, spacing: 12) {
                Group {
                    if section == .running { MacActivityDiamond() }
                    else { Image(systemName: section.symbol).font(.system(size: 13)).foregroundStyle(section.color) }
                }.frame(width: 16, height: 18)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(task.title).font(NativePreferences.shared.font(size: 13, weight: Self.isUnread(task) ? .semibold : .medium))
                            .foregroundStyle(FDTheme.foreground).lineLimit(1)
                        Spacer(minLength: 4)
                        if task.unread && section != .running { Circle().fill(FDTheme.info).frame(width: 6, height: 6).accessibilityLabel("Unread") }
                    }
                    Text(store.allProjects.first { $0.id == task.projectID }?.name ?? "Project")
                        .font(NativePreferences.shared.font(size: 11)).foregroundStyle(FDTheme.muted)
                    let description = section == .failed ? task.raw["last_error"].string : task.preview
                    if !description.isEmpty { Text(description).font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.secondary).lineLimit(2) }
                    HStack {
                        Text(FDTheme.providerName(task.provider))
                        Text("·")
                        Text(section == .recent ? FDTheme.statusLabel(task.status) : section.rawValue)
                        Spacer(minLength: 4)
                        if let date = NativeWorkspaceDates.parse(task.updatedAt) { Text(date, style: .relative) }
                    }.font(NativePreferences.shared.font(size: 11)).foregroundStyle(FDTheme.muted)
                }
                if pendingIDs.contains(task.id) { ProgressView().controlSize(.small) }
            }.padding(13).background(FDTheme.surface, in: .rect(cornerRadius: 8)).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Open task") { Task { await store.selectTask(task.id) } }
            Button("Quick Look") { preview = task }
            Divider()
            Button(task.unread ? "Mark as read" : "Mark as unread") { Task { await mark(task, read: task.unread) } }
                .disabled(!store.isConnected || pendingIDs.contains(task.id))
            Button("Copy task title") { FDTheme.copy(task.title) }
        }
        .accessibilityElement(children: .combine)
    }

    private func markAllRead() async {
        let tasks = rows.filter { $0.unread && NativeActivitySection.section($0) != .running }
        for task in tasks { await mark(task, read: true) }
    }

    private static func isUnread(_ task: AgentTask) -> Bool {
        [.blocked, .failed, .ready].contains(NativeActivitySection.section(task))
    }

    private func mark(_ task: AgentTask, read: Bool) async {
        guard !pendingIDs.contains(task.id) else { return }
        pendingIDs.insert(task.id)
        defer { pendingIDs.remove(task.id) }
        do {
            let body: JSON? = read ? .object(["read_seq": .number(Double(task.raw["attention"]["last_agent_activity_seq"].int))]) : nil
            let path = "/api/workspaces/\(NativeWorkspaceDates.pathComponent(task.projectID))/threads/\(NativeWorkspaceDates.pathComponent(task.id))/\(read ? "read" : "unread")"
            // The event stream merges attention into the current task. An HTTP
            // response can arrive after newer activity, so never replace the
            // whole live summary with this response.
            _ = try await store.request(path: path, method: "POST", body: body)
        } catch { self.error = "Couldn’t update task. \(error.localizedDescription)" }
    }
}

@MainActor private final class NativeActivityWindow: NSObject, NSWindowDelegate {
    static let shared = NativeActivityWindow()
    private var window: NSWindow?
    func show(store: AppStore) {
        if let window { window.makeKeyAndOrderFront(nil); return }
        let next = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 650, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        next.title = "Activity — FalconDeck"
        next.minSize = NSSize(width: 420, height: 420)
        next.contentView = NSHostingView(rootView: NativeActivityView(store: store, allowsPopOut: false))
        next.isReleasedWhenClosed = false
        next.delegate = self
        next.center()
        window = next
        next.makeKeyAndOrderFront(nil)
    }
    func windowWillClose(_ notification: Notification) { window = nil }
}

private struct NativeActivityPreview: View {
    let store: AppStore
    let task: AgentTask
    @Environment(\.dismiss) private var dismiss
    @State private var messages: [Message] = []
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title).font(.headline).lineLimit(1)
                    Text("Recent messages").font(.caption).foregroundStyle(FDTheme.muted)
                }
                Spacer()
                Button("Open task") { dismiss(); Task { await store.selectTask(task.id) } }
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }.padding(20)
            Divider()
            if loading { ProgressView("Loading messages…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            else if let error { NativeEmptyState(symbol: "exclamationmark.triangle", title: "Couldn’t load preview", detail: error) }
            else if messages.isEmpty { NativeEmptyState(symbol: "bubble.left", title: "No messages yet", detail: "This task has no recent messages to preview.") }
            else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(messages) { message in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(message.role == "user" ? "You" : FDTheme.providerName(task.provider)).font(.caption.weight(.semibold)).foregroundStyle(FDTheme.muted)
                                Text(message.text).font(NativePreferences.shared.font(size: 13)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }.padding(24)
                }
            }
        }.frame(width: 650, height: 620).background(FDTheme.background)
            .task {
                do {
                    let path = "/api/workspaces/\(NativeWorkspaceDates.pathComponent(task.projectID))/threads/\(NativeWorkspaceDates.pathComponent(task.id))?mode=tail&limit=30&strict_limit=true&inline_images=false&tool_output_bytes=0&compact_workspace=true"
                    let result = try await store.request(path: path)
                    messages = result["items"].array.map(Message.init).filter(\.isMessage)
                } catch { self.error = error.localizedDescription }
                loading = false
            }
    }
}

struct NativeUsageView: View {
    let store: AppStore
    @State private var overview: JSON?
    @State private var loading = false
    @State private var error: String?
    @State private var notice: String?
    @State private var pendingCredit: NativeUsageCredit?
    @State private var consumingID: String?
    @State private var redemptionIDs: [String: String] = [:]

    private var providers: [NativeUsageProvider] {
        NativeUsageProvider.all.filter {
            guard let overview else { return false }
            let status = overview[$0.id]["status"].string
            return !status.isEmpty && status != "not_installed"
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Usage").font(NativePreferences.shared.font(size: 18, weight: .semibold))
                        Text("Subscription limits and spend for your connected agents.")
                            .font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted)
                    }
                    Spacer()
                    Button { Task { await load(refresh: true) } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                        .disabled(loading || consumingID != nil || !store.isConnected)
                }
                if let error { NativeWorkspaceNotice(message: error) { self.error = nil } }
                if let notice { NativeWorkspaceNotice(message: notice, isError: false) { self.notice = nil } }
                if let date = overview.flatMap({ NativeWorkspaceDates.parse($0["refreshed_at"].string) }) {
                    Text("Last refreshed \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(FDTheme.muted)
                }
                if loading && overview == nil { ProgressView("Reading usage…").padding(.vertical, 70).frame(maxWidth: .infinity) }
                else if overview == nil {
                    VStack(spacing: 14) {
                        Text("Usage could not be loaded.").foregroundStyle(FDTheme.muted)
                        Button("Try again") { Task { await load() } }.disabled(loading)
                    }.frame(maxWidth: .infinity).padding(40)
                } else if providers.isEmpty {
                    NativeEmptyState(symbol: "chart.bar", title: "No subscriptions detected", detail: "Install and sign in to a supported agent, or add a Z.AI or OpenRouter key to see usage.")
                } else {
                    ForEach(providers) { provider in
                        NativeUsageProviderCard(provider: provider, usage: overview?[provider.id] ?? .null, consumingID: consumingID, canUseReset: !loading && store.isConnected) { pendingCredit = $0 }
                    }
                }
                Text("Credentials stay with each agent. Session windows and reset times are reported by the provider.")
                    .font(.caption).foregroundStyle(FDTheme.muted)
            }.padding(30).frame(maxWidth: 800, alignment: .leading).frame(maxWidth: .infinity)
        }
        .background(FDTheme.background).foregroundStyle(FDTheme.foreground)
        .task { await load() }
        .onChange(of: store.isConnected) { _, connected in
            if connected && overview == nil { Task { await load() } }
        }
        .confirmationDialog("Use Codex usage reset?", isPresented: Binding(get: { pendingCredit != nil }, set: { if !$0 { pendingCredit = nil } }), titleVisibility: .visible) {
            if let credit = pendingCredit {
                Button("Use reset") { Task { await consume(credit) } }
            }
            Button("Cancel", role: .cancel) { pendingCredit = nil }
        } message: {
            Text("This refreshes your 5-hour and weekly Codex limits and moves the weekly reset date to about seven days from now.")
        }
    }

    private func load(refresh: Bool = false) async {
        guard !loading, consumingID == nil else { return }
        loading = true
        defer { loading = false }
        do {
            overview = try await store.request(path: "/api/provider-usage\(refresh ? "?refresh=true" : "")")
            error = nil
        } catch { self.error = "Couldn’t reload usage. \(error.localizedDescription)" }
    }

    private func consume(_ credit: NativeUsageCredit) async {
        guard consumingID == nil, !loading, store.isConnected else { return }
        let key = credit.id
        let requestID = redemptionIDs[key] ?? UUID().uuidString.lowercased()
        redemptionIDs[key] = requestID
        consumingID = key
        pendingCredit = nil
        defer { consumingID = nil }
        do {
            let result = try await store.request(path: "/api/provider-usage/codex/reset-credits/consume", method: "POST", body: .object([
                "credit_id": credit.wireID.map(JSON.string) ?? .null,
                "redeem_request_id": .string(requestID)
            ]))
            redemptionIDs.removeValue(forKey: key)
            overview = result["usage"]
            error = nil
            switch result["outcome"].string {
            case "reset": notice = "Codex usage limits were reset."
            case "nothing_to_reset": notice = "Nothing to reset. This credit is still available."
            case "no_credit": notice = "No Codex reset credits are available."
            case "already_redeemed": notice = "That reset was already used."
            default: notice = "Usage was refreshed."
            }
        } catch { self.error = "Couldn’t confirm the reset. Retrying uses the same request. \(error.localizedDescription)" }
    }
}

private struct NativeUsageProvider: Identifiable {
    let id: String
    let name: String
    let command: String
    static let all: [Self] = [
        .init(id: "codex", name: "Codex", command: "codex login"),
        .init(id: "claude_code", name: "Claude Code", command: "claude"),
        .init(id: "agy", name: "Antigravity", command: "agy"),
        .init(id: "grok", name: "Grok", command: "grok login"),
        .init(id: "cursor", name: "Cursor", command: "cursor-agent login"),
        .init(id: "zai", name: "Z.AI", command: "opencode auth login"),
        .init(id: "openrouter", name: "OpenRouter", command: "opencode auth login")
    ]
}

private struct NativeUsageCredit: Identifiable {
    let id: String
    let wireID: String?
    let title: String
    let expiry: Date?
}

private struct NativeUsageProviderCard: View {
    let provider: NativeUsageProvider
    let usage: JSON
    let consumingID: String?
    let canUseReset: Bool
    let onUseReset: (NativeUsageCredit) -> Void
    @State private var spendPeriod = "This month"

    private var credits: [NativeUsageCredit] {
        let value = usage["reset_credits"]
        let rows = value["credits"].array.map { NativeUsageCredit(id: $0["id"].string, wireID: $0["id"].string, title: $0["title"].string, expiry: NativeWorkspaceDates.parse($0["expires_at"].string)) }
        if !rows.isEmpty { return rows }
        return value["available_count"].int > 0 ? [NativeUsageCredit(id: "*", wireID: nil, title: "Full reset · \(value["available_count"].int) available", expiry: nil)] : []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "chart.bar.xaxis").foregroundStyle(FDTheme.muted)
                Text(provider.name).font(NativePreferences.shared.font(size: 15, weight: .semibold))
                let plan = usage["plan_label"].string
                if !plan.isEmpty { Text(plan).font(NativePreferences.shared.font(size: 11, weight: .medium)).padding(.horizontal, 7).padding(.vertical, 3).background(FDTheme.raised, in: .capsule) }
                Spacer()
            }
            let email = usage["account_email"].string
            if !email.isEmpty { Text(email).font(.caption).foregroundStyle(FDTheme.muted).textSelection(.enabled) }
            usageBody
        }.padding(20).background(FDTheme.surface, in: .rect(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).stroke(FDTheme.line, lineWidth: 1) }
    }

    @ViewBuilder private var usageBody: some View {
        switch usage["status"].string {
        case "ok":
            let windows = usage["windows"].array
            if windows.isEmpty && credits.isEmpty { Text("No usage limits reported for this plan.").font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted) }
            if provider.id == "openrouter" && !windows.isEmpty {
                Picker("Spend period", selection: $spendPeriod) {
                    Text("Day").tag("Today")
                    Text("Week").tag("This week")
                    Text("Month").tag("This month")
                }.pickerStyle(.segmented).frame(maxWidth: 250)
                NativeUsageWindowRow(window: windows.first { $0["label"].string == spendPeriod } ?? windows[0])
            } else {
                ForEach(Array(windows.enumerated()), id: \.offset) { _, window in NativeUsageWindowRow(window: window) }
            }
            if provider.id == "codex" && !credits.isEmpty {
                Divider().overlay(FDTheme.line)
                Text("Usage limit resets").font(.caption.weight(.medium)).foregroundStyle(FDTheme.muted)
                ForEach(credits) { credit in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(credit.title).font(NativePreferences.shared.font(size: 13))
                            if let expiry = credit.expiry { Text(expiry < Date() ? "Expired" : "Expires \(expiry.formatted(date: .abbreviated, time: .shortened))").font(.caption2).foregroundStyle(FDTheme.muted) }
                        }
                        Spacer()
                        if consumingID == credit.id { ProgressView().controlSize(.small) }
                        Button("Use reset") { onUseReset(credit) }.disabled(!canUseReset || consumingID != nil || (credit.expiry.map { $0 < Date() } ?? false))
                    }
                }
            }
        case "error":
            Text(usage["message"].string).font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.danger).textSelection(.enabled)
        case "expired":
            Text("Your session expired. Run `\(provider.command)` to sign in again, then reload usage.").font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted)
        case "unauthenticated":
            Text(provider.id == "openrouter" ? "Add an OpenRouter key in Settings → Models & keys or OpenCode, then reload usage." : "Run `\(provider.command)` to sign in and see your usage.").font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted)
        default:
            Text("Usage is unavailable.").font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted)
        }
    }
}

private struct NativeUsageWindowRow: View {
    let window: JSON
    private var percent: Double { if case .number(let value) = window["used_percent"], value.isFinite { return max(0, min(100, value)) }; return 0 }
    private var hasCost: Bool { window["cost"] != .null }
    private var limit: Double? { if case .number(let value) = window["cost"]["limit_usd_cents"], value > 0 { return value / 100 }; return nil }
    private var spent: Double { if case .number(let value) = window["cost"]["used_usd_cents"] { return value / 100 }; return 0 }
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(window["label"].string).font(NativePreferences.shared.font(size: 13, weight: .medium))
                Spacer()
                if hasCost {
                    Text(limit.map { "\(spent.formatted(.currency(code: "USD"))) / \($0.formatted(.currency(code: "USD")))" } ?? "\(spent.formatted(.currency(code: "USD"))) spent")
                        .font(NativePreferences.shared.font(size: 13)).monospacedDigit().foregroundStyle(FDTheme.muted)
                } else { Text("\(percent.formatted(.number.precision(.fractionLength(0...1))))% used").font(NativePreferences.shared.font(size: 13)).monospacedDigit().foregroundStyle(FDTheme.muted) }
            }
            if !hasCost || limit != nil {
                ProgressView(value: percent, total: 100).tint(percent >= 95 ? FDTheme.danger : percent >= 80 ? FDTheme.warning : FDTheme.accent)
                    .accessibilityLabel(window["label"].string).accessibilityValue("\(Int(percent)) percent used")
            }
            if let reset = NativeWorkspaceDates.parse(window["resets_at"].string) {
                HStack(spacing: 3) {
                    Text(reset < Date() ? "Resetting now" : "Resets")
                    if reset >= Date() { Text(reset, style: .relative) }
                }.font(.caption2).foregroundStyle(FDTheme.muted).help(reset.formatted(date: .complete, time: .shortened))
            }
        }
    }
}

private struct NativeWorkspaceNotice: View {
    let message: String
    var isError = true
    let dismiss: () -> Void
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: isError ? "exclamationmark.circle" : "checkmark.circle")
            Text(message).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("Dismiss message")
        }.font(NativePreferences.shared.font(size: 13)).foregroundStyle(isError ? FDTheme.danger : FDTheme.accent)
            .padding(12).background(FDTheme.raised, in: .rect(cornerRadius: 8))
    }
}

@MainActor private enum NativeWorkspaceDates {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let standard = ISO8601DateFormatter()
    static func parse(_ value: String) -> Date? {
        guard !value.isEmpty else { return nil }
        return fractional.date(from: value) ?? standard.date(from: value)
    }
    static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }
}
