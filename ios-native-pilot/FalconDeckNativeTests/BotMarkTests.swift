import SwiftUI
import XCTest
@testable import FalconDeckNative

private actor QuietRelay: RelayServing {
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async -> JSON { .null }
}

@MainActor final class BotMarkTests: XCTestCase {
    private func icon(_ shape: String, _ color: String) -> NativeBotIcon { NativeBotIcon(shape: shape, color: color) }

    func testStoredIconsParseOnlyKnownShapesAndTokens() {
        XCTAssertEqual(NativeBotIcon(raw: .object(["shape": .string("hexagon"), "color": .string("cat-12")])), icon("hexagon", "cat-12"))
        XCTAssertNil(NativeBotIcon(raw: .object(["shape": .string("blob"), "color": .string("cat-1")])))
        XCTAssertNil(NativeBotIcon(raw: .object(["shape": .string("circle"), "color": .string("#f87171")])))
        XCTAssertNil(NativeBotIcon(raw: .object(["shape": .string("circle"), "color": .string("cat-13")])))
        XCTAssertNil(NativeBotIcon(raw: .null))
        XCTAssertEqual(icon("star", "cat-7").colorSlot, "7")
    }

    func testMissingIconsTakeTheNextUnusedShapeAndColorLikeTheDaemon() {
        let resolved = NativeBotIcon.resolve([("a", icon("circle", "cat-1")), ("b", nil), ("c", icon("square", "cat-3")), ("d", nil)])
        XCTAssertEqual(resolved["a"], icon("circle", "cat-1"))
        XCTAssertEqual(resolved["b"], icon("diamond", "cat-2"))
        XCTAssertEqual(resolved["c"], icon("square", "cat-3"))
        XCTAssertEqual(resolved["d"], icon("triangle", "cat-4"))
    }

    func testResolutionCyclesWhenEveryOptionIsTaken() {
        let bots: [(id: String, icon: NativeBotIcon?)] = (0..<13).map { ("bot-\($0)", nil) }
        let resolved = NativeBotIcon.resolve(bots)
        XCTAssertEqual(resolved.count, 13)
        XCTAssertEqual(resolved["bot-0"], icon("circle", "cat-1"))
        XCTAssertEqual(resolved["bot-7"], icon("cross", "cat-8"))
        // Eight shapes are used up, so the ninth bot wraps by count (8 % 8 = 0), as client-core does.
        XCTAssertEqual(resolved["bot-8"]?.shape, "circle")
        XCTAssertEqual(resolved["bot-8"]?.color, "cat-9")
    }

    func testEveryShapeDrawsInsideItsBoxAndFillsSomething() {
        for shape in NativeBotIcon.shapes + ["unknown"] {
            let renderer = ImageRenderer(content: BotMark(icon: icon(shape, "cat-4"), size: 32))
            renderer.scale = 2
            XCTAssertNotNil(renderer.uiImage, shape)
            XCTAssertEqual(renderer.uiImage?.size.width, 32, shape)
        }
    }

    func testScheduleCadenceReadsAsAPersonWouldSayIt() {
        XCTAssertEqual(BotInfoView.every(seconds: 604_800), "Every 7 days")
        XCTAssertEqual(BotInfoView.every(seconds: 86_400), "Every day")
        XCTAssertEqual(BotInfoView.every(seconds: 7_200), "Every 2 hours")
        XCTAssertEqual(BotInfoView.every(seconds: 600), "Every 10 minutes")
        XCTAssertEqual(BotInfoView.every(seconds: 5_400), "Every 90 minutes")
        XCTAssertEqual(BotInfoView.every(seconds: 0), "Every minute")
    }

    func testDispatchedTasksAndLinksResolveToTheirBotAcrossHarnessSwitches() async {
        let model = AppModel.testing(relay: QuietRelay())
        let bot = JSON.object(["id": .string("b"), "name": .string("Concierge"), "workspace_id": .string("w"), "thread_id": .string("home-2"),
                               "previous_thread_ids": .array([.string("home-1")]), "icon": .object(["shape": .string("star"), "color": .string("cat-5")])])
        model.preferences = model.preferences.setting("bots", .array([bot]))
        XCTAssertEqual(model.botIcon(forTask: "home-2"), icon("star", "cat-5"))
        XCTAssertEqual(model.botIcon(forTask: "home-1"), icon("star", "cat-5"))
        XCTAssertNil(model.botIcon(forTask: "elsewhere"))
        let child = AgentTask(.object(["id": .string("t"), "origin": .object(["kind": .string("agent_spawn"), "parent_thread_id": .string("home-1")])]))
        XCTAssertEqual(model.dispatchingBot(of: child)?.id, "b")
        XCTAssertNil(model.dispatchingBot(of: AgentTask(.object(["id": .string("u"), "origin": .object(["kind": .string("user")])]))))
    }
}
