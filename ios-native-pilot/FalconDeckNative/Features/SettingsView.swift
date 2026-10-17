import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        List {
            Section {
                NavigationLink { ConnectionSettingsView() } label: { Label("Connections", systemImage: "laptopcomputer.and.iphone") }
                NavigationLink { AutomationsView() } label: { Label("Automations", systemImage: "calendar.badge.clock") }
            }.listRowBackground(FD.surface)
            Section("Preferences") {
                NavigationLink { AppearanceSettingsView() } label: { Label("Appearance", systemImage: "paintpalette") }
                NavigationLink { ConversationSettingsView() } label: { Label("Conversation", systemImage: "text.bubble") }
                NavigationLink { NotificationSettingsView() } label: { Label("Notifications", systemImage: "bell") }
                NavigationLink { SpeechSettingsView() } label: { Label("Speech", systemImage: "mic") }
            }.listRowBackground(FD.surface)
            Section {
                NavigationLink { DeveloperSettingsView() } label: { Label("Developer", systemImage: "gauge.with.dots.needle.33percent") }
                NavigationLink { AboutView() } label: { Label("About FalconDeck", systemImage: "info.circle") }
            }.listRowBackground(FD.surface)
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Settings")
    }
}

struct AppearanceSettingsView: View {
    var body: some View {
        @Bindable var appearance = NativeAppearance.shared
        Form {
            Section {
                Picker("Appearance", selection: $appearance.mode) { Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") }.pickerStyle(.segmented)
                Picker("Light theme", selection: $appearance.lightID) { ForEach(NativeAppearance.palettes.filter { !$0.dark }) { Text($0.label).tag($0.id) } }
                Picker("Dark theme", selection: $appearance.darkID) { ForEach(NativeAppearance.palettes.filter(\.dark)) { Text($0.label).tag($0.id) } }
                Picker("Text size", selection: $appearance.textScale) { Text("Small").tag(0.87); Text("Default").tag(1.0); Text("Large").tag(1.13); Text("Larger").tag(1.28) }
            } footer: { Text("Stored on this device. System follows the device's appearance and text size.") }
            .listRowBackground(FD.surface)
            Section("Preview") {
                Text("Your agents, in focus.").font(.headline)
                Text("A native place for your conversations.").foregroundStyle(FD.secondary)
                HStack { ForEach(0..<6) { index in Circle().fill(NativeAppearance.shared.color("cat", String(index + 1))).frame(width: 24, height: 24) } }
            }.listRowBackground(FD.surface)
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Appearance")
    }
}

struct ConnectionSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var session: SavedSession?
    var body: some View {
        Form {
            Section("Active connection") {
                LabeledContent("Status", value: model.status)
                LabeledContent("Encryption", value: model.connected ? "End-to-end encrypted" : "Not established")
                if let session {
                    LabeledContent("Relay") { Text(session.relay.absoluteString).font(.footnote).textSelection(.enabled) }
                    LabeledContent("Session") { Text(session.sessionID).font(.footnote.monospaced()).textSelection(.enabled) }
                    LabeledContent("Device") { Text(session.deviceID).font(.footnote.monospaced()).textSelection(.enabled) }
                }
                Button("Reconnect") { Task { await model.reconnect() } }.disabled(model.busy || !model.hasSession)
            }.listRowBackground(FD.surface)
            Section {
                Button("Pair a computer") { model.showConnection = true }
                NavigationLink("Connection log") { ConnectionLogView() }
            } footer: { Text("Messages are encrypted between this device and your computer.") }.listRowBackground(FD.surface)
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Connections")
            .task { session = try? SessionVault.load() }
    }
}

struct AboutView: View {
    var body: some View {
        Form {
            Section {
                HStack(spacing: 16) { Image("FalconMark").resizable().scaledToFit().frame(width: 48, height: 48); VStack(alignment: .leading) { Text("FalconDeck").font(.title2.weight(.semibold)); Text("Native development build").font(.footnote).foregroundStyle(FD.secondary) } }.padding(.vertical, 12)
                LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0")
                LabeledContent("Build", value: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")
                Link("FalconDeck", destination: URL(string: "https://falcondeck.com")!)
                Link("Source code", destination: URL(string: "https://github.com/jamesblackwell/falcondeck")!)
            }.listRowBackground(FD.surface)
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("About")
    }
}
