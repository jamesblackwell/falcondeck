import SwiftUI

enum ActivitySection: String, CaseIterable {
    case blocked = "Needs input", failed = "Failed", ready = "Ready to review", running = "Running", recent = "Recent"
    static func section(_ task: AgentTask, requests: [JSON]) -> ActivitySection {
        section(task, requested: requests.contains { $0["thread_id"].string == task.id })
    }
    static func section(_ task: AgentTask, requested: Bool) -> ActivitySection {
        if task.awaitingInput || requested { return .blocked }
        if task.status == "error", task.unread { return .failed }
        if task.working { return .running }
        if task.status == "idle", task.unread { return .ready }
        return .recent
    }
    var symbol: String {
        switch self {
        case .blocked: "hand.raised.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .ready: "checkmark.circle.fill"
        case .running: "bolt.fill"
        case .recent: "clock"
        }
    }
    @MainActor var tint: Color {
        switch self {
        case .blocked: FD.warning
        case .failed: FD.danger
        case .ready: FD.accent
        case .running: FD.accent
        case .recent: FD.muted
        }
    }
}

/// Short relative timestamps for dense task lists: "now", "4m", "3h", "2d", "12 Oct".
enum RelativeStamp {
    static func short(_ value: String, now: Date) -> String? {
        guard let date = ConversationActivity.date(value) else { return nil }
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h" }
        if seconds < 7 * 86400 { return "\(Int(seconds / 86400))d" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}

/// A shared minute clock keeps every relative timestamp current without a
/// timer per row.
@MainActor @Observable final class MinuteClock {
    static let shared = MinuteClock()
    private(set) var now = Date.now
    @ObservationIgnored private var ticker: Task<Void, Never>?
    func start() {
        guard ticker == nil else { return }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                self?.now = .now
            }
        }
    }
}

struct ActivityView: View {
    @Environment(AppModel.self) private var model
    @State private var loadingMore = false
    private var entries: [ActivitySection: [AgentTask]] {
        let hidden = Set(model.preferences["hidden_workspace_ids"].array.map(\.string))
        let casual = Set(model.projects.filter { $0.raw["kind"].string == "casual" }.map(\.id))
        let requested = Set(model.requests.map { $0["thread_id"].string })
        let visible = model.tasks.filter { !hidden.contains($0.projectID) || casual.contains($0.projectID) }
        return Dictionary(grouping: visible.sorted { $0.updatedAt > $1.updatedAt }) { ActivitySection.section($0, requested: requested.contains($0.id)) }
    }
    var body: some View {
        // Group once per render; each section previously regrouped every task.
        let entries = entries
        let names = Dictionary(model.projects.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        let now = MinuteClock.shared.now
        List {
            ForEach(ActivitySection.allCases, id: \.self) { section in
                let rows = entries[section] ?? []
                if !rows.isEmpty {
                    Section {
                        ForEach(Array(rows.prefix(section == .recent ? 50 : rows.count))) { task in
                            ActivityRow(task: task, section: section, project: names[task.projectID], stamp: RelativeStamp.short(task.updatedAt, now: now))
                                .listRowBackground(Color.clear)
                                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                                .listRowSeparatorTint(FD.hairline)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Image(systemName: section.symbol).foregroundStyle(section.tint)
                            Text(section.rawValue.uppercased()).tracking(0.8)
                            Text("\(rows.count)").foregroundStyle(FD.muted)
                        }
                        .font(.system(.caption2, design: .monospaced).weight(.semibold))
                        .foregroundStyle(FD.secondary)
                        .padding(.top, 10).padding(.bottom, 2)
                    }
                }
            }
            if entries.isEmpty {
                ContentUnavailableView("All quiet", systemImage: "checkmark.circle", description: Text("Running tasks and anything that needs you will appear here."))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if model.sortedProjects.contains(where: { model.hasMoreTasks($0.id) }) {
                Button {
                    loadingMore = true
                    Task { defer { loadingMore = false }; for project in model.sortedProjects.filter({ model.hasMoreTasks($0.id) }).prefix(4) { await model.loadTaskPage(project.id) } }
                } label: {
                    HStack(spacing: 8) {
                        if loadingMore { ActivityDiamond(size: 7) }
                        Text(loadingMore ? "Loading tasks…" : "Load more recent tasks")
                    }.font(.footnote.weight(.medium)).frame(maxWidth: .infinity, minHeight: 44)
                }
                .foregroundStyle(FD.accent).disabled(loadingMore || !model.connected)
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden).background(FD.background).navigationTitle("Activity")
        .refreshable { await model.refresh() }
        .onAppear { MinuteClock.shared.start() }
    }
}

private struct ActivityRow: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    let section: ActivitySection
    let project: String?
    let stamp: String?
    var body: some View {
        Button { model.selection = .task(task.id) } label: {
            HStack(alignment: .top, spacing: 12) {
                Group {
                    if task.working { ActivityDiamond(size: 8) }
                    else if section == .recent { Circle().fill(task.unread ? FD.unread : .clear).frame(width: 7, height: 7) }
                    else { Circle().fill(section.tint).frame(width: 7, height: 7) }
                }.frame(width: 12, height: 20)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(task.title.nonempty ?? "New task").font(.subheadline.weight(task.unread || section != .recent ? .semibold : .regular))
                            .foregroundStyle(FD.foreground).lineLimit(1)
                        Spacer(minLength: 4)
                        if let stamp { Text(stamp).font(.caption.monospacedDigit()).foregroundStyle(FD.muted) }
                    }
                    if !task.preview.isEmpty {
                        Text(task.preview).font(.footnote).foregroundStyle(FD.secondary).lineLimit(2)
                    }
                    Text([project, task.provider.capitalized.nonempty].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(FD.muted).lineLimit(1)
                }
            }
            .padding(.vertical, 10).contentShape(.rect)
        }
        .buttonStyle(NativePressStyle(scales: false, feedback: .selection))
        .accessibilityIdentifier("activity-task-\(task.id)")
        .contextMenu { TaskActions(task: task) }
        .swipeActions(edge: .leading) { TaskReadButton(task: task).tint(FD.accent) }
    }
}
