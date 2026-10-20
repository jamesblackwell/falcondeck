import XCTest
import SwiftUI
@testable import FalconDeckMac

@MainActor final class NativeCommandDispatcherTests: XCTestCase {
    func testFocusShortcutWorksInTextWhileShiftTypingStaysWithEditorAndTerminal() throws {
        let suite = "NativeCommandDispatcherTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativePreferences(defaults: defaults)
        for context in ["global", "composer", "terminal"] {
            XCTAssertEqual(NativeCommandDispatcher.command(for: "Shift+Escape", context: context,
                isTextInput: true, preferences: preferences)?.id, "focusComposer")
            XCTAssertNil(NativeCommandDispatcher.command(for: "Shift+/", context: context,
                isTextInput: true, preferences: preferences))
        }
        XCTAssertEqual(NativeCommandDispatcher.command(for: "Shift+/", context: "global",
            isTextInput: false, preferences: preferences)?.id, "openKeyboardShortcuts")
    }

    func testCustomBindingsAndFocusedContextTakePriority() throws {
        let suite = "NativeCommandDispatcherTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativePreferences(defaults: defaults)
        preferences.setBindings(["Mod+T"], for: "toggleSidebar")
        XCTAssertEqual(NativeCommandDispatcher.command(for: "Mod+T", context: "terminal",
            isTextInput: true, preferences: preferences)?.id, "terminalNewTab")
        XCTAssertEqual(NativeCommandDispatcher.command(for: "Mod+T", context: "composer",
            isTextInput: true, preferences: preferences)?.id, "toggleSidebar")
        preferences.setBindings(["Mod+Enter"], for: "sendMessage")
        preferences.setBindings([], for: "invertFollowUp")
        XCTAssertNil(NativeCommandDispatcher.command(for: "Enter", context: "composer",
            isTextInput: true, preferences: preferences))
        XCTAssertEqual(NativeCommandDispatcher.command(for: "Mod+Enter", context: "composer",
            isTextInput: true, preferences: preferences)?.id, "sendMessage")
        XCTAssertNil(NativeCommandDispatcher.command(for: "Mod+Enter", context: "global",
            isTextInput: true, preferences: preferences))
    }

    func testNativeMenuEquivalentsFollowCustomizedAndRemovedBindings() throws {
        let suite = "NativeCommandDispatcherTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativePreferences(defaults: defaults)
        let standard = try XCTUnwrap(NativeCommandDispatcher.menuShortcut(for: "newThread", preferences: preferences))
        XCTAssertEqual(standard.key, KeyEquivalent("n"))
        XCTAssertEqual(standard.modifiers, .command)
        preferences.setBindings(["Ctrl+Alt+ArrowUp"], for: "newThread")
        let custom = try XCTUnwrap(NativeCommandDispatcher.menuShortcut(for: "newThread", preferences: preferences))
        XCTAssertEqual(custom.key, .upArrow)
        XCTAssertEqual(custom.modifiers, [.control, .option])
        preferences.setBindings(["Shift+B"], for: "newThread")
        XCTAssertNil(NativeCommandDispatcher.menuShortcut(for: "newThread", preferences: preferences))
        preferences.setBindings([], for: "newThread")
        XCTAssertNil(NativeCommandDispatcher.menuShortcut(for: "newThread", preferences: preferences))
    }
}
