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
