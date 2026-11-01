import SwiftUI

struct DeveloperSettingsView: View {
    @AppStorage("native.debug.overlay") private var overlay = false
    @Environment(AppModel.self) private var model
    @State private var sample = PerformanceSample.current()
    @State private var meter: SyncMeter.Report?
    var body: some View {
        Form {
            if let meter {
                Section("Sync since connecting") {
                    LabeledContent("Received", value: ByteCountFormatter.string(fromByteCount: Int64(meter.totalBytes), countStyle: .file))
                    LabeledContent("Live events", value: String(meter.entries.filter { $0.key.hasPrefix("event.") }.values.reduce(0) { $0 + $1.count }))
                    LabeledContent("Requests", value: String(meter.entries.filter { $0.key.hasPrefix("rpc.") && $0.key != "rpc.out" }.values.reduce(0) { $0 + $1.count }))
                    LabeledContent("Index refreshes", value: String(meter.entries["rpc.sync.index"]?.count ?? 0))
                    LabeledContent("Connected for", value: Duration.seconds(meter.seconds).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow)))
                }.listRowBackground(FD.surface)
            }
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
                    meter = await model.relay.syncMeter()
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
