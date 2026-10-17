import SwiftUI

struct ActivityView: View {
    @Environment(AppModel.self) private var model
    @State private var filter = "Working"
    private var tasks: [AgentTask] {
        model.tasks.filter { filter == "Working" ? $0.running : filter == "Needs you" ? $0.needsAttention : true }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Keep a finger on the pulse.").font(.title2.weight(.semibold)).padding(.top, 8)
                Text("A quiet view of what’s moving across your projects.").font(.subheadline).foregroundStyle(FD.secondary)
                Picker("Activity filter", selection: $filter) {
                    ForEach(["Working", "Needs you", "All"], id: \.self) { Text($0) }
                }.pickerStyle(.segmented)
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(tasks) { task in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(model.projects.first { $0.id == task.projectID }?.name ?? "Project")
                                .font(.caption.weight(.medium)).foregroundStyle(FD.secondary).padding(.leading, 4)
                            NavigationLink { ConversationView(task: task) } label: { TaskRow(task: task) }.buttonStyle(.plain)
                        }
                    }
                }
                if tasks.isEmpty {
                    ContentUnavailableView("All quiet", systemImage: "waveform.path", description: Text(model.projects.isEmpty ? "Connect your computer or explore the demo to get started." : "There are no tasks in this view."))
                }
            }.padding(FD.inset).frame(maxWidth: 720).frame(maxWidth: .infinity)
        }
        .background(FD.background).navigationTitle("Activity")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { ConnectionPill() } }
        .refreshable { await model.refresh() }
        .sensoryFeedback(.selection, trigger: filter)
    }
}
