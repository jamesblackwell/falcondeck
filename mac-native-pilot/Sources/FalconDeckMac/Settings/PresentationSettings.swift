import AppKit
import SwiftUI
import UserNotifications

struct NativeAppearanceSettingsView: View {
    @Bindable var preferences = NativePreferences.shared
    var body: some View {
        Form {
            Section {
                Picker("Appearance", selection: $preferences.theme) {
                    Label("System", systemImage: "desktopcomputer").tag("system")
                    Label("Light", systemImage: "sun.max").tag("light")
                    Label("Dark", systemImage: "moon").tag("dark")
                }.pickerStyle(.segmented)
                palettePicker("Light theme", selection: $preferences.lightColorTheme, palettes: NativePalette.light)
                palettePicker("Dark theme", selection: $preferences.darkColorTheme, palettes: NativePalette.dark)
            } header: { Text("Theme") } footer: { Text("Appearance is stored on this Mac. System follows the display’s light or dark appearance.") }
            Section("Typography") {
                fontPicker("Interface font", selection: $preferences.sansFont, custom: $preferences.sansFontCustom, choices: NativeFontChoice.sans)
                fontPicker("Chat font", selection: $preferences.chatFont, custom: $preferences.chatFontCustom, choices: [NativeFontChoice(id: "match", name: "Match interface")] + NativeFontChoice.sans)
                fontPicker("Code font", selection: $preferences.monoFont, custom: $preferences.monoFontCustom, choices: NativeFontChoice.mono)
                Picker("Text size", selection: $preferences.fontScale) {
                    Text("Small").tag(0.95); Text("Default").tag(1.05); Text("Large").tag(1.15); Text("Extra large").tag(1.25)
                }
            }
            Section("Fine tune") {
                weightPicker("Interface weight", selection: $preferences.uiWeight)
                scalePicker("Sidebar size", selection: $preferences.sidebarScale)
                weightPicker("Sidebar weight", selection: $preferences.sidebarWeight)
                scalePicker("Chat size", selection: $preferences.chatScale)
                weightPicker("Chat weight", selection: $preferences.chatWeight)
                scalePicker("Code size", selection: $preferences.codeScale)
                weightPicker("Code weight", selection: $preferences.codeWeight)
            }
            Section("Preview") {
                Text("The quick brown fox jumps over the lazy dog.").font(preferences.font(size: 13))
                Text("Conversations should be comfortable to read, at any display size.").font(preferences.font(size: 14, surface: "chat"))
                Text("fn main() { println!(\"hello\"); }").font(preferences.font(size: 13, surface: "code"))
                Button("Reset appearance") { preferences.resetAppearance() }
            }
        }.formStyle(.grouped)
    }
    private func palettePicker(_ title: String, selection: Binding<String>, palettes: [NativePalette]) -> some View {
        Picker(title, selection: selection) {
            ForEach(palettes) { palette in
                HStack(spacing: 7) {
                    HStack(spacing: 0) {
                        Rectangle().fill(FDTheme.color(palette.canvas))
                        Rectangle().fill(FDTheme.color(palette.surface))
                        Rectangle().fill(FDTheme.color(palette.foreground))
                        Rectangle().fill(FDTheme.color(palette.accent))
                    }.frame(width: 36, height: 12).clipShape(Capsule())
                    Text(palette.name)
                }.tag(palette.id)
            }
        }
    }
    @ViewBuilder private func fontPicker(_ title: String, selection: Binding<String>, custom: Binding<String>, choices: [NativeFontChoice]) -> some View {
        Picker(title, selection: selection) { ForEach(choices) { Text($0.name).tag($0.id) } }
        if selection.wrappedValue == "custom" {
            TextField("Font family name", text: custom).textFieldStyle(.roundedBorder)
            if !custom.wrappedValue.isEmpty, NSFont(name: custom.wrappedValue, size: 13) == nil {
                Text("Font not found. Use its PostScript name from Font Book; the system font is used until it is available.").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.orange)
            }
        }
    }
    private func scalePicker(_ title: String, selection: Binding<Double>) -> some View {
        Picker(title, selection: selection) {
            ForEach([0.9, 0.95, 1, 1.05, 1.1, 1.15], id: \.self) { Text("\(Int(($0 * 100).rounded()))%").tag($0) }
        }
    }
    private func weightPicker(_ title: String, selection: Binding<Double>) -> some View {
        Picker(title, selection: selection) {
            Text("Default").tag(0.0); Text("Light").tag(300.0); Text("Book").tag(350.0)
            Text("Regular").tag(400.0); Text("Text").tag(450.0); Text("Medium").tag(500.0)
        }
    }
}

struct NativeConversationSettingsView: View {
    let store: AppStore
    @Bindable var preferences = NativePreferences.shared
    @State private var error: String?
    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.red) }
            Section {
                Picker("While the agent is working", selection: $preferences.followUpBehavior) {
                    Text("Queue").tag("queue"); Text("Steer").tag("steer")
                }.pickerStyle(.segmented)
            } header: { Text("Running follow-ups") } footer: { Text("Queue sends after the current turn. Steer delivers the follow-up to the running agent. The invert shortcut uses the other behavior once. Stored on this Mac.") }
            Section {
                Picker("Tool detail", selection: sharedString("tool_details_mode", fallback: "collapsed")) {
                    Text("Hidden").tag("collapsed"); Text("Auto").tag("auto"); Text("Expanded").tag("expanded")
                    Text("Compact").tag("compact"); Text("Hide read-only details").tag("hide_read_only_details")
                }
            } header: { Text("Tool activity") } footer: { Text("Hidden folds tool bursts behind a summary. Auto keeps failures, approvals and diffs visible. Shared with your paired devices.") }
            Section {
                Picker("Thinking", selection: $preferences.thinkingDisplay) {
                    Text("Auto").tag("auto"); Text("Preview").tag("preview")
                    Text("Always expanded").tag("always_expanded"); Text("Always collapsed").tag("always_collapsed")
                }
            } header: { Text("Reasoning") } footer: { Text("Auto expands thinking during streaming and collapses it afterwards. This display preference is stored on this Mac.") }
            Section("Auto-expand rules") {
                Toggle("Group read-only tool bursts", isOn: sharedBool(["group_read_only_tools"]))
                Toggle("Collapse long messages you send", isOn: sharedBool(["collapse_long_user_messages"]))
                Toggle("Show expand/collapse all controls", isOn: sharedBool(["show_expand_all_controls"]))
                Toggle("Auto-open approvals", isOn: sharedBool(["auto_expand", "approvals"]))
                Toggle("Auto-open errors", isOn: sharedBool(["auto_expand", "errors"]))
                Toggle("Auto-open failed tests", isOn: sharedBool(["auto_expand", "failed_tests"]))
                Toggle("Auto-open the first diff", isOn: sharedBool(["auto_expand", "first_diff"]))
            }
        }.formStyle(.grouped)
    }
    private func sharedString(_ key: String, fallback: String) -> Binding<String> {
        Binding(get: {
            let value = store.preferences["conversation"][key].string
            return value.isEmpty ? fallback : value
        }, set: { value in save(.object(["conversation": .object([key: .string(value)])])) })
    }
    private func sharedBool(_ path: [String]) -> Binding<Bool> {
        Binding(get: {
            let value = path.reduce(store.preferences["conversation"]) { $0[$1] }
            if case .bool(let bool) = value { return bool }
            return true
        }, set: { value in
            let nested = path.reversed().reduce(JSON.bool(value)) { .object([$1: $0]) }
            save(.object(["conversation": nested]))
        })
    }
    private func save(_ patch: JSON) {
        Task {
            do { try await store.updatePreferences(patch); error = nil }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct NativeNotificationsSettingsView: View {
    let store: AppStore
    @Bindable var preferences = NativePreferences.shared
    @State private var error: String?
    @State private var authorization = "Checking…"
    private var sounds: [String] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: "/System/Library/Sounds"), includingPropertiesForKeys: nil)) ?? []
        let names = urls.filter { ["aiff", "wav", "caf"].contains($0.pathExtension.lowercased()) }.map { $0.deletingPathExtension().lastPathComponent }
        return (names.isEmpty ? ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"] : names.sorted()) + ["Chime", "Drop"]
    }
    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.red) }
            Section {
                Toggle("Agent attention notifications", isOn: sharedBool("enabled"))
                Group {
                    Toggle("Completed turns", isOn: sharedBool("notify_on_turn_complete"))
                    Toggle("Approvals and questions", isOn: sharedBool("notify_on_input_required"))
                    Toggle("Failed turns", isOn: sharedBool("notify_on_error"))
                    Toggle("Only push when away from desktop", isOn: sharedBool("suppress_when_desktop_active"))
                }.disabled(!sharedBool("enabled").wrappedValue)
            } header: { Text("Alerts") } footer: { Text("These choices are shared with paired devices. Phone alerts can wait until two minutes without keyboard or mouse activity on this Mac.") }
            Section("macOS notification permission") {
                LabeledContent("Status", value: authorization)
                HStack {
                    Button("Allow notifications") {
                        Task {
                            do {
                                _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
                                await refreshAuthorization()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    Button("Open Notification Settings") {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
                    }
                }
            }
            Section {
                Toggle("Play a sound when a turn finishes", isOn: $preferences.soundEnabled)
                    .onChange(of: preferences.soundEnabled) { _, enabled in if enabled { playSound() } }
                HStack {
                    Picker("Sound", selection: $preferences.soundName) { ForEach(sounds, id: \.self) { Text($0).tag($0) } }
                        .onChange(of: preferences.soundName) { _, _ in playSound() }
                    Button { playSound() } label: { Image(systemName: "play.fill") }.help("Preview sound")
                }
            } header: { Text("Sounds") } footer: { Text("Sounds are played on this Mac only, even when FalconDeck is already in front.") }
        }.formStyle(.grouped).task { await refreshAuthorization() }
    }
    private func sharedBool(_ key: String) -> Binding<Bool> {
        Binding(get: {
            if case .bool(let bool) = store.preferences["notifications"][key] { return bool }
            return true
        }, set: { value in
            Task {
                do { try await store.updatePreferences(.object(["notifications": .object([key: .bool(value)])])); error = nil }
                catch { self.error = error.localizedDescription }
            }
        })
    }
    private func playSound() { NativeCompletionSound.play(named: preferences.soundName) }
    private func refreshAuthorization() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized: authorization = "Allowed"
        case .denied: authorization = "Disabled in System Settings"
        case .notDetermined: authorization = "Not requested"
        case .provisional: authorization = "Deliver quietly"
        default: authorization = "Unavailable"
        }
    }
}

@MainActor enum NativeCompletionSound {
    private static var playing: NSSound?
    static func play(named requestedName: String? = nil) {
        let name = requestedName ?? NativePreferences.shared.soundName
        if ["Chime", "Drop"].contains(name) {
            let url = Bundle.module.url(forResource: name.lowercased(), withExtension: "wav", subdirectory: "Sounds")
                ?? Bundle.main.url(forResource: name.lowercased(), withExtension: "wav", subdirectory: "Sounds")
            if let url { playing = NSSound(contentsOf: url, byReference: true) }
        } else { playing = NSSound(named: NSSound.Name(name)) }
        playing?.play()
    }
}
