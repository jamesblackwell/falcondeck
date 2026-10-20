import AppKit
import Foundation

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
        let responder = NSApp.keyWindow?.firstResponder
        let name = responder.map { String(reflecting: type(of: $0)) } ?? ""
        if name.contains("CaptureView") || name.contains("ShortcutRecorder") { return event }
        if let text = responder as? NSTextView, text.hasMarkedText() { return event }
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
        let contexts = terminal ? ["terminal", "global"] : composer ? ["composer", "global"] : ["global"]
        for context in contexts {
            if context == "global", responder is NSTextView,
               event.modifierFlags.intersection([.command, .control, .option]).isEmpty { continue }
            guard let command = NativeShortcutDefinition.all.first(where: {
                $0.context == context && NativePreferences.shared.bindings(for: $0.id).contains(binding)
            }) else { continue }
            if event.isARepeat, ["sendMessage", "invertFollowUp"].contains(command.id) { return nil }
            if command.id == "insertNewline", let editor = responder as? ComposerNativeTextView {
                editor.insertNewline(nil); return nil
            }
            execute(command.id, store: store, context: terminal ? "terminal" : composer ? "composer" : "global")
            return nil
        }
        return event
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
        case "resetTextSize": NativePreferences.shared.fontScale = 1
        case "stopTurn": Task { await store.interrupt() }
        case "findInThread" where store.selectedSection == "settings":
            NotificationCenter.default.post(name: .init("falcondeck.native.focusSettingsSearch"), object: nil)
        default: break
        }
        NotificationCenter.default.post(name: .init("native.command"), object: command, userInfo: ["context": context])
    }
}
