import AppKit
import SwiftUI

struct NativeShortcutDefinition: Identifiable {
    let id: String
    let label: String
    let category: String
    let context: String
    let defaults: [String]
    static let all: [NativeShortcutDefinition] = [
        .init(id: "commandPalette", label: "Command menu", category: "App", context: "global", defaults: ["Mod+K", "Mod+Shift+P"]),
        .init(id: "openSettings", label: "Settings", category: "App", context: "global", defaults: ["Mod+,"]),
        .init(id: "openActivity", label: "Activity", category: "App", context: "global", defaults: ["Mod+U"]),
        .init(id: "openUsage", label: "Usage", category: "App", context: "global", defaults: ["Mod+Shift+U"]),
        .init(id: "openKeyboardShortcuts", label: "Keyboard shortcuts", category: "App", context: "global", defaults: ["Shift+/", "Mod+Shift+/"]),
        .init(id: "openProject", label: "Open project", category: "App", context: "global", defaults: ["Mod+O"]),
        .init(id: "newChat", label: "New chat", category: "Conversation", context: "global", defaults: ["Mod+Shift+N"]),
        .init(id: "newThread", label: "New project chat", category: "Conversation", context: "global", defaults: ["Mod+N", "Mod+Shift+O"]),
        .init(id: "searchThreads", label: "Search chats", category: "Conversation", context: "global", defaults: ["Mod+G"]),
        .init(id: "findInThread", label: "Find in chat", category: "Conversation", context: "global", defaults: ["Mod+F"]),
        .init(id: "navigateBack", label: "Navigate back", category: "Navigation", context: "global", defaults: ["Mod+["]),
        .init(id: "navigateForward", label: "Navigate forward", category: "Navigation", context: "global", defaults: ["Mod+]"]),
        .init(id: "previousThread", label: "Previous chat", category: "Navigation", context: "global", defaults: ["Mod+Shift+["]),
        .init(id: "nextThread", label: "Next chat", category: "Navigation", context: "global", defaults: ["Mod+Shift+]"]),
        .init(id: "toggleSidebar", label: "Toggle sidebar", category: "View", context: "global", defaults: ["Mod+B"]),
        .init(id: "toggleChanges", label: "Toggle changes panel", category: "View", context: "global", defaults: ["Mod+Alt+B"]),
        .init(id: "toggleTerminal", label: "Toggle terminal", category: "Terminal", context: "global", defaults: ["Mod+J"]),
        .init(id: "newTerminal", label: "New terminal", category: "Terminal", context: "global", defaults: ["Ctrl+Shift+`"]),
        .init(id: "terminalNewTab", label: "New terminal tab", category: "Terminal", context: "terminal", defaults: ["Mod+T"]),
        .init(id: "terminalCloseTab", label: "Close terminal tab", category: "Terminal", context: "terminal", defaults: ["Mod+W"]),
        .init(id: "terminalNextTab", label: "Next terminal tab", category: "Terminal", context: "terminal", defaults: ["Mod+Shift+]", "Ctrl+Tab"]),
        .init(id: "terminalPreviousTab", label: "Previous terminal tab", category: "Terminal", context: "terminal", defaults: ["Mod+Shift+[", "Ctrl+Shift+Tab"]),
        .init(id: "increaseTextSize", label: "Increase text size", category: "View", context: "global", defaults: ["Mod+=", "Mod+Shift+="]),
        .init(id: "decreaseTextSize", label: "Decrease text size", category: "View", context: "global", defaults: ["Mod+-"]),
        .init(id: "resetTextSize", label: "Reset text size", category: "View", context: "global", defaults: ["Mod+0"]),
        .init(id: "focusComposer", label: "Focus prompt", category: "Composer", context: "global", defaults: ["Shift+Escape"]),
        .init(id: "openProjectMenu", label: "Choose project", category: "Composer", context: "global", defaults: ["Ctrl+Shift+L"]),
        .init(id: "openHarnessMenu", label: "Choose agent", category: "Composer", context: "global", defaults: ["Ctrl+Shift+A"]),
        .init(id: "openPermissionMenu", label: "Choose permission mode", category: "Composer", context: "global", defaults: ["Ctrl+Shift+P"]),
        .init(id: "openSandboxMenu", label: "Choose sandbox mode", category: "Composer", context: "global", defaults: ["Ctrl+Shift+S"]),
        .init(id: "openModelMenu", label: "Choose model", category: "Composer", context: "global", defaults: ["Ctrl+Shift+M"]),
        .init(id: "stopTurn", label: "Stop response", category: "Conversation", context: "global", defaults: ["Mod+."]),
        .init(id: "sendMessage", label: "Send message", category: "Composer", context: "composer", defaults: ["Enter"]),
        .init(id: "invertFollowUp", label: "Invert Queue / Steer", category: "Composer", context: "composer", defaults: ["Mod+Enter"]),
        .init(id: "insertNewline", label: "Insert newline", category: "Composer", context: "composer", defaults: ["Shift+Enter"])
    ]

    static func validation(_ binding: String, context: String) -> String? {
        let tokens = binding.split(separator: "+").map(String.init)
        guard let key = tokens.last, !key.isEmpty, binding.count < 80 else { return "Choose a key combination." }
        guard tokens.dropLast().allSatisfy({ ["Mod", "Ctrl", "Alt", "Shift"].contains($0) }) else { return "Use Command, Control, Option or Shift with a key." }
        if ["Mod", "Ctrl", "Alt", "Shift"].contains(key) { return "Add a key to the modifier." }
        if context == "global", tokens.count == 1 { return "Global commands require a modifier key." }
        if binding == "Mod+Q" { return "Command-Q is reserved for quitting FalconDeck." }
        return nil
    }

    static func binding(from event: NSEvent) -> String? {
        let keys: [UInt16: String] = [0:"A", 1:"S", 2:"D", 3:"F", 4:"H", 5:"G", 6:"Z", 7:"X", 8:"C", 9:"V", 11:"B", 12:"Q", 13:"W", 14:"E", 15:"R", 16:"Y", 17:"T", 18:"1", 19:"2", 20:"3", 21:"4", 22:"6", 23:"5", 24:"=", 25:"9", 26:"7", 27:"-", 28:"8", 29:"0", 30:"]", 31:"O", 32:"U", 33:"[", 34:"I", 35:"P", 37:"L", 38:"J", 39:"'", 40:"K", 41:";", 42:"\\", 43:",", 44:"/", 45:"N", 46:"M", 47:".", 36:"Enter", 76:"Enter", 48:"Tab", 49:"Space", 50:"`", 51:"Backspace", 53:"Escape", 117:"Delete", 123:"ArrowLeft", 124:"ArrowRight", 125:"ArrowDown", 126:"ArrowUp", 115:"Home", 119:"End", 116:"PageUp", 121:"PageDown", 122:"F1", 120:"F2", 99:"F3", 118:"F4", 96:"F5", 97:"F6", 98:"F7", 100:"F8", 101:"F9", 109:"F10", 103:"F11", 111:"F12"]
        guard let key = keys[event.keyCode] ?? event.charactersIgnoringModifiers?.uppercased(), !key.isEmpty else { return nil }
        let flags = event.modifierFlags
        var tokens: [String] = []
        if flags.contains(.command) { tokens.append("Mod") }
        if flags.contains(.control) { tokens.append("Ctrl") }
        if flags.contains(.option) { tokens.append("Alt") }
        if flags.contains(.shift) { tokens.append("Shift") }
        tokens.append(key)
        return tokens.joined(separator: "+")
    }

    static func display(_ binding: String) -> String {
        binding.replacingOccurrences(of: "Mod+", with: "⌘").replacingOccurrences(of: "Ctrl+", with: "⌃").replacingOccurrences(of: "Alt+", with: "⌥").replacingOccurrences(of: "Shift+", with: "⇧").replacingOccurrences(of: "Enter", with: "↩").replacingOccurrences(of: "Escape", with: "⎋").replacingOccurrences(of: "Backspace", with: "⌫").replacingOccurrences(of: "Tab", with: "⇥")
    }
}

/// An actual first-responder recorder; it never installs a global key tap.
private struct NativeShortcutCapture: NSViewRepresentable {
    let onKey: (String) -> Void
    let onCancel: () -> Void
    func makeNSView(context: Context) -> CaptureView {
        let view = CaptureView()
        view.onKey = onKey; view.onCancel = onCancel
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return view
    }
    func updateNSView(_ nsView: CaptureView, context: Context) { nsView.onKey = onKey; nsView.onCancel = onCancel }
    final class CaptureView: NSView {
        var onKey: ((String) -> Void)?
        var onCancel: (() -> Void)?
        override var acceptsFirstResponder: Bool { true }
        override func keyDown(with event: NSEvent) {
            if event.keyCode == 53 && event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty { onCancel?(); return }
            if let binding = NativeShortcutDefinition.binding(from: event) { onKey?(binding) }
        }
        override func performKeyEquivalent(with event: NSEvent) -> Bool { keyDown(with: event); return true }
    }
}

struct NativeKeyboardSettingsView: View {
    @Bindable var preferences = NativePreferences.shared
    @State private var query = ""
    @State private var keyQuery: String?
    @State private var findByKeys = false
    @State private var recording: String?
    @State private var preview: String?
    private var visible: [NativeShortcutDefinition] {
        NativeShortcutDefinition.all.filter {
            if let keyQuery { return preferences.bindings(for: $0.id).contains(keyQuery) }
            return query.isEmpty || ($0.label + " " + $0.category).localizedCaseInsensitiveContains(query)
        }
    }
    var body: some View {
        Form {
            Section {
                HStack {
                    TextField("Search commands", text: $query).onChange(of: query) { _, value in if !value.isEmpty { keyQuery = nil } }
                    Button(keyQuery.map(NativeShortcutDefinition.display) ?? "Find by keys") { findByKeys = true }
                    if keyQuery != nil { Button("Clear") { keyQuery = nil } }
                    Button("Reset all") { preferences.resetBindings() }
                }
                if findByKeys {
                    Text("Press a shortcut to find its command. Escape cancels.").foregroundStyle(.secondary)
                        .background(NativeShortcutCapture(onKey: { keyQuery = $0; query = ""; findByKeys = false }, onCancel: { findByKeys = false }).frame(width: 1, height: 1))
                }
            } header: { Text("Customize every command") } footer: { Text("Changes apply on this Mac. Terminal and composer bindings take priority while those controls are focused.") }
            ForEach(["App", "Navigation", "View", "Terminal", "Conversation", "Composer"], id: \.self) { category in
                let rows = visible.filter { $0.category == category }
                if !rows.isEmpty {
                    Section(category) {
                        ForEach(rows) { definition in shortcutRow(definition) }
                    }
                }
            }
            if visible.isEmpty { ContentUnavailableView.search(text: query) }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder private func shortcutRow(_ definition: NativeShortcutDefinition) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading) {
                    Text(definition.label)
                    if preferences.hasCustomBindings(for: definition.id) { Text("Customized").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary) }
                }
                Spacer()
                if preferences.bindings(for: definition.id).isEmpty { Text("Unassigned").foregroundStyle(.secondary) }
                ForEach(preferences.bindings(for: definition.id), id: \.self) { binding in
                    HStack(spacing: 4) {
                        Text(NativeShortcutDefinition.display(binding)).monospaced()
                        Button { preferences.setBindings(preferences.bindings(for: definition.id).filter { $0 != binding }, for: definition.id) } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(.secondary).help("Remove \(binding)")
                    }.padding(5).background(.quaternary, in: RoundedRectangle(cornerRadius: 5))
                }
                Button { recording = definition.id; preview = nil } label: { Image(systemName: "plus") }.help("Add shortcut")
                if preferences.hasCustomBindings(for: definition.id) {
                    Button { preferences.resetBindings(for: definition.id) } label: { Image(systemName: "arrow.counterclockwise") }.help("Reset command")
                }
            }
            if recording == definition.id {
                let validation = preview.flatMap { NativeShortcutDefinition.validation($0, context: definition.context) }
                let conflict = preview.flatMap { preferences.conflict(for: $0, command: definition.id) }
                HStack {
                    Text(preview.map(NativeShortcutDefinition.display) ?? "Press the shortcut you want…").monospaced().frame(maxWidth: .infinity, alignment: .leading)
                    Button("Save") {
                        if let preview { preferences.setBindings(preferences.bindings(for: definition.id) + [preview], for: definition.id) }
                        recording = nil
                    }.disabled(preview == nil || validation != nil || conflict != nil)
                    Button("Cancel") { recording = nil }
                }
                .padding(10).background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                .background(NativeShortcutCapture(onKey: { preview = $0 }, onCancel: { recording = nil }).frame(width: 1, height: 1))
                if let validation { Text(validation).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.red) }
                else if let conflict { Text("Already used by \(conflict.label).").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.red) }
            }
        }
    }
}
