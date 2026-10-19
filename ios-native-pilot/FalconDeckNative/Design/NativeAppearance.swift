import SwiftUI
import Observation

struct NativePalette: Identifiable, Sendable {
    let raw: JSON
    private let readableInk: [String: String]
    private let increasedInk: [String: String]
    init(raw: JSON) {
        self.raw = raw
        let colors = raw["colors"], dark = raw["appearance"].string == "dark"
        let backgrounds = (0...3).map { colors["surface"][String($0)].string }
        let roles = ["primary", "secondary", "tertiary", "muted"].map { ($0, colors["fg"][$0].string) }
            + [("code.keyword", colors["accent"]["strong"].string), ("code.number", colors["warning"]["default"].string), ("code.string", colors["info"]["default"].string)]
        readableInk = Dictionary(uniqueKeysWithValues: roles.map { role, color in
            (role, NativeTextContrast.adjusted(color, on: backgrounds, dark: dark, minimum: 4.5))
        })
        increasedInk = Dictionary(uniqueKeysWithValues: roles.map { role, color in
            (role, NativeTextContrast.adjusted(color, on: backgrounds, dark: dark, minimum: 7))
        })
    }
    func value(_ group: String, _ key: String = "default", increasedContrast: Bool = false) -> String? {
        if group == "fg" || group == "code", let ink = (increasedContrast ? increasedInk : readableInk)[group == "code" ? "code." + key : key] { return ink }
        return raw["colors"][group][key].string.nonempty ?? raw["colors"][group].string.nonempty
    }
    var id: String { raw["id"].string }
    var label: String { raw["label"].string }
    var dark: Bool { raw["appearance"].string == "dark" }
}

@MainActor @Observable
final class NativeAppearance {
    static let shared = NativeAppearance()
    static let palettes: [NativePalette] = {
        guard let url = Bundle.main.url(forResource: "PaletteCatalog", withExtension: "json"), let bytes = try? Data(contentsOf: url), let catalog = try? JSON.decode(bytes) else { return [] }
        return catalog["themes"].array.map { NativePalette(raw: $0) }
    }()
    var mode: String { didSet { UserDefaults.standard.set(mode, forKey: "native.appearance.mode") } }
    var lightID: String { didSet { UserDefaults.standard.set(lightID, forKey: "native.appearance.light") } }
    var darkID: String { didSet { UserDefaults.standard.set(darkID, forKey: "native.appearance.dark") } }
    var textScale: Double { didSet { UserDefaults.standard.set(textScale, forKey: "native.appearance.scale") } }
    private init() {
        let defaults = UserDefaults.standard
        mode = defaults.string(forKey: "native.appearance.mode") ?? "system"
        lightID = defaults.string(forKey: "native.appearance.light") ?? "falcon-light"
        darkID = defaults.string(forKey: "native.appearance.dark") ?? "falcon-dark"
        let scale = defaults.double(forKey: "native.appearance.scale")
        textScale = scale >= 0.8 && scale <= 1.5 ? scale : 1
    }
    var colorScheme: ColorScheme? { mode == "light" ? .light : mode == "dark" ? .dark : nil }
    func color(_ group: String, _ key: String = "default") -> Color {
        let light = Self.palettes.first { $0.id == lightID } ?? Self.palettes.first { !$0.dark }
        let dark = Self.palettes.first { $0.id == darkID } ?? Self.palettes.first { $0.dark }
        return Color(Self.dynamicColor(
            light: light?.value(group, key) ?? "#17171c", dark: dark?.value(group, key) ?? "#f4f4f6",
            increasedLight: light?.value(group, key, increasedContrast: true),
            increasedDark: dark?.value(group, key, increasedContrast: true)))
    }
    nonisolated static func dynamicColor(light: String, dark: String, increasedLight: String? = nil, increasedDark: String? = nil) -> UIColor {
        // UIKit resolves traits on background render queues as well as main.
        UIColor { @Sendable traits in
            let high = traits.accessibilityContrast == .high
            return Self.uiColor(traits.userInterfaceStyle == .dark ? (high ? increasedDark ?? dark : dark) : (high ? increasedLight ?? light : light))
        }
    }
    func textSize(relativeTo system: DynamicTypeSize) -> DynamicTypeSize {
        let sizes: [DynamicTypeSize] = [.xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge, .accessibility1, .accessibility2, .accessibility3, .accessibility4, .accessibility5]
        let offset = Int((log(textScale) / log(1.13)).rounded())
        return sizes[max(0, min(sizes.count - 1, (sizes.firstIndex(of: system) ?? 3) + offset))]
    }
    nonisolated static func uiColor(_ value: String) -> UIColor {
        if value.hasPrefix("#"), let hex = UInt64(value.dropFirst(), radix: 16) {
            return UIColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
        }
        let parts = value.replacingOccurrences(of: "rgba(", with: "").replacingOccurrences(of: ")", with: "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 4 else { return .label }
        return UIColor(red: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: parts[3])
    }
}
