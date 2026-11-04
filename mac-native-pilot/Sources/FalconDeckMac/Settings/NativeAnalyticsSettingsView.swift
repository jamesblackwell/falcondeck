import SwiftUI

struct NativeAnalyticsSettingsView: View {
    let store: AppStore
    @State private var report: JSON = .null
    @State private var days = 30
    @State private var error: String?
    @State private var descending = true

    private func tokens(_ row: JSON) -> Int {
        ["input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens"].reduce(0) { $0 + row["usage"][$1].int }
    }

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Picker("Period", selection: $days) {
                        Text("7 days").tag(7)
                        Text("30 days").tag(30)
                        Text("90 days").tag(90)
                    }.frame(width: 240)
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                }
                Text("Scheduled tasks").font(.headline)
                Text("Private analytics on this Mac.").foregroundStyle(FDTheme.muted)
                if let error { Text(error).foregroundStyle(.red) }
                Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 12) {
                    GridRow {
                        Text("Task"); Text("Models")
                        Button(descending ? "Tokens ↓" : "Tokens ↑") { descending.toggle() }
                        Text("Runs"); Text("Failed")
                    }.font(.headline)
                    ForEach(report["automations"].array.sorted { descending ? tokens($0) > tokens($1) : tokens($0) < tokens($1) }, id: \.self) { row in
                        GridRow {
                            Text(row["name"].string)
                            VStack(alignment: .leading) {
                                if row["models"].array.isEmpty {
                                    Text(row["configured_model"].string.isEmpty ? row["fallback_model"].string : row["configured_model"].string).foregroundStyle(FDTheme.muted)
                                } else {
                                    Text(row["models"].array.map(\.string).joined(separator: " · "))
                                    if !row["configured_model"].string.isEmpty && !row["models"].array.map(\.string).contains(row["configured_model"].string) {
                                        Text("Pin: \(row["configured_model"].string)").foregroundStyle(FDTheme.muted)
                                    }
                                }
                            }
                            Text(tokens(row).formatted()).monospacedDigit()
                                .help("Input: \(row["usage"]["input_tokens"].int), cache read: \(row["usage"]["cache_read_tokens"].int), cache write: \(row["usage"]["cache_write_tokens"].int), output: \(row["usage"]["output_tokens"].int)")
                            Text(row["runs"].int.formatted()).monospacedDigit()
                            Text(row["failed"].int.formatted()).monospacedDigit()
                        }
                    }
                }
            }.padding(24)
        }.task(id: days) { await load() }
    }

    @MainActor private func load() async {
        do {
            report = try await store.request("/api/analytics/summary?days=\(days)")
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}
