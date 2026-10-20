import AppKit
import XCTest
@testable import FalconDeckMac

final class SettingsTests: XCTestCase {
    @MainActor func testLocalPreferencesPersistWithoutDaemonOrCredentials() throws {
        let suite = "falcondeck.settings.test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativePreferences(defaults: defaults)
        preferences.theme = "light"
        preferences.chatFont = "serif"
        preferences.fontScale = 1.15
        preferences.setBindings(["Mod+Alt+N"], for: "newThread")
        let restored = NativePreferences(defaults: defaults)
        XCTAssertEqual(restored.theme, "light")
        XCTAssertEqual(restored.chatFont, "serif")
        XCTAssertEqual(restored.fontScale, 1.15)
        XCTAssertEqual(restored.bindings(for: "newThread"), ["Mod+Alt+N"])
        XCTAssertEqual(restored.exportSettings()["apiKey"], .null)
    }

    @MainActor func testImportWhitelistsAndNormalizesClientPreferences() throws {
        let suite = "falcondeck.settings.test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativePreferences(defaults: defaults)
        preferences.importSettings(.object([
            "theme": .string("invalid"), "fontScale": .number(999), "soundEnabled": .bool(true),
            "openRouterKey": .string("do-not-import"),
            "shortcuts": .object(["newThread": .array([.string("A"), .string("Mod+Q"), .string("Mod+Alt+N")]), "unknown": .array([.string("Mod+L")])])
        ]))
        XCTAssertEqual(preferences.theme, "system")
        XCTAssertEqual(preferences.fontScale, 1.6)
        XCTAssertTrue(preferences.soundEnabled)
        XCTAssertEqual(preferences.bindings(for: "newThread"), ["Mod+Alt+N"])
        XCTAssertEqual(preferences.exportSettings()["openRouterKey"], .null)
        XCTAssertEqual(preferences.exportSettings()["shortcuts"]["unknown"], .null)
    }

    @MainActor func testShortcutConflictsRespectContextsAndResetDefaults() throws {
        let suite = "falcondeck.settings.test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativePreferences(defaults: defaults)
        XCTAssertEqual(preferences.conflict(for: "Mod+N", command: "openProject")?.id, "newThread")
        XCTAssertEqual(preferences.conflict(for: "Mod+Shift+]", command: "nextThread")?.id, "terminalNextTab")
        preferences.setBindings([], for: "newThread")
        XCTAssertTrue(preferences.bindings(for: "newThread").isEmpty)
        XCTAssertTrue(preferences.hasCustomBindings(for: "newThread"))
        preferences.resetBindings(for: "newThread")
        XCTAssertEqual(preferences.bindings(for: "newThread"), ["Mod+N", "Mod+Shift+O"])
        XCTAssertFalse(preferences.hasCustomBindings(for: "newThread"))
    }

    func testBackupExportCreatesAndReplacesPrivateFiles() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("backup.json")
        try NativeArchiveFile.write(Data("first".utf8), to: url)
        XCTAssertEqual(try Data(contentsOf: url), Data("first".utf8))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        try NativeArchiveFile.write(Data("second".utf8), to: url)
        XCTAssertEqual(try Data(contentsOf: url), Data("second".utf8))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["backup.json"])
    }

    func testSSHSettingsLeaveConfigPortsToSSH() throws {
        XCTAssertNil(try NativeSSHSettings.port(mode: "ssh", text: "2222"))
        XCTAssertNil(try NativeSSHSettings.port(mode: "manual", text: ""))
        XCTAssertEqual(try NativeSSHSettings.port(mode: "manual", text: " 2222 "), 2222)
        XCTAssertThrowsError(try NativeSSHSettings.port(mode: "manual", text: "0"))
        XCTAssertThrowsError(try NativeSSHSettings.port(mode: "manual", text: "invalid"))
        XCTAssertEqual(NativeSSHSettings.fields(target: "prod", port: nil)["port"], nil)
        XCTAssertEqual(NativeSSHSettings.fields(target: "user@example.com", port: 2222)["port"], .number(2222))
    }

    @MainActor func testPortableArchiveShortcutsMatchNativeKeyEvents() throws {
        let suite = "falcondeck.settings.test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativePreferences(defaults: defaults)
        let archive: JSON = .object(["shortcuts": .object(["bindings": .object([
            "nextThread": .array([.string("Ctrl+Down")]),
            "increaseTextSize": .array([.string("Mod+Shift+Plus")])
        ])])])
        preferences.importSettings(NativeArchivePreferences.nativeSettings(archive))
        XCTAssertEqual(preferences.bindings(for: "nextThread"), ["Ctrl+ArrowDown"])
        XCTAssertEqual(preferences.bindings(for: "increaseTextSize"), ["Mod+Shift+="])
        let exported = NativeArchivePreferences.clientBackup(preferences.exportSettings())
        XCTAssertEqual(exported["shortcuts"]["bindings"]["nextThread"], .array([.string("Ctrl+Down")]))
        XCTAssertEqual(exported["shortcuts"]["bindings"]["increaseTextSize"], .array([.string("Mod+Shift+Plus")]))
        XCTAssertEqual(exported["ui_preferences"]["native"]["shortcuts"]["nextThread"], .array([.string("Ctrl+ArrowDown")]))
    }

    @MainActor func testTauriArchiveMigrationPreservesBundledSoundChoices() {
        for sound in ["Chime", "Drop"] {
            let archive: JSON = .object(["sounds": .object(["enabled": .bool(true), "soundId": .string(sound.lowercased())])])
            XCTAssertEqual(NativeArchivePreferences.nativeSettings(archive)["soundName"], .string(sound))
        }
    }

    @MainActor func testTauriArchiveMigrationPreservesDeviceChoices() {
        let archive: JSON = .object([
            "appearance": .object(["theme": .string("dark"), "chatScale": .number(1.1)]),
            "sounds": .object(["enabled": .bool(true), "soundId": .string("glass")]),
            "shortcuts": .object(["bindings": .object(["newThread": .array([.string("Mod+Alt+N")])]), "followUpBehavior": .string("steer")])
        ])
        let native = NativeArchivePreferences.nativeSettings(archive)
        XCTAssertEqual(native["theme"], .string("dark"))
        XCTAssertEqual(native["chatScale"], .number(1.1))
        XCTAssertEqual(native["soundName"], .string("Glass"))
        XCTAssertEqual(native["followUpBehavior"], .string("steer"))
        XCTAssertEqual(native["shortcuts"]["newThread"], .array([.string("Mod+Alt+N")]))
    }
}
