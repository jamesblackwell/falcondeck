import Foundation

/// Correct only readable ink, retaining the catalogue's surfaces and accent
/// identity. Palette instances cache both contrast variants before rendering.
enum NativeTextContrast {
    static func ratio(_ foreground: String, _ background: String) -> Double {
        let values = [luminance(rgb(foreground)), luminance(rgb(background))].sorted()
        return (values[1] + 0.05) / (values[0] + 0.05)
    }

    static func adjusted(_ foreground: String, on backgrounds: [String], dark: Bool, minimum: Double) -> String {
        guard backgrounds.contains(where: { ratio(foreground, $0) < minimum }) else { return foreground }
        let source = rgb(foreground), target = dark ? 1.0 : 0.0
        func candidate(_ amount: Double) -> String {
            let components = source.map { Int((($0 + (target - $0) * amount) * 255).rounded()) }
            return String(format: "#%02x%02x%02x", components[0], components[1], components[2])
        }
        var low = 0.0, high = 1.0
        for _ in 0..<20 {
            let midpoint = (low + high) / 2
            if backgrounds.allSatisfy({ ratio(candidate(midpoint), $0) >= minimum }) { high = midpoint }
            else { low = midpoint }
        }
        return candidate(high)
    }

    private static func rgb(_ hex: String) -> [Double] {
        let value = UInt32(hex.dropFirst(), radix: 16) ?? 0
        return [16, 8, 0].map { Double((value >> $0) & 255) / 255 }
    }

    private static func luminance(_ rgb: [Double]) -> Double {
        let linear = rgb.map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
        return zip(linear, [0.2126, 0.7152, 0.0722]).reduce(0) { $0 + $1.0 * $1.1 }
    }
}

struct NativeThemePalette: Identifiable, Sendable {
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

    var id: String { raw["id"].string }
    var label: String { raw["label"].string }
    var dark: Bool { raw["appearance"].string == "dark" }

    func value(_ group: String, _ key: String = "default", increasedContrast: Bool = false) -> String? {
        if group == "fg" || group == "code",
           let ink = (increasedContrast ? increasedInk : readableInk)[group == "code" ? "code." + key : key] { return ink }
        let token = group == "cat" && key.hasPrefix("cat-") ? String(key.dropFirst(4)) : key
        return raw["colors"][group][token].string.nonempty ?? raw["colors"][group].string.nonempty
    }
}
