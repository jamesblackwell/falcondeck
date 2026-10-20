import AppKit
import XCTest
@testable import FalconDeckMac

@MainActor final class ThemeTests: XCTestCase {
    func testCatalogueContainsEveryNamedLightAndDarkTheme() {
        let expected = [
            "falcon-light": "Falcon Light", "catppuccin-latte": "Catppuccin Latte", "alucard": "Alucard",
            "gruvbox-light": "Gruvbox Light", "nord-light": "Nord Light", "one-light": "One Light",
            "rose-pine-dawn": "Rosé Pine Dawn", "solarized-light": "Solarized Light", "tokyo-night-light": "Tokyo Night Light",
            "falcon-dark": "Falcon Dark", "catppuccin-mocha": "Catppuccin Mocha", "dracula": "Dracula",
            "gruvbox-dark": "Gruvbox Dark", "matrix": "Matrix", "nord": "Nord", "one-dark": "One Dark",
            "rose-pine": "Rosé Pine", "solarized-dark": "Solarized Dark", "tokyo-night": "Tokyo Night"
        ]
        XCTAssertEqual(FDTheme.palettes.mapValues(\.label), expected)
        XCTAssertEqual(FDTheme.palettes.values.filter { !$0.dark }.count, 9)
        XCTAssertEqual(FDTheme.palettes.values.filter(\.dark).count, 10)
    }

    func testReadableInkMeetsContrastOnAllFourContentSurfaces() throws {
        XCTAssertEqual(FDTheme.palettes.count, 19)
        let roles = ["primary", "secondary", "tertiary", "muted"].map { ("fg", $0) }
            + ["keyword", "number", "string"].map { ("code", $0) }
        for palette in FDTheme.palettes.values {
            for increased in [false, true] {
                for (group, role) in roles {
                    let ink = try XCTUnwrap(palette.value(group, role, increasedContrast: increased))
                    for surface in 0...3 {
                        let background = try XCTUnwrap(palette.value("surface", String(surface)))
                        XCTAssertGreaterThanOrEqual(NativeTextContrast.ratio(ink, background), increased ? 7 : 4.5,
                            "\(palette.id): \(group).\(role) on surface \(surface), increased: \(increased)")
                    }
                }
            }
        }
    }

    func testContrastCorrectionPreservesSurfacesAccentsAndOtherNonTextTokens() {
        for palette in FDTheme.palettes.values {
            for (group, value) in palette.raw["colors"].fields where group != "fg" {
                if case .object(let tokens) = value {
                    for (key, original) in tokens {
                        XCTAssertEqual(palette.value(group, key), original.string, "\(palette.id): \(group).\(key)")
                        XCTAssertEqual(palette.value(group, key, increasedContrast: true), original.string)
                    }
                } else {
                    XCTAssertEqual(palette.value(group), value.string)
                    XCTAssertEqual(palette.value(group, increasedContrast: true), value.string)
                }
            }
            let original = palette.raw["colors"]["fg"]["primary"].string
            XCTAssertEqual(palette.value("fg", "primary"), original)
        }
    }

    func testPersistedCategoryTokensResolveToActualCatalogueSlots() {
        for palette in FDTheme.palettes.values {
            for slot in 1...12 {
                let original = palette.raw["colors"]["cat"][String(slot)].string
                XCTAssertFalse(original.isEmpty)
                XCTAssertEqual(palette.value("cat", "cat-\(slot)"), original)
                XCTAssertEqual(palette.value("cat", String(slot)), original)
            }
        }
    }

    func testDynamicColorsResolveLightDarkAndIncreasedContrastAppearance() throws {
        // A named accessibility appearance may normalize to Aqua when the
        // machine's Increase Contrast preference is off. Supply that observed
        // preference explicitly, just as the production color factory does.
        for increased in [false, true] {
            let color = FDTheme.dynamicColor(light: "#123456", dark: "#abcdef",
                increasedLight: "#000000", increasedDark: "#ffffff", increasedContrast: increased)
            for (name, ordinary, high) in [(NSAppearance.Name.aqua, 0x12, 0x00), (.darkAqua, 0xab, 0xff)] {
                let appearance = try XCTUnwrap(NSAppearance(named: name))
                var resolved: NSColor?
                appearance.performAsCurrentDrawingAppearance { resolved = color.usingColorSpace(.sRGB) }
                XCTAssertEqual(try XCTUnwrap(resolved).redComponent, CGFloat(increased ? high : ordinary) / 255,
                    accuracy: 0.001, "\(name.rawValue), increased: \(increased)")
            }
        }
    }

    func testExplicitThemeModeKeepsItsPaletteAcrossSystemAppearanceChanges() throws {
        for (mode, expected) in [("light", 0x12), ("dark", 0xab)] {
            let color = FDTheme.dynamicColor(light: "#123456", dark: "#abcdef", mode: mode)
            for name in [NSAppearance.Name.aqua, .darkAqua] {
                let appearance = try XCTUnwrap(NSAppearance(named: name))
                var resolved: NSColor?
                appearance.performAsCurrentDrawingAppearance { resolved = color.usingColorSpace(.sRGB) }
                XCTAssertEqual(try XCTUnwrap(resolved).redComponent, CGFloat(expected) / 255, accuracy: 0.001)
            }
        }
    }

    func testContrastFormulaUsesLinearSRGBAndKeepsAlreadyReadableInk() {
        XCTAssertEqual(NativeTextContrast.ratio("#000000", "#ffffff"), 21, accuracy: 0.001)
        XCTAssertEqual(NativeTextContrast.ratio("#777777", "#ffffff"), 4.478, accuracy: 0.001)
        XCTAssertEqual(NativeTextContrast.ratio("#ff0000", "#ffffff"), 3.998, accuracy: 0.001)
        XCTAssertEqual(NativeTextContrast.adjusted("#abcdef", on: ["#111111"], dark: true, minimum: 4.5), "#abcdef")
    }
}
