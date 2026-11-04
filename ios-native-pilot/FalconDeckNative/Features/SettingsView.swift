import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        List {
            Section {
                NavigationLink(value: DetailDestination.connections) { Label("Connections", systemImage: "laptopcomputer.and.iphone") }
                NavigationLink(value: DetailDestination.extensions) { Label("Extensions", systemImage: "puzzlepiece.extension") }
                NavigationLink(value: DetailDestination.automations) { Label("Automations", systemImage: "calendar.badge.clock") }
            }.listRowBackground(FD.surface)
            Section("Preferences") {
                NavigationLink(value: DetailDestination.appearance) { Label("Appearance", systemImage: "paintpalette") }
                NavigationLink(value: DetailDestination.conversation) { Label("Conversation", systemImage: "text.bubble") }
                NavigationLink(value: DetailDestination.notifications) { Label("Notifications", systemImage: "bell") }
                NavigationLink(value: DetailDestination.speech) { Label("Speech", systemImage: "mic") }
            }.listRowBackground(FD.surface)
            Section {
                NavigationLink(value: DetailDestination.developer) { Label("Developer", systemImage: "gauge.with.dots.needle.33percent") }
                NavigationLink(value: DetailDestination.about) { Label("About FalconDeck", systemImage: "info.circle") }
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
                Picker("Text size", selection: $appearance.textScale) { Text("Small").tag(0.87); Text("Default").tag(1.0); Text("Large").tag(1.13); Text("Larger").tag(1.28) }
            } footer: { Text("Stored on this device. System follows the device's appearance and text size.") }
            .listRowBackground(FD.surface)
            Section("Light theme") {
                PaletteGrid(palettes: NativeAppearance.palettes.filter { !$0.dark }, selection: $appearance.lightID)
            }.listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            Section("Dark theme") {
                PaletteGrid(palettes: NativeAppearance.palettes.filter(\.dark), selection: $appearance.darkID)
            }.listRowBackground(Color.clear).listRowInsets(EdgeInsets())
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Appearance")
    }
}

/// Each swatch draws its own palette with fixed colours, so a theme can be
/// judged before it is chosen.
private struct PaletteGrid: View {
    let palettes: [NativePalette]
    @Binding var selection: String
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 10)], spacing: 10) {
            ForEach(palettes) { palette in
                let selected = palette.id == selection
                Button { selection = palette.id } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        VStack(alignment: .leading, spacing: 5) {
                            Capsule().fill(swatch(palette, "fg", "primary")).frame(width: 46, height: 5)
                            Capsule().fill(swatch(palette, "fg", "muted")).frame(width: 64, height: 5)
                            HStack(spacing: 4) {
                                RoundedRectangle(cornerRadius: 4).fill(swatch(palette, "surface", "2")).frame(height: 14)
                                Circle().fill(swatch(palette, "accent")).frame(width: 14, height: 14)
                            }
                        }
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(swatch(palette, "surface", "0"), in: .rect(cornerRadius: 10, style: .continuous))
                        .overlay { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(swatch(palette, "border")) }
                        HStack(spacing: 4) {
                            Text(palette.label).font(.caption.weight(selected ? .semibold : .regular)).foregroundStyle(FD.foreground).lineLimit(1)
                            Spacer(minLength: 0)
                            if selected { Image(systemName: "checkmark.circle.fill").font(.caption).foregroundStyle(FD.accent) }
                        }
                    }
                    .padding(6)
                    .background(selected ? FD.accent.opacity(0.1) : Color.clear, in: .rect(cornerRadius: 14, style: .continuous))
                    .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(selected ? FD.accent : Color.clear, lineWidth: 1.5) }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(palette.label).accessibilityAddTraits(selected ? .isSelected : [])
                .sensoryFeedback(.selection, trigger: selected) { _, now in now }
            }
        }.padding(.vertical, 4)
    }
    private func swatch(_ palette: NativePalette, _ group: String, _ key: String = "default") -> Color {
        Color(NativeAppearance.uiColor(palette.value(group, key) ?? "#888888"))
    }
}

struct ConnectionSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var session: SavedSession?
    @State private var confirmForget = false
    var body: some View {
        Form {
            Section("Active connection") {
                LabeledContent("Status", value: model.status)
                if !model.demo { LabeledContent("Encryption", value: model.connected ? "End-to-end encrypted" : "Not established") }
                if let session {
                    LabeledContent("Relay") { Text(session.relay.absoluteString).font(.footnote).textSelection(.enabled) }
                    LabeledContent("Session") { Text(session.sessionID).font(.footnote.monospaced()).textSelection(.enabled) }
                    LabeledContent("Device") { Text(session.deviceID).font(.footnote.monospaced()).textSelection(.enabled) }
                }
                Button("Reconnect") { Task { await model.reconnect() } }.disabled(model.busy || !model.hasSession)
            }.listRowBackground(FD.surface)
            Section {
                Button("Pair a computer") { model.showConnection = true }
                NavigationLink("Connection log", value: DetailDestination.connectionLog)
                if model.hasSession {
                    Button("Forget this connection", role: .destructive) { confirmForget = true }.disabled(model.busy)
                }
            } footer: { Text("Messages are encrypted between this device and your computer.") }.listRowBackground(FD.surface)
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Connections")
            .task { session = model.demo ? nil : try? model.sessionLoader() }
            .confirmationDialog("Forget this computer?", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("Forget connection", role: .destructive) { Task { await model.forget() } }
            } message: { Text("You’ll need a new pairing link to connect again.") }
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

// The detail stack owns one explicit path so selecting a sidebar destination
// clears nested pages without replacing the navigation controller itself.
enum DetailDestination: Hashable {
    case connections, extensions, automations, appearance, conversation, notifications, speech, developer, about, connectionLog
    case extensionPanel(extensionID: String, contribution: JSON)
    case notificationDetail(NotificationDetailTarget)
    case review(String)

    @MainActor @ViewBuilder var view: some View {
        switch self {
        case .connections: ConnectionSettingsView()
        case .extensions: ExtensionPanelsView()
        case .automations: AutomationsView()
        case .appearance: AppearanceSettingsView()
        case .conversation: ConversationSettingsView()
        case .notifications: NotificationSettingsView()
        case .speech: SpeechSettingsView()
        case .developer: DeveloperSettingsView()
        case .about: AboutView()
        case .connectionLog: ConnectionLogView()
        case .notificationDetail(let target): NotificationDetailView(target: target)
        case .review(let id): ReviewDetailView(reviewID: id)
        case .extensionPanel(let extensionID, let contribution): ExtensionPanelView(extensionID: extensionID, contribution: contribution)
        }
    }
}
