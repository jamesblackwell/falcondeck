import AppKit
import Foundation
import SwiftUI

/// Uses the same command IDs and persisted bindings as the settings editor.
/// Cocoa retains ordinary text/IME and terminal input unless a command matches.
@MainActor final class NativeCommandDispatcher {
    static let shared = NativeCommandDispatcher()
    private weak var store: AppStore?
    private var monitor: Any?

    func attach(store: AppStore) {
        self.store = store
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let consumed = MainActor.assumeIsolated { self?.handle(event) == nil }
            return consumed ? nil : event
        }
    }

    private func handle(_ event: NSEvent) -> NSEvent? {
        guard let store, let binding = NativeShortcutDefinition.binding(from: event) else { return event }
        let responder = (event.window ?? NSApp.keyWindow)?.firstResponder
        let name = responder.map { String(reflecting: type(of: $0)) } ?? ""
        if name.contains("CaptureView") || name.contains("ShortcutRecorder") { return event }
        if let text = responder as? NSTextInputClient, text.hasMarkedText() { return event }
        if binding == "Mod+Shift+V", NativeSpeechController.shared.config.repasteShortcutEnabled {
            NativeSpeechController.shared.repaste(); return nil
        }
        let composer = responder is ComposerNativeTextView
        var terminal = name.localizedCaseInsensitiveContains("terminal")
        var parent = (responder as? NSView)?.superview
        while let view = parent, !terminal {
            terminal = String(reflecting: type(of: view)).localizedCaseInsensitiveContains("terminal")
            parent = view.superview
        }
        let context = terminal ? "terminal" : composer ? "composer" : "global"
        if let command = Self.command(for: binding, context: context,
                                      isTextInput: responder is NSTextInputClient, preferences: .shared) {
            if event.isARepeat, ["sendMessage", "invertFollowUp"].contains(command.id) { return nil }
            if command.id == "insertNewline", let editor = responder as? ComposerNativeTextView {
                editor.insertNewline(nil); return nil
            }
            execute(command.id, store: store, context: context)
            return nil
        }
        return event
    }

    static func command(for binding: String, context: String, isTextInput: Bool,
                        preferences: NativePreferences) -> NativeShortcutDefinition? {
        let contexts = context == "global" ? ["global"] : [context, "global"]
        for candidate in contexts {
            // Shift alone still produces text and selection commands. Preserve
            // those in editors and terminals, while allowing Shift-Escape to
            // reach the configured Focus prompt action.
            if candidate == "global", isTextInput || context == "terminal" {
                let tokens = binding.components(separatedBy: "+")
                let modifiers = tokens.dropLast()
                let key = tokens.last ?? ""
                let functionKey = key.hasPrefix("F") && (1...24).contains(Int(key.dropFirst()) ?? 0)
                if !modifiers.contains(where: { ["Mod", "Ctrl", "Alt"].contains($0) }),
                   key != "Escape", !functionKey { continue }
            }
            if let command = NativeShortcutDefinition.all.first(where: {
                $0.context == candidate && preferences.bindings(for: $0.id).contains(binding)
            }) { return command }
        }
        return nil
    }

    static func menuShortcut(for command: String, preferences: NativePreferences) -> KeyboardShortcut? {
        for binding in preferences.bindings(for: command) {
            let tokens = binding.components(separatedBy: "+")
            guard let key = tokens.last else { continue }
            let named: [String: KeyEquivalent] = ["Enter": .return, "Escape": .escape, "Tab": .tab,
                "Space": .space, "Backspace": .delete, "Delete": .deleteForward,
                "ArrowUp": .upArrow, "ArrowDown": .downArrow, "ArrowLeft": .leftArrow, "ArrowRight": .rightArrow,
                "Home": .home, "End": .end, "PageUp": .pageUp, "PageDown": .pageDown]
            let functionNumber = key.hasPrefix("F") ? Int(key.dropFirst()) : nil
            let functionKey = functionNumber.flatMap { number -> KeyEquivalent? in
                guard (1...24).contains(number), let scalar = UnicodeScalar(Int(NSF1FunctionKey) + number - 1) else { return nil }
                return KeyEquivalent(Character(scalar))
            }
            guard let equivalent = named[key] ?? functionKey ?? (key.count == 1 ? KeyEquivalent(Character(key.lowercased())) : nil) else { continue }
            var modifiers: EventModifiers = []
            for token in tokens.dropLast() {
                switch token {
                case "Mod": modifiers.insert(.command)
                case "Ctrl": modifiers.insert(.control)
                case "Alt": modifiers.insert(.option)
                case "Shift": modifiers.insert(.shift)
                default: break
                }
            }
            // Cocoa tries menu equivalents after the event monitor. Do not
            // install a Shift-only typing binding that bypasses its text guard.
            if modifiers.intersection([.command, .control, .option]).isEmpty,
               key != "Escape", functionKey == nil { continue }
            return KeyboardShortcut(equivalent, modifiers: modifiers)
        }
        return nil
    }

    func execute(_ command: String, store: AppStore? = nil, context: String = "global") {
        guard let store = store ?? self.store else { return }
        switch command {
        case "openSettings": store.selectSection("settings")
        case "openActivity": store.selectSection("activity")
        case "openUsage": store.selectSection("usage")
        case "openKeyboardShortcuts":
            store.selectSection("settings")
            NotificationCenter.default.post(name: .init("falcondeck.native.openSettingsSection"), object: "keyboard")
        case "newChat": Task { await store.newChat() }
        case "newThread": store.newTask()
        case "navigateBack": Task { await store.navigateHistory(-1) }
        case "navigateForward": Task { await store.navigateHistory(1) }
        case "previousThread": Task { await store.navigateTask(-1) }
        case "nextThread": Task { await store.navigateTask(1) }
        case "toggleChanges": store.showInspector.toggle()
        case "toggleTerminal": store.showTerminal.toggle()
        case "newTerminal": store.showTerminal = true; store.terminalCreationRequest = UUID()
        case "increaseTextSize": NativePreferences.shared.fontScale += 0.05
        case "decreaseTextSize": NativePreferences.shared.fontScale -= 0.05
        case "resetTextSize": NativePreferences.shared.fontScale = 1.05
        case "stopTurn": Task { await store.interrupt() }
        case "findInThread" where store.selectedSection == "settings":
            NotificationCenter.default.post(name: .init("falcondeck.native.focusSettingsSearch"), object: nil)
        default: break
        }
        NotificationCenter.default.post(name: .init("native.command"), object: command, userInfo: ["context": context])
    }
}
