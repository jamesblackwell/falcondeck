import SwiftUI

struct ConversationSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var pending = false
    @State private var error: String?
    private var preferences: JSON { model.preferences["conversation"] }
    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.orange) }
            Section("Tool activity") {
                Picker("Details", selection: choice("tool_details_mode", fallback: "collapsed")) {
                    Text("Hidden").tag("collapsed"); Text("Auto").tag("auto"); Text("Compact").tag("compact"); Text("Expanded").tag("expanded"); Text("Hide read-only details").tag("hide_read_only_details")
                }
                Toggle("Group repeated lookups", isOn: flag("group_read_only_tools"))
            }.listRowBackground(FD.surface)
            Section("Thinking") {
                Picker("Display", selection: choice("thinking_display", fallback: "auto")) {
                    Text("Auto").tag("auto"); Text("Preview").tag("preview"); Text("Always expanded").tag("always_expanded"); Text("Always collapsed").tag("always_collapsed")
                }
            }.listRowBackground(FD.surface)
            Section {
                Toggle("Collapse long messages", isOn: flag("collapse_long_user_messages"))
                Toggle("Auto-open errors", isOn: flag("errors", nested: "auto_expand"))
                Toggle("Auto-open failed tests", isOn: flag("failed_tests", nested: "auto_expand"))
            } header: { Text("Transcript behavior") } footer: { Text("Stored on your computer and applied across your paired devices.") }.listRowBackground(FD.surface)
        }.disabled(pending || (!model.demo && !model.connected))
            .scrollContentBackground(.hidden).background(FD.background).navigationTitle("Conversation")
    }
    private func choice(_ key: String, fallback: String) -> Binding<String> {
        Binding(get: { preferences[key].string.nonempty ?? fallback }, set: { update(.object([key: .string($0)])) })
    }
    private func flag(_ key: String, nested: String? = nil) -> Binding<Bool> {
        Binding(get: { let value = nested.map { preferences[$0][key] } ?? preferences[key]; return value == .null ? true : value.bool }, set: { value in
            update(nested.map { .object([$0: .object([key: .bool(value)])]) } ?? .object([key: .bool(value)]))
        })
    }
    private func update(_ value: JSON) {
        guard !pending else { return }; pending = true; error = nil
        Task {
            defer { pending = false }
            do { try await model.updatePreferences(.object(["conversation": value])) } catch { self.error = error.localizedDescription }
        }
    }
}

struct NotificationSettingsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("native.notifications.connected") private var connectedAlerts = false
    @State private var pending = false
    @State private var error: String?
    var body: some View {
        Form {
            Section {
                Toggle("Alerts while connected", isOn: Binding(get: { connectedAlerts }, set: { enabled in
                    if !enabled { connectedAlerts = false; return }
                    Task {
                        do { connectedAlerts = try await model.notifications.authorize(); if !connectedAlerts { error = "Allow notifications in this device's Settings." } }
                        catch { self.error = error.localizedDescription }
                    }
                }))
            } footer: { Text("Background remote notifications require a native relay push update and are unavailable in this development build.") }.listRowBackground(FD.surface)
            Section {
                Toggle("Completed turns", isOn: preference("notify_on_turn_complete"))
                Toggle("Approvals and questions", isOn: preference("notify_on_input_required"))
                Toggle("Failed turns", isOn: preference("notify_on_error"))
            } header: { Text("Notify me about") } footer: { Text("These event preferences are stored on your computer and apply to all paired clients. Connected native alerts cannot detect desktop activity.") }.listRowBackground(FD.surface)
                .disabled(pending || (!model.demo && !model.connected))
            if let error { Text(error).foregroundStyle(.orange) }
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Notifications")
    }
    private func preference(_ key: String) -> Binding<Bool> {
        Binding(get: { model.preferences["notifications"][key] == .null ? true : model.preferences["notifications"][key].bool }, set: { value in
            guard !pending else { return }; pending = true
            Task {
                defer { pending = false }
                do { try await model.updatePreferences(.object(["notifications": .object([key: .bool(value)])])) } catch { self.error = error.localizedDescription }
            }
        })
    }
}
