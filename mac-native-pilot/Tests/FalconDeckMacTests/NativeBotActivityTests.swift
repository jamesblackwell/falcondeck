import XCTest
@testable import FalconDeckMac

final class NativeBotActivityTests: XCTestCase {
    private let bot = NativeBot(raw: .object(["id": .string("bot"), "name": .string("Juno"), "thread_id": .string("home")]))

    private func task(_ id: String, status: String = "idle", child: Bool = true) -> AgentTask {
        var fields: [String: JSON] = ["id": .string(id), "title": .string("Build \(id)"), "status": .string(status)]
        if child { fields["origin"] = .object(["kind": .string("agent_spawn"), "parent_thread_id": .string("home")]) }
        return AgentTask(.object(fields))
    }

    func testHomeRunningShowsWorking() {
        let activity = NativeBotActivity(bot: bot, tasks: [task("home", status: "running", child: false), task("a", status: "running")])
        XCTAssertTrue(activity.homeRunning)
        XCTAssertEqual(activity.runningTasks.map(\.id), ["a"])
    }

    func testOnlyChildrenRunningIsAQuietCount() {
        let activity = NativeBotActivity(bot: bot, tasks: [
            task("home", child: false), task("a", status: "running"), task("b", status: "running"), task("c", status: "running"),
            task("stranger", status: "running", child: false),
        ])
        XCTAssertFalse(activity.homeRunning)
        XCTAssertEqual(activity.runningLabel, "3 running")
        XCTAssertEqual(activity.runningHelp, "3 tasks running:\nBuild a\nBuild b\nBuild c")
    }

    func testIdleHasNoIndicator() {
        let activity = NativeBotActivity(bot: bot, tasks: [task("home", child: false), task("a")])
        XCTAssertFalse(activity.homeRunning)
        XCTAssertNil(activity.runningLabel)
    }
}
