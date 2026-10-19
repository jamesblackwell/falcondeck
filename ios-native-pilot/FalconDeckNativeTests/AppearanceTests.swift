import UIKit
import XCTest
@testable import FalconDeckNative

// UIKit may resolve a dynamic color on a render queue. The test deliberately
// exercises that UIKit callback outside the main actor.
private struct RenderColor: @unchecked Sendable { let color: UIColor }

@MainActor final class AppearanceTests: XCTestCase {
    func testDynamicColorCanBeResolvedOnABackgroundRenderQueue() async {
        let color = RenderColor(color: NativeAppearance.dynamicColor(light: "#ffffff", dark: "#123456"))
        let components = await Task.detached {
            color.color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark)).cgColor.components ?? []
        }.value
        XCTAssertEqual(components.first ?? 0, 18.0 / 255, accuracy: 0.001)
    }
}

@MainActor final class PaletteContrastTests: XCTestCase {
    func testEveryPalettesTextMeetsContrastOnNativeContentSurfaces() {
        XCTAssertEqual(NativeAppearance.palettes.count, 19)
        for palette in NativeAppearance.palettes {
            let roles = ["primary", "secondary", "tertiary", "muted"].map { ("fg", $0) } + ["keyword", "number", "string"].map { ("code", $0) }
            for (group, role) in roles {
                for surface in 0...3 {
                    let background = palette.value("surface", String(surface))!
                    for increased in [false, true] {
                        let foreground = palette.value(group, role, increasedContrast: increased)!
                        XCTAssertGreaterThanOrEqual(NativeTextContrast.ratio(foreground, background), increased ? 7 : 4.5,
                            "\(palette.id): \(role) on surface \(surface), increased contrast \(increased)")
                    }
                }
            }
        }
    }
    func testReadableColorsAndNonTextTokensKeepTheirOriginalPaletteValues() {
        for palette in NativeAppearance.palettes {
            XCTAssertEqual(palette.value("fg", "primary"), palette.raw["colors"]["fg"]["primary"].string)
            XCTAssertEqual(palette.value("accent"), palette.raw["colors"]["accent"]["default"].string)
            XCTAssertEqual(palette.value("surface", "0"), palette.raw["colors"]["surface"]["0"].string)
        }
    }
    func testContrastFormulaUsesLinearSRGB() {
        XCTAssertEqual(NativeTextContrast.ratio("#000000", "#ffffff"), 21, accuracy: 0.001)
        XCTAssertEqual(NativeTextContrast.ratio("#777777", "#ffffff"), 4.478, accuracy: 0.001)
        XCTAssertEqual(NativeTextContrast.ratio("#ff0000", "#ffffff"), 3.998, accuracy: 0.001)
    }
    func testIncreasedContrastResolvesWithUIKitTraitsOffTheMainActor() async {
        let color = RenderColor(color: NativeAppearance.dynamicColor(light: "#123456", dark: "#abcdef", increasedLight: "#000000", increasedDark: "#ffffff"))
        let components = await Task.detached {
            color.color.resolvedColor(with: UITraitCollection(traitsFrom: [UITraitCollection(userInterfaceStyle: .light), UITraitCollection(accessibilityContrast: .high)])).cgColor.components ?? []
        }.value
        XCTAssertEqual(components.first ?? 1, 0, accuracy: 0.001)
    }
}
