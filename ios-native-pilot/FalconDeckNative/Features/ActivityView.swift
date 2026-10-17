import SwiftUI

enum ActivitySection: String, CaseIterable {
    case blocked = "Needs input", failed = "Failed", ready = "Ready to review", running = "Running", recent = "Recent"
    static func section(_ task: AgentTask, requests: [JSON]) -> ActivitySection {
        if task.awaitingInput || requests.contains(where: { $0["thread_id"].string == task.id }) { return .blocked }
        if task.status == "error", task.unread { return .failed }
        if task.working { return .running }
        if task.status == "idle", task.unread { return .ready }
        return .recent
    }
}

struct ActivityView: View {
    @Environment(AppModel.self) private var model
    @State private var loadingMore = false
    private var entries: [ActivitySection: [AgentTask]] {
        let hidden = Set(model.preferences["hidden_workspace_ids"].array.map(\.string))
        let visible = model.tasks.filter { task in !hidden.contains(task.projectID) || model.projects.first(where: { $0.id == task.projectID })?.raw["kind"].string == "casual" }
        return Dictionary(grouping: visible.sorted { $0.updatedAt > $1.updatedAt }) { ActivitySection.section($0, requests: model.requests) }
    }
    var body: some View {
        List {
            ForEach(ActivitySection.allCases, id: \.self) { section in
                let rows = entries[section] ?? []
                if !rows.isEmpty {
                    Section("\(section.rawValue) · \(rows.count)") {
                        ForEach(Array(rows.prefix(section == .recent ? 50 : rows.count))) { task in
                            Button { model.selection = .task(task.id) } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(model.projects.first { $0.id == task.projectID }?.name ?? "Project").font(.caption).foregroundStyle(FD.secondary)
                                    HStack { Text(task.title).font(.subheadline.weight(.medium)); Spacer(); if task.working { ActivityDiamond() } }
                                    if !task.preview.isEmpty { Text(task.preview).font(.footnote).foregroundStyle(FD.secondary).lineLimit(1) }
                                }.padding(.vertical, 2)
                            }.foregroundStyle(FD.foreground).contextMenu { TaskActions(task: task) }
                        }
                    }.listRowBackground(Color.clear)
                }
            }
            if entries.isEmpty { ContentUnavailableView("All quiet", systemImage: "waveform.path") }
            if model.sortedProjects.contains(where: { model.hasMoreTasks($0.id) }) {
                Button(loadingMore ? "Loading tasks…" : "Load more recent tasks") {
                    loadingMore = true
                    Task { defer { loadingMore = false }; for project in model.sortedProjects.filter({ model.hasMoreTasks($0.id) }).prefix(4) { await model.loadTaskPage(project.id) } }
                }.disabled(loadingMore || !model.connected)
            }
        }.listStyle(.plain).scrollContentBackground(.hidden).background(FD.background).navigationTitle("Activity")
            .refreshable { await model.refresh() }
    }
}
