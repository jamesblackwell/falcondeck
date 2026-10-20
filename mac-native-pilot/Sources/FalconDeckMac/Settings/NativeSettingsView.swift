import SwiftUI

enum NativeSettingsSection: String, CaseIterable, Identifiable {
    case general, appearance, notifications, conversations, keyboard, extensions, agents, harnesses, connectors
    case agentControl = "agent-control"
    case computerUse = "computer-use"
    case speech, models, remote, servers, backup
    var id: String { rawValue }
    var title: String {
        switch self {
        case .general: "General"
        case .appearance: "Appearance"
        case .notifications: "Notifications"
        case .conversations: "Conversations"
        case .keyboard: "Keyboard shortcuts"
        case .extensions: "Extensions"
        case .agents: "Agents"
        case .harnesses: "Harnesses"
        case .connectors: "Connectors"
        case .agentControl: "Agent control"
        case .computerUse: "Computer use"
        case .speech: "Voice"
        case .models: "Models & keys"
        case .remote: "Remote access"
        case .servers: "Servers"
        case .backup: "Backup & data"
        }
    }
    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .appearance: "paintpalette"
        case .notifications: "bell"
        case .conversations: "bubble.left.and.bubble.right"
        case .keyboard: "keyboard"
        case .extensions: "puzzlepiece.extension"
        case .agents: "person.crop.rectangle.stack"
        case .harnesses: "terminal"
        case .connectors: "powerplug"
        case .agentControl: "checkmark.shield"
        case .computerUse: "desktopcomputer"
        case .speech: "mic"
        case .models: "key"
        case .remote: "wifi"
        case .servers: "server.rack"
        case .backup: "archivebox"
        }
    }
    var group: String {
        switch self {
        case .general, .appearance, .notifications, .conversations, .keyboard, .extensions: "App"
        case .agents, .harnesses, .connectors, .agentControl, .computerUse, .speech, .models: "Agents"
        case .remote, .servers, .backup: "Connection & data"
        }
    }
    var detail: String {
        switch self {
        case .general: "Startup, updates and first-run setup"
        case .appearance: "Theme, fonts and text size on this Mac"
        case .notifications: "Agent alerts, desktop presence and sounds"
        case .conversations: "Follow-ups, tool detail and thinking"
        case .keyboard: "Customize every command"
        case .extensions: "Additional capabilities and permissions"
        case .agents: "Built-in and custom ACP agents"
        case .harnesses: "Coding CLI installations, versions and upgrades"
        case .connectors: "MCP servers and agent tools"
        case .agentControl: "Agent permissions and scheduling defaults"
        case .computerUse: "Desktop control, browser access and diagnostics"
        case .speech: "Dictation, transcription and selected-text rewrite"
        case .models: "OpenRouter, task titles and utility models"
        case .remote: "Pair devices and manage trusted connections"
        case .servers: "SSH servers and remote projects"
        case .backup: "Export, inspect, restore and reset"
        }
    }
    private var keywords: String {
        switch self {
        case .general: "resume stopped sessions restart release onboarding welcome"
        case .appearance: "dark light system font palette color colour scale size weight typography"
        case .notifications: "push phone complete errors question away sound chime alert approval"
        case .conversations: "queue steer density reasoning transcript expand collapse group tools"
        case .keyboard: "keybinding shortcut hotkey command keys reset"
        case .extensions: "plugins notes tags kanban enabled grants"
        case .agents: "acp claude codex opencode grok cursor provider auth"
        case .harnesses: "cli upgrade install repair version sign in job logs"
        case .connectors: "mcp tools command url scope inherited global project import"
        case .agentControl: "context injection permission provider override confirmation automation audit history scheduling elevated"
        case .computerUse: "accessibility screen recording consent browser signed in cursor telemetry diagnostic recovery"
        case .speech: "stt tts speech microphone parakeet apple openrouter rewrite dictionary recording retention hotkey"
        case .models: "openrouter key credentials title prompt background utility model"
        case .remote: "relay device pairing trusted revoke code qr mobile"
        case .servers: "ssh provision host port credentials daemon restart remote project"
        case .backup: "data archive export import restore migration path mapping reset"
        }
    }
    func matches(_ query: String) -> Bool {
        query.isEmpty || (title + " " + detail + " " + keywords).localizedCaseInsensitiveContains(query)
    }
}

struct NativeSettingsView: View {
    let store: AppStore
    @AppStorage("falcondeck.native.settings.section") private var savedSection = "general"
    @State private var selected: NativeSettingsSection
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    init(store: AppStore, initialSection: String? = nil) {
        self.store = store
        let section = initialSection ?? UserDefaults.standard.string(forKey: "falcondeck.native.settings.section") ?? "general"
        _selected = State(initialValue: NativeSettingsSection(rawValue: section) ?? .general)
    }

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                TextField("Search settings", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .focused($searchFocused)
                    .padding(12)
                    .onChange(of: query) { _, new in
                        if !selected.matches(new), let first = NativeSettingsSection.allCases.first(where: { $0.matches(new) }) { selected = first }
                    }
                List(selection: Binding<NativeSettingsSection?>(get: { selected }, set: { if let next = $0 { selected = next } })) {
                    ForEach(["App", "Agents", "Connection & data"], id: \.self) { group in
                        let sections = NativeSettingsSection.allCases.filter { $0.group == group && $0.matches(query) }
                        if !sections.isEmpty {
                            Section(group) {
                                ForEach(sections) { section in
                                    Label(section.title, systemImage: section.symbol).tag(section).padding(.vertical, 3)
                                }
                            }
                        }
                    }
                }.listStyle(.sidebar)
                if !query.isEmpty && !NativeSettingsSection.allCases.contains(where: { $0.matches(query) }) {
                    Text("No matching settings").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary).padding()
                }
            }
            .frame(minWidth: 205, idealWidth: 228, maxWidth: 300)

            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(selected.title).font(NativePreferences.shared.font(size: 22, weight: .semibold))
                        Text(selected.detail).font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Label(store.isConnected ? "Connected" : "Offline", systemImage: store.isConnected ? "circle.fill" : "circle")
                        .font(NativePreferences.shared.font(size: 11)).foregroundStyle(store.isConnected ? Color.green : Color.secondary)
                }.padding(.horizontal, 24).padding(.vertical, 20)
                Divider()
                detail.id(selected)
            }.frame(minWidth: 475, maxWidth: .infinity, maxHeight: .infinity)
        }
        .onChange(of: selected) { _, next in savedSection = next.rawValue }
        .onReceive(NotificationCenter.default.publisher(for: .init("falcondeck.native.openSettingsSection"))) { notification in
            if let section = notification.object as? String, let next = NativeSettingsSection(rawValue: section) { selected = next; query = "" }
        }
        .onReceive(NotificationCenter.default.publisher(for: .init("falcondeck.native.focusSettingsSearch"))) { _ in searchFocused = true }
    }

    @ViewBuilder private var detail: some View {
        switch selected {
        case .general: scrolling { NativeGeneralSettingsView(store: store) }
        case .appearance: NativeAppearanceSettingsView()
        case .notifications: NativeNotificationsSettingsView(store: store)
        case .conversations: NativeConversationSettingsView(store: store)
        case .keyboard: NativeKeyboardSettingsView()
        case .extensions: scrolling { NativeExtensionsSettingsView(store: store) }
        case .agents: NativeAgentsSettingsView(store: store)
        case .harnesses: NativeHarnessesSettingsView(store: store)
        case .connectors: NativeConnectorsSettingsView(store: store)
        case .agentControl: scrolling { NativeAgentControlSettingsView(store: store) }
        case .computerUse: scrolling { NativeComputerUseSettingsView(store: store) }
        case .speech: NativeVoiceSettingsView(store: store)
        case .models: NativeModelsSettingsView(store: store)
        case .remote: NativeRemoteSettingsView(store: store)
        case .servers: NativeServersSettingsView(store: store)
        case .backup: NativeBackupSettingsView(store: store)
        }
    }
    private func scrolling<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        ScrollView { content().padding(24).frame(maxWidth: 900, alignment: .leading).frame(maxWidth: .infinity) }
    }
}
