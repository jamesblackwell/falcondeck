import AppKit
import Foundation
import Observation
import SwiftUI

/// Display, sound and keyboard choices are intentionally local to this Mac.
/// Agent policy and notification delivery remain owned by the daemon.
@MainActor @Observable final class NativePreferences {
    static let shared = NativePreferences()
    static let storageKey = "falcondeck.native.preferences.v1"
    @ObservationIgnored private let defaults: UserDefaults
    private var values: [String: JSON]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.storageKey),
           let json = try? JSON.decode(data), case .object(let fields) = json {
            values = Self.validated(fields)
        } else { values = [:] }
    }

    private func read(_ key: String, fallback: String) -> String { values[key]?.string ?? fallback }
    private func read(_ key: String, fallback: Double) -> Double {
        if case .number(let value) = values[key] { return value }
        return fallback
    }
    private func set(_ key: String, _ value: JSON) {
        values[key] = value
        persist()
    }
    private func persist() {
        if let data = try? JSON.object(values).data() { defaults.set(data, forKey: Self.storageKey) }
    }

    var theme: String { get { read("theme", fallback: "system") } set { set("theme", .string(newValue)) } }
    var lightColorTheme: String { get { read("lightColorTheme", fallback: "falcon-light") } set { set("lightColorTheme", .string(newValue)) } }
    var darkColorTheme: String { get { read("darkColorTheme", fallback: "falcon-dark") } set { set("darkColorTheme", .string(newValue)) } }
    var sansFont: String { get { read("sansFont", fallback: "system") } set { set("sansFont", .string(newValue)) } }
    var sansFontCustom: String { get { read("sansFontCustom", fallback: "") } set { set("sansFontCustom", .string(newValue)) } }
    var chatFont: String { get { read("chatFont", fallback: "match") } set { set("chatFont", .string(newValue)) } }
    var chatFontCustom: String { get { read("chatFontCustom", fallback: "") } set { set("chatFontCustom", .string(newValue)) } }
    var monoFont: String { get { read("monoFont", fallback: "system-mono") } set { set("monoFont", .string(newValue)) } }
    var monoFontCustom: String { get { read("monoFontCustom", fallback: "") } set { set("monoFontCustom", .string(newValue)) } }
    var fontScale: Double { get { read("fontScale", fallback: 1.05) } set { set("fontScale", .number(min(1.6, max(0.8, newValue)))) } }
    var sidebarScale: Double { get { read("sidebarScale", fallback: 1) } set { set("sidebarScale", .number(newValue)) } }
    var chatScale: Double { get { read("chatScale", fallback: 1) } set { set("chatScale", .number(newValue)) } }
    var codeScale: Double { get { read("codeScale", fallback: 1) } set { set("codeScale", .number(newValue)) } }
    var uiWeight: Double { get { read("uiWeight", fallback: 0) } set { set("uiWeight", .number(newValue)) } }
    var sidebarWeight: Double { get { read("sidebarWeight", fallback: 0) } set { set("sidebarWeight", .number(newValue)) } }
    var chatWeight: Double { get { read("chatWeight", fallback: 0) } set { set("chatWeight", .number(newValue)) } }
    var codeWeight: Double { get { read("codeWeight", fallback: 0) } set { set("codeWeight", .number(newValue)) } }
    var followUpBehavior: String { get { read("followUpBehavior", fallback: "queue") } set { set("followUpBehavior", .string(newValue)) } }
    var thinkingDisplay: String { get { read("thinkingDisplay", fallback: "auto") } set { set("thinkingDisplay", .string(newValue)) } }
    var soundEnabled: Bool { get { values["soundEnabled"]?.bool ?? false } set { set("soundEnabled", .bool(newValue)) } }
    var soundName: String { get { read("soundName", fallback: "Glass") } set { set("soundName", .string(newValue)) } }
    var preferredColorScheme: ColorScheme? { theme == "system" ? nil : theme == "light" ? .light : .dark }

    func exportSettings() -> JSON { .object(values) }
    func importSettings(_ json: JSON) {
        guard case .object(let fields) = json else { return }
        values = Self.validated(fields)
        persist()
    }
    func resetAppearance() {
        for key in Self.appearanceKeys { values.removeValue(forKey: key) }
        persist()
    }
    func reset() { values = [:]; persist() }
    func bindings(for command: String) -> [String] {
        if case .array(let bindings) = values["shortcuts"]?[command] { return bindings.map(\.string) }
        return NativeShortcutDefinition.all.first { $0.id == command }?.defaults ?? []
    }
    func setBindings(_ bindings: [String], for command: String) {
        var entries: [String: JSON] = [:]
        if case .object(let stored) = values["shortcuts"] { entries = stored }
        entries[command] = .array(Array(Set(bindings)).sorted().map(JSON.string))
        set("shortcuts", .object(entries))
    }
    func resetBindings(for command: String? = nil) {
        if let command, case .object(var entries) = values["shortcuts"] {
            entries.removeValue(forKey: command)
            set("shortcuts", .object(entries))
        } else { values.removeValue(forKey: "shortcuts"); persist() }
    }
    func hasCustomBindings(for command: String) -> Bool {
        guard case .object(let entries) = values["shortcuts"] else { return false }
        return entries[command] != nil
    }
    func conflict(for binding: String, command: String) -> NativeShortcutDefinition? {
        guard let target = NativeShortcutDefinition.all.first(where: { $0.id == command }) else { return nil }
        return NativeShortcutDefinition.all.first {
            $0.id != command && ($0.context == target.context || $0.context == "global" || target.context == "global")
            && bindings(for: $0.id).contains(binding)
        }
    }
    func font(size: CGFloat, surface: String = "ui", weight: Font.Weight? = nil) -> Font {
        let isCode = surface == "code"
        let scale = surface == "chat" ? chatScale : surface == "sidebar" ? sidebarScale : isCode ? codeScale : 1
        let value = surface == "chat" && chatFont != "match" ? chatFont : isCode ? monoFont : sansFont
        let custom = surface == "chat" && chatFont != "match" ? chatFontCustom : isCode ? monoFontCustom : sansFontCustom
        let baseWeight = surface == "chat" ? chatWeight : surface == "sidebar" ? sidebarWeight : isCode ? codeWeight : uiWeight
        let resolvedWeight = weight ?? Self.weight(baseWeight)
        let resolvedSize = size * fontScale * scale
        if value == "system" || value == "system-mono" || value == "rounded" || value == "new-york" {
            return .system(size: resolvedSize, weight: resolvedWeight, design: isCode ? .monospaced : value == "rounded" ? .rounded : value == "new-york" ? .serif : .default)
        }
        let name = value == "custom" ? custom : Self.fontNames[value] ?? ""
        guard !name.isEmpty, NSFont(name: name, size: resolvedSize) != nil else {
            return .system(size: resolvedSize, weight: resolvedWeight, design: isCode ? .monospaced : .default)
        }
        return .custom(name, size: resolvedSize).weight(resolvedWeight)
    }
    func nativeFont(size: CGFloat, surface: String = "ui", weight: NSFont.Weight? = nil) -> NSFont {
        let isCode = surface == "code"
        let scale = surface == "chat" ? chatScale : surface == "sidebar" ? sidebarScale : isCode ? codeScale : 1
        let value = surface == "chat" && chatFont != "match" ? chatFont : isCode ? monoFont : sansFont
        let custom = surface == "chat" && chatFont != "match" ? chatFontCustom : isCode ? monoFontCustom : sansFontCustom
        let baseWeight = surface == "chat" ? chatWeight : surface == "sidebar" ? sidebarWeight : isCode ? codeWeight : uiWeight
        let resolvedWeight = weight ?? Self.nativeWeight(baseWeight)
        let resolvedSize = size * fontScale * scale
        let system = isCode ? NSFont.monospacedSystemFont(ofSize: resolvedSize, weight: resolvedWeight) : NSFont.systemFont(ofSize: resolvedSize, weight: resolvedWeight)
        if value == "system" || value == "system-mono" { return system }
        if value == "rounded" || value == "new-york" {
            let design: NSFontDescriptor.SystemDesign = value == "rounded" ? .rounded : .serif
            if let descriptor = system.fontDescriptor.withDesign(design), let font = NSFont(descriptor: descriptor, size: resolvedSize) { return font }
            return system
        }
        let name = value == "custom" ? custom : Self.fontNames[value] ?? ""
        guard !name.isEmpty, let customFont = NSFont(name: name, size: resolvedSize) else { return system }
        let weighted = customFont.fontDescriptor.addingAttributes([.traits: [NSFontDescriptor.TraitKey.weight: resolvedWeight.rawValue]])
        return NSFont(descriptor: weighted, size: resolvedSize) ?? customFont
    }
    private static let fontNames = ["geist": "Geist", "lexend": "Lexend", "inter": "Inter", "avenir": "Avenir Next", "helvetica": "Helvetica Neue", "serif": "Iowan Old Style", "geist-mono": "Geist Mono", "jetbrains-mono": "JetBrains Mono", "fira-code": "Fira Code", "cascadia": "Cascadia Code", "menlo": "Menlo"]
    private static func nativeWeight(_ value: Double) -> NSFont.Weight {
        switch value { case 1...325: .light; case 326...425: .regular; case 426...: .medium; default: .regular }
    }
    private static func weight(_ value: Double) -> Font.Weight {
        switch value { case 1...325: .light; case 326...375: .regular; case 376...425: .regular; case 426...475: .medium; case 476...: .medium; default: .regular }
    }
    static let appearanceKeys = ["theme", "lightColorTheme", "darkColorTheme", "sansFont", "sansFontCustom", "chatFont", "chatFontCustom", "monoFont", "monoFontCustom", "fontScale", "sidebarScale", "chatScale", "codeScale", "uiWeight", "sidebarWeight", "chatWeight", "codeWeight"]
    private static func validated(_ input: [String: JSON]) -> [String: JSON] {
        var result: [String: JSON] = [:]
        let choices: [String: [String]] = [
            "theme": ["system", "light", "dark"],
            "lightColorTheme": NativePalette.light.map(\.id), "darkColorTheme": NativePalette.dark.map(\.id),
            "sansFont": NativeFontChoice.sans.map(\.id), "chatFont": ["match"] + NativeFontChoice.sans.map(\.id), "monoFont": NativeFontChoice.mono.map(\.id),
            "followUpBehavior": ["queue", "steer"], "thinkingDisplay": ["auto", "preview", "always_expanded", "always_collapsed"]
        ]
        for (key, valid) in choices { if let value = input[key], valid.contains(value.string) { result[key] = value } }
        for key in ["sansFontCustom", "chatFontCustom", "monoFontCustom", "soundName"] {
            if case .string(let value) = input[key] { result[key] = .string(String(value.prefix(200))) }
        }
        for key in ["fontScale", "sidebarScale", "chatScale", "codeScale"] {
            if case .number(let value) = input[key], value.isFinite { result[key] = .number(min(1.6, max(0.8, value))) }
        }
        for key in ["uiWeight", "sidebarWeight", "chatWeight", "codeWeight"] {
            if case .number(let value) = input[key], [0, 300, 350, 400, 450, 500].contains(value) { result[key] = .number(value) }
        }
        if case .bool(let value) = input["soundEnabled"] { result["soundEnabled"] = .bool(value) }
        if case .object(let bindings) = input["shortcuts"] {
            var valid: [String: JSON] = [:]
            for definition in NativeShortcutDefinition.all {
                if case .array(let list) = bindings[definition.id] {
                    valid[definition.id] = .array(list.compactMap { entry in
                        guard case .string(let binding) = entry, NativeShortcutDefinition.validation(binding, context: definition.context) == nil else { return nil }
                        return .string(binding)
                    })
                }
            }
            result["shortcuts"] = .object(valid)
        }
        return result
    }
}

struct NativeFontChoice: Identifiable {
    let id: String
    let name: String
    static let sans = [("system", "System"), ("geist", "Geist"), ("lexend", "Lexend"), ("inter", "Inter"), ("rounded", "SF Rounded"), ("avenir", "Avenir Next"), ("helvetica", "Helvetica Neue"), ("new-york", "New York"), ("serif", "Book Serif"), ("custom", "Custom…")].map { NativeFontChoice(id: $0.0, name: $0.1) }
    static let mono = [("system-mono", "System"), ("geist-mono", "Geist Mono"), ("jetbrains-mono", "JetBrains Mono"), ("fira-code", "Fira Code"), ("cascadia", "Cascadia Code"), ("menlo", "Menlo"), ("custom", "Custom…")].map { NativeFontChoice(id: $0.0, name: $0.1) }
}

struct NativePalette: Identifiable {
    let id: String
    let name: String
    let canvas: UInt32
    let surface: UInt32
    let foreground: UInt32
    let accent: UInt32
    static let light: [NativePalette] = [
        .init(id: "falcon-light", name: "Falcon Light", canvas: 0xfbfbfc, surface: 0xffffff, foreground: 0x17171c, accent: 0x059669),
        .init(id: "catppuccin-latte", name: "Catppuccin Latte", canvas: 0xeff1f5, surface: 0xffffff, foreground: 0x4c4f69, accent: 0x8839ef),
        .init(id: "alucard", name: "Alucard", canvas: 0xfbf8e8, surface: 0xfffbeb, foreground: 0x1f1f1f, accent: 0x644ac9),
        .init(id: "gruvbox-light", name: "Gruvbox Light", canvas: 0xf9efc6, surface: 0xfbf1c7, foreground: 0x282828, accent: 0x427b58),
        .init(id: "nord-light", name: "Nord Light", canvas: 0xe9edf4, surface: 0xf8fafc, foreground: 0x2e3440, accent: 0x4c6f96),
        .init(id: "one-light", name: "One Light", canvas: 0xf2f2f3, surface: 0xfafafa, foreground: 0x383a42, accent: 0x3568d4),
        .init(id: "rose-pine-dawn", name: "Rosé Pine Dawn", canvas: 0xfaf4ed, surface: 0xfffaf3, foreground: 0x4a4566, accent: 0x907aa9),
        .init(id: "solarized-light", name: "Solarized Light", canvas: 0xf8f2e0, surface: 0xfdf6e3, foreground: 0x002b36, accent: 0x1a6c9c),
        .init(id: "tokyo-night-light", name: "Tokyo Night Light", canvas: 0xe4e6ee, surface: 0xeff1f7, foreground: 0x2e3350, accent: 0x2e7de9)
    ]
    static let dark: [NativePalette] = [
        .init(id: "falcon-dark", name: "Falcon Dark", canvas: 0x09090b, surface: 0x111113, foreground: 0xf4f4f6, accent: 0x34d399),
        .init(id: "catppuccin-mocha", name: "Catppuccin Mocha", canvas: 0x1e1e2e, surface: 0x282839, foreground: 0xcdd6f4, accent: 0xcba6f7),
        .init(id: "dracula", name: "Dracula", canvas: 0x282a36, surface: 0x343746, foreground: 0xf8f8f2, accent: 0xbd93f9),
        .init(id: "gruvbox-dark", name: "Gruvbox Dark", canvas: 0x282828, surface: 0x32302f, foreground: 0xfbf1c7, accent: 0x8ec07c),
        .init(id: "matrix", name: "Matrix", canvas: 0x0b120d, surface: 0x111b13, foreground: 0xd8f7df, accent: 0x35f477),
        .init(id: "nord", name: "Nord", canvas: 0x2e3440, surface: 0x3b4252, foreground: 0xeceff4, accent: 0x88c0d0),
        .init(id: "one-dark", name: "One Dark", canvas: 0x282c34, surface: 0x31353f, foreground: 0xdcdfe4, accent: 0x61afef),
        .init(id: "rose-pine", name: "Rosé Pine", canvas: 0x191724, surface: 0x1f1d2e, foreground: 0xe0def4, accent: 0xc4a7e7),
        .init(id: "solarized-dark", name: "Solarized Dark", canvas: 0x002b36, surface: 0x073642, foreground: 0xfdf6e3, accent: 0x268bd2),
        .init(id: "tokyo-night", name: "Tokyo Night", canvas: 0x1a1b26, surface: 0x24283b, foreground: 0xc0caf5, accent: 0x7aa2f7)
    ]
}
