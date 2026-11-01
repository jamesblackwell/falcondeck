import SwiftUI

/// What the web bot sidebar shows beside a bot's conversation, laid out as a
/// phone sheet: STATUS.md and its age, owned tickets, schedules and recent dispatches.
@MainActor @Observable final class BotInfoStore {
    private(set) var status: NativeBotDocument?
    private(set) var statusLoaded = false
    private(set) var statusFailed = false
    private(set) var tickets: [JSON] = []
    private(set) var ticketsFailed = false
    private(set) var schedules: [JSON] = []
    private(set) var schedulesFailed = false
    private(set) var observedAt = Date.now
    var pending: Set<String> = []
    @ObservationIgnored private var loading = false

    func load(_ bot: NativeBot, model: AppModel) async {
        guard !loading else { return }
        loading = true; defer { loading = false }
        let current = model.connectionID
        if model.demo {
            tickets = bot.raw["native_demo_tickets"].array
            schedules = model.automations.rows.map(\.raw)
            status = (try? await model.readBotDocument(bot, name: "STATUS.md")); statusLoaded = true; statusFailed = false
            observedAt = .now
            return
        }
        async let statusResult = readStatus(bot, model: model)
        async let ticketResult = page(model, resource: "tickets", filters: ["owner": .string(bot.name), "include_closed": .bool(false)], fields: [])
        async let scheduleResult = page(model, resource: "automations", filters: [:], fields: Self.scheduleFields)
        let (document, ticketRows, scheduleRows) = await (statusResult, ticketResult, scheduleResult)
        guard current == model.connectionID else { return }
        statusLoaded = true
        statusFailed = document.failed
        if !document.failed { status = document.document }
        if let ticketRows { tickets = ticketRows; ticketsFailed = false } else { ticketsFailed = true }
        if let scheduleRows { schedules = scheduleRows; schedulesFailed = false } else { schedulesFailed = true }
        observedAt = .now
    }

    func setEnabled(_ schedule: JSON, enabled: Bool, model: AppModel) async throws {
        let id = schedule["id"].string
        guard !pending.contains(id) else { return }
        pending.insert(id); defer { pending.remove(id) }
        let data = try await model.automations.execute(enabled ? "automation.resume" : "automation.pause", arguments: .object(["automation_id": .string(id)]), revision: schedule["revision"].int, model: model)
        let state = data["state"].string.nonempty ?? (enabled ? "enabled" : "paused")
        if let index = schedules.firstIndex(where: { $0["id"].string == id }) {
            schedules[index] = schedules[index].setting("state", .string(state)).setting("revision", data["revision"] == .null ? .number(Double(schedule["revision"].int + 1)) : data["revision"])
        }
    }

    private func readStatus(_ bot: NativeBot, model: AppModel) async -> (document: NativeBotDocument?, failed: Bool) {
        do {
            let names = try await model.botDocuments(bot)
            return (names.contains("STATUS.md") ? try await model.readBotDocument(bot, name: "STATUS.md") : nil, false)
        } catch { return (nil, true) }
    }

    private static let scheduleFields = ["id", "revision", "owner", "name", "state", "trigger", "target.thread", "next_run_at"].map(JSON.string)

    private func page(_ model: AppModel, resource: String, filters: [String: JSON], fields: [JSON]) async -> [JSON]? {
        var rows: [JSON] = [], cursor: String?
        for _ in 0..<5 {
            var params: [String: JSON] = ["resource": .string(resource), "filters": .object(filters), "limit": .number(100)]
            if !fields.isEmpty { params["fields"] = .array(fields) }
            if let cursor { params["cursor"] = .string(cursor) }
            guard let response = try? await model.relay.call("control.get", params: .object(params)) else { return nil }
            rows += response["data"].array
            cursor = response["next_cursor"].string.nonempty
            if cursor == nil { return rows }
        }
        return rows
    }
}

struct BotInfoView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let botID: String
    @State private var store = BotInfoStore()
    @State private var statusExpanded = false
    @State private var statusHeight: CGFloat = 0
    @State private var ticketsExpanded = false
    @State private var schedulesExpanded = false
    @State private var dispatchesExpanded = false
    @State private var editing = false
    @State private var error: String?
    private let limit = 8
    private let statusLimit: CGFloat = 260

    private var bot: NativeBot? { model.bots.first { $0.id == botID } }

    var body: some View {
        NavigationStack {
            if let bot {
                List {
                    header(bot)
                    statusSection
                    ticketsSection
                    schedulesSection(bot)
                    dispatchSection(bot)
                    if let error { Text(error).font(.footnote).foregroundStyle(FD.danger).listRowBackground(FD.surface) }
                }
                .scrollContentBackground(.hidden).background(FD.background)
                .navigationTitle(bot.name).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                    ToolbarItem(placement: .primaryAction) {
                        Button("Bot settings", systemImage: "slider.horizontal.3") { editing = true }
                            .accessibilityIdentifier("bot-info-settings")
                    }
                }
                .task(id: model.connected) { await store.load(bot, model: model) }
                .refreshable { await store.load(bot, model: model) }
                .sheet(isPresented: $editing) { NativeBotEditor(bot: bot) }
            } else {
                ContentUnavailableView("Bot unavailable", systemImage: "person.crop.square")
            }
        }
        .nativeOptionsSheet().accessibilityIdentifier("bot-info")
    }

    private func header(_ bot: NativeBot) -> some View {
        let icon = model.botIcons[bot.id]
        let home = model.task(bot.taskID)
        return HStack(spacing: 14) {
            if let icon { BotMark(icon: icon, size: 36) }
            VStack(alignment: .leading, spacing: 3) {
                Text(bot.name).font(.title3.weight(.semibold)).foregroundStyle(FD.foreground).lineLimit(2)
                Text([home?.provider.capitalized.nonempty, home.map { $0.working ? "Working" : $0.needsAttention ? "Needs you" : "Idle" }].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote).foregroundStyle(FD.secondary)
            }
            Spacer(minLength: 0)
        }
        .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 4, trailing: 4))
        .accessibilityElement(children: .combine)
    }

    // MARK: Status

    private var statusSection: some View {
        Section {
            if let document = store.status, !document.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if let date = ConversationActivity.date(document.modifiedAt) {
                    let stale = store.observedAt.timeIntervalSince(date) > 86_400
                    HStack(spacing: 6) {
                        if stale { Image(systemName: "clock.badge.exclamationmark") }
                        Text("Updated \(date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))")
                    }
                    .font(.caption).foregroundStyle(stale ? FD.warning : FD.muted)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(stale ? FD.warning.opacity(0.12) : .clear, in: .capsule)
                    .listRowBackground(FD.surface).listRowSeparator(.hidden)
                    .accessibilityLabel(stale ? "STATUS.md is more than 24 hours old" : "STATUS.md updated")
                    .accessibilityValue(date.formatted(.relative(presentation: .named)))
                    .accessibilityIdentifier("bot-status-age")
                }
                NativeMarkdown(text: document.content, font: .subheadline, foreground: FD.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { statusHeight = $0 }
                    .frame(maxHeight: statusExpanded ? nil : statusLimit, alignment: .top).clipped()
                    .mask { statusMask }
                    .listRowBackground(FD.surface)
                    .environment(\.openURL, OpenURLAction { url in
                        if let id = TranscriptThreadLink.parse(url.absoluteString) { Task { await model.openTask(id) }; dismiss(); return .handled }
                        return ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
                    })
                if statusHeight > statusLimit + 1 || statusExpanded {
                    Button(statusExpanded ? "Show less" : "Show more") { withAnimation(.snappy) { statusExpanded.toggle() } }
                        .font(.subheadline).foregroundStyle(FD.accent).listRowBackground(FD.surface)
                }
            } else {
                Text(store.statusFailed ? "Could not load STATUS.md." : store.statusLoaded ? "No STATUS.md yet." : "Loading status…")
                    .font(.footnote).foregroundStyle(FD.secondary).listRowBackground(FD.surface)
            }
        } header: { sectionHeader("Status") }
    }

    /// Fades the clipped tail so a truncated status reads as continuing.
    private var statusMask: some View {
        let fade = !statusExpanded && statusHeight > statusLimit + 1
        return VStack(spacing: 0) {
            Color.black
            if fade { LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 36) }
        }
    }

    // MARK: Tickets

    @ViewBuilder private var ticketsSection: some View {
        let open = store.tickets.filter { !["done", "dropped"].contains($0["state"].string) }
            .sorted { ($0["priority"].string, $0["created_at"].string) < ($1["priority"].string, $1["created_at"].string) }
        if !open.isEmpty || store.ticketsFailed {
            Section {
                if store.ticketsFailed { Text("Could not load tickets.").font(.footnote).foregroundStyle(FD.secondary).listRowBackground(FD.surface) }
                ForEach(ticketsExpanded ? open : Array(open.prefix(limit)), id: \.self) { ticket in
                    HStack(spacing: 10) {
                        Text(ticket["id"].string).font(.caption.monospaced()).foregroundStyle(FD.muted)
                        Text(ticket["title"].string).font(.subheadline).foregroundStyle(FD.foreground).lineLimit(2)
                        Spacer(minLength: 4)
                        Text(ticket["priority"].string).font(.caption).foregroundStyle(FD.muted)
                    }
                    .listRowBackground(FD.surface)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(ticket["id"].string): \(ticket["title"].string), \(ticket["priority"].string)")
                }
                if open.count > limit { showAll($ticketsExpanded, count: open.count) }
            } header: { sectionHeader("Tickets", count: open.count) }
        }
    }

    // MARK: Schedules

    @ViewBuilder private func schedulesSection(_ bot: NativeBot) -> some View {
        let targets = Set([bot.taskID] + bot.previousTaskIDs)
        let rows = store.schedules.filter { targets.contains($0["target"]["thread"]["thread_id"].string) }
            .sorted { ($0["next_run_at"].string.nonempty ?? "z", $0["name"].string) < ($1["next_run_at"].string.nonempty ?? "z", $1["name"].string) }
        if !rows.isEmpty || store.schedulesFailed {
            Section {
                if store.schedulesFailed { Text("Could not load schedules.").font(.footnote).foregroundStyle(FD.secondary).listRowBackground(FD.surface) }
                ForEach(schedulesExpanded ? rows : Array(rows.prefix(limit)), id: \.self) { schedule in
                    scheduleRow(schedule)
                }
                if rows.count > limit { showAll($schedulesExpanded, count: rows.count) }
            } header: { sectionHeader("Schedules", count: rows.count) }
        }
    }

    private func scheduleRow(_ schedule: JSON) -> some View {
        let id = schedule["id"].string, state = schedule["state"].string
        let locked = ["completed", "failed"].contains(state)
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(schedule["name"].string).font(.subheadline.weight(.medium)).foregroundStyle(FD.foreground).lineLimit(1)
                Text(Self.cadence(schedule)).font(.caption).foregroundStyle(FD.secondary).lineLimit(1)
                Text(state == "enabled" ? (AutomationDraft.parseDate(schedule["next_run_at"].string).map { "Next \($0.formatted(.dateTime.month(.abbreviated).day().hour().minute()))" } ?? "Enabled") : state.capitalized)
                    .font(.caption).foregroundStyle(FD.muted).lineLimit(1)
            }
            Spacer(minLength: 4)
            if store.pending.contains(id) { ActivityDiamond() }
            Toggle("\(schedule["name"].string) enabled", isOn: Binding(
                get: { state == "enabled" },
                set: { enabled in
                    Task {
                        do { try await store.setEnabled(schedule, enabled: enabled, model: model); error = nil }
                        catch { self.error = "Could not update automation. \(error.localizedDescription)" }
                        await store.load(bot ?? NativeBot(raw: .null), model: model)
                    }
                }))
                .labelsHidden().disabled(store.pending.contains(id) || locked || (!model.demo && !model.connected))
        }
        .listRowBackground(FD.surface)
        .accessibilityIdentifier("bot-schedule-\(id)")
    }

    private static func cadence(_ schedule: JSON) -> String {
        if let resolved = schedule["resolved_schedule"].string.nonempty { return resolved }
        let trigger = schedule["trigger"]
        switch trigger["kind"].string {
        case "interval": return every(seconds: trigger["every_seconds"].int)
        case "once": return AutomationDraft.parseDate(trigger["run_at"].string)?.formatted(date: .abbreviated, time: .shortened) ?? trigger["run_at"].string
        default: return [trigger["expression"].string, trigger["timezone"].string].filter { !$0.isEmpty }.joined(separator: " · ")
        }
    }

    /// 604,800 s reads "Every 7 days", not "Every 10080 minutes".
    static func every(seconds: Int) -> String {
        let minutes = max(1, seconds / 60)
        for (size, unit) in [(1440, "day"), (60, "hour"), (1, "minute")] where minutes % size == 0 {
            let count = minutes / size
            return count == 1 ? "Every \(unit)" : "Every \(count) \(unit)s"
        }
        return "Every \(minutes) minutes"
    }

    // MARK: Dispatches

    @ViewBuilder private func dispatchSection(_ bot: NativeBot) -> some View {
        let parents = Set([bot.taskID] + bot.previousTaskIDs)
        let now = Date.now, window: TimeInterval = 2 * 86_400
        let rows: [(task: AgentTask, at: Date)] = model.tasks.compactMap { task in
            let origin = task.raw["origin"]
            guard origin["kind"].string == "agent_spawn", parents.contains(origin["parent_thread_id"].string),
                  let at = ConversationActivity.date(origin["dispatched_at"].string.nonempty ?? task.updatedAt),
                  at <= now.addingTimeInterval(60), now.timeIntervalSince(at) <= window else { return nil }
            return (task, at)
        }.sorted { $0.at > $1.at }
        if !rows.isEmpty {
            Section {
                ForEach(dispatchesExpanded ? rows : Array(rows.prefix(limit)), id: \.task.id) { row in
                    Button { model.selection = .task(row.task.id); dismiss() } label: {
                        HStack(spacing: 10) {
                            Group {
                                if row.task.working { ActivityDiamond(size: 7) }
                                else if row.task.needsAttention { Circle().fill(FD.warning).frame(width: 7, height: 7) }
                                else { Circle().fill(row.task.status == "error" ? FD.danger : FD.muted.opacity(0.5)).frame(width: 7, height: 7) }
                            }.frame(width: 14)
                            Text(row.task.title.nonempty ?? "New task").font(.subheadline).foregroundStyle(FD.foreground).lineLimit(1)
                            Spacer(minLength: 4)
                            Text(row.at.formatted(.relative(presentation: .numeric, unitsStyle: .narrow))).font(.caption).foregroundStyle(FD.muted).lineLimit(1)
                        }.frame(minHeight: 28).contentShape(.rect)
                    }.buttonStyle(.plain).listRowBackground(FD.surface)
                        .accessibilityIdentifier("bot-dispatch-\(row.task.id)")
                }
                if rows.count > limit { showAll($dispatchesExpanded, count: rows.count) }
            } header: { sectionHeader("Dispatched", count: rows.count) }
        }
    }

    // MARK: Pieces

    private func sectionHeader(_ title: String, count: Int? = nil) -> some View {
        HStack(spacing: 6) {
            Text(title.uppercased()).tracking(0.8)
            if let count { Text("\(count)").foregroundStyle(FD.muted) }
        }.font(.system(.caption2, design: .monospaced).weight(.semibold)).foregroundStyle(FD.secondary)
    }

    private func showAll(_ expanded: Binding<Bool>, count: Int) -> some View {
        Button(expanded.wrappedValue ? "Show less" : "Show all \(count)") { withAnimation(.snappy) { expanded.wrappedValue.toggle() } }
            .font(.subheadline).foregroundStyle(FD.accent).listRowBackground(FD.surface)
    }
}
