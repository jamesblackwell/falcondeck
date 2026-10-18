import SwiftUI

struct DeveloperSettingsView: View {
    @AppStorage("native.debug.overlay") private var overlay = false
    @State private var sample = PerformanceSample.current()
    var body: some View {
        Form {
            Section("Performance") {
                LabeledContent("CPU", value: String(format: "%.1f%%", sample.cpu))
                LabeledContent("Resident memory", value: ByteCountFormatter.string(fromByteCount: Int64(sample.memory), countStyle: .memory))
                LabeledContent("Threads", value: String(sample.threads))
                Toggle("Performance overlay", isOn: $overlay)
            }.listRowBackground(FD.surface)
            Section("Connection") { NavigationLink("Connection log", value: DetailDestination.connectionLog) }.listRowBackground(FD.surface)
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Developer")
            .task {
                while !Task.isCancelled {
                    sample = PerformanceSample.current()
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                }
            }
    }
}

struct ConnectionLogView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        List {
            Section {
                LabeledContent("Status", value: model.status)
                LabeledContent("Projects", value: String(model.projects.count))
                LabeledContent("Tasks", value: String(model.tasks.count))
                if let refreshed = model.refreshedAt { LabeledContent("Last synced") { Text(refreshed, style: .time) } }
            }.listRowBackground(FD.surface)
            Section("Connection events") {
                ForEach(model.connectionLog.reversed()) { entry in
                    HStack(alignment: .top) { Text(entry.date, style: .time).font(.caption.monospacedDigit()).foregroundStyle(FD.secondary); Text(entry.message).font(.footnote) }
                        .listRowBackground(FD.surface)
                }
            }
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Connection log")
            .toolbar { Button("Clear") { model.connectionLog = [] } }
    }
}

struct PerformanceOverlay: View {
    @Environment(\.scenePhase) private var scene
    @State private var sample = PerformanceSample.current()
    var body: some View {
        Text(String(format: "CPU %.1f%% · %.0f MB", sample.cpu, Double(sample.memory) / 1_048_576))
            .font(.caption2.monospaced()).foregroundStyle(FD.secondary).padding(8)
            .background(FD.surface.opacity(0.9), in: Capsule()).padding(12).allowsHitTesting(false)
            .task(id: scene) {
                guard scene == .active else { return }
                while !Task.isCancelled {
                    sample = PerformanceSample.current()
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                }
            }
    }
}
