#if DEBUG
import Foundation

/// Local bot fixtures: marks (stored and resolved), STATUS.md, tickets, schedules and dispatches.
@MainActor enum BotPreview {
    static func start(in model: AppModel) {
        guard model.demo, ProcessInfo.processInfo.arguments.contains("--bots-preview") else { return }
        let projectID = Demo.projects[0].id
        let now = Date.now
        func iso(_ ago: TimeInterval) -> JSON { .string(now.addingTimeInterval(-ago).ISO8601Format()) }
        func home(_ id: String, _ title: String, status: String = "idle", pinned: Bool = false) -> JSON {
            .object(["id": .string(id), "workspace_id": .string(projectID), "title": .string(title), "provider": .string("codex"), "status": .string(status), "is_pinned": .bool(pinned), "updated_at": iso(900)])
        }
        func spawned(_ id: String, _ title: String, parent: String, status: String, ago: TimeInterval) -> JSON {
            .object(["id": .string(id), "workspace_id": .string(projectID), "title": .string(title), "provider": .string("claude"), "status": .string(status), "updated_at": iso(ago),
                     "last_message_preview": .string("Working through the checklist."),
                     "origin": .object(["kind": .string("agent_spawn"), "parent_thread_id": .string(parent), "dispatched_at": iso(ago)])])
        }
        let status = """
        ## Today

        - Triaged **14** new issues; 3 need a human decision.
        - Release train is green. Hand-off to [Release Captain](falcondeck://thread/preview-bot2-home) at 17:00.
        - Waiting on design for the onboarding copy.

        ## Blocked

        1. Staging deploy is flaky; retrying nightly.
        2. Needs `NOTIFY_KEY` rotated by James.

        ## Notes

        Keep summaries short. Link tickets as `FD-123`. The weekly review runs Friday morning and should include anything unresolved from the previous week plus a short list of risks for the next release.
        """
        func bot(_ id: String, _ name: String, icon: JSON?, extra: [String: JSON] = [:]) -> JSON {
            var fields: [String: JSON] = ["id": .string(id), "name": .string(name), "workspace_id": .string(projectID), "thread_id": .string("\(id)-home"), "instructions": .string("Help coordinate my projects and keep useful notes."), "can_start_threads": .bool(true), "dedicated_workspace": .bool(false), "space_path": .string("Demo bot documents")]
            if let icon { fields["icon"] = icon }
            return .object(fields.merging(extra) { $1 })
        }
        let concierge = bot("preview-bot", "Concierge", icon: .object(["shape": .string("diamond"), "color": .string("cat-8")]), extra: [
            "thread_id": .string("preview-bot-home"),
            "native_demo_documents": .array([.object(["name": .string("STATUS.md"), "content": .string(status), "version": .string("v1"), "modified_at": iso(3 * 3600)])]),
            "native_demo_tickets": .array([
                .object(["id": .string("FD-214"), "title": .string("Rotate notification key"), "state": .string("open"), "priority": .string("p1"), "owner": .string("Concierge"), "created_at": iso(86_400 * 3)]),
                .object(["id": .string("FD-219"), "title": .string("Draft onboarding copy review"), "state": .string("in_progress"), "priority": .string("p2"), "owner": .string("Concierge"), "created_at": iso(86_400 * 2)]),
                .object(["id": .string("FD-230"), "title": .string("Summarize weekly risks"), "state": .string("open"), "priority": .string("p3"), "owner": .string("Concierge"), "created_at": iso(86_400)])
            ])
        ])
        // The second bot has no stored mark, like one saved before icons existed.
        let captain = bot("preview-bot2", "Release Captain", icon: nil, extra: ["thread_id": .string("preview-bot2-home")])
        let triage = bot("preview-bot3", "Inbox Triage", icon: .object(["shape": .string("star"), "color": .string("cat-5")]), extra: ["thread_id": .string("preview-bot3-home")])
        model.preferences = model.preferences.setting("bots", .array([concierge, captain, triage]))
        for task in [home("preview-bot-home", "Concierge", pinned: true), home("preview-bot2-home", "Release Captain"), home("preview-bot3-home", "Inbox Triage"),
                     spawned("preview-spawn-1", "Fix flaky staging deploy", parent: "preview-bot-home", status: "running", ago: 1_800),
                     spawned("preview-spawn-2", "Write onboarding copy options", parent: "preview-bot2-home", status: "waiting_for_input", ago: 7_200),
                     spawned("preview-spawn-3", "Cut release notes", parent: "preview-bot2-home", status: "idle", ago: 20_000)] {
            model.upsertTask(task)
        }
        func schedule(_ id: String, _ name: String, state: String, trigger: JSON) -> NativeAutomation {
            NativeAutomation(raw: .object(["id": .string(id), "revision": .number(1), "name": .string(name), "state": .string(state), "trigger": trigger,
                                           "next_run_at": .string(now.addingTimeInterval(5_400).ISO8601Format()),
                                           "target": .object(["provider": .string("codex"), "thread": .object(["kind": .string("existing"), "thread_id": .string("preview-bot-home")])])]))
        }
        model.automations.rows = [
            schedule("preview-auto-1", "Morning status refresh", state: "enabled", trigger: .object(["kind": .string("cron"), "expression": .string("0 8 * * 1-5"), "timezone": .string("Europe/London")])),
            schedule("preview-auto-2", "Weekly risk review", state: "paused", trigger: .object(["kind": .string("interval"), "every_seconds": .number(604_800)]))
        ]
    }
}
#endif
