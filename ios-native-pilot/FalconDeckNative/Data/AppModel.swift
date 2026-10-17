import Foundation
import Observation

@MainActor @Observable
final class AppModel {
    let relay = RelayClient()
    var projects: [Project] = []
    var tasks: [AgentTask] = []
    var connected = false
    var status = "Not connected"
    var error: String?
    var demo = false
    var hasSession = false
    var busy = false
    var refreshedAt: Date?
    var showConnection = false
    var pairingText = ""
    private var observation: Task<Void, Never>?

    func start() async {
        guard observation == nil else { return }
        let events = await relay.events()
        observation = Task { [weak self] in
            for await event in events {
                guard let self else { return }
                switch event {
                case .status(let text, let online):
                    if !self.demo { self.status = text; self.connected = online }
                case .snapshot(let value):
                    self.projects = value["workspaces"].array.filter { $0["kind"].string != "scratch" }.map(Project.init)
                    self.tasks = value["threads"].array.filter { !$0["is_archived"].bool }.map(AgentTask.init)
                    self.refreshedAt = .now; self.error = nil; self.demo = false
                case .error(let message): self.error = message; self.connected = false
                }
            }
        }
        if ProcessInfo.processInfo.arguments.contains("--demo") { await useDemo(); return }
        do { hasSession = try await relay.restore() }
        catch { self.error = error.localizedDescription; hasSession = (try? SessionVault.load()) != nil }
    }

    func pair(relayURL: String) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let input = try PairingInput(text: pairingText, relay: relayURL)
            try await relay.pair(input)
            hasSession = true; demo = false; projects = []; tasks = []; pairingText = ""
            showConnection = false
        } catch { self.error = error.localizedDescription }
    }

    func reconnect() async {
        guard hasSession, !busy, !demo else { return }
        busy = true; error = nil
        defer { busy = false }
        do { hasSession = try await relay.restore() }
        catch { self.error = error.localizedDescription }
    }
    func refresh() async {
        if demo { return }
        if !connected { await reconnect() }
        else { await relay.refresh() }
    }
    func forget() async {
        do {
            try await relay.disconnect(forget: true)
            projects = []; tasks = []; demo = false; hasSession = false; refreshedAt = nil; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func useDemo() async {
        try? await relay.disconnect()
        demo = true; connected = false; error = nil; status = "Demo workspace"
        projects = Demo.projects; tasks = Demo.tasks; refreshedAt = nil
    }
    func tasks(in project: Project) -> [AgentTask] {
        tasks.filter { $0.projectID == project.id }.sorted {
            if $0.pinned != $1.pinned { return $0.pinned }
            return $0.updatedAt > $1.updatedAt
        }
    }
    var sortedProjects: [Project] {
        projects.sorted { lhs, rhs in
            let left = tasks.contains { $0.projectID == lhs.id && $0.running }
            let right = tasks.contains { $0.projectID == rhs.id && $0.running }
            if left != right { return left }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }
}

enum Demo {
    static let projects: [Project] = [
        project("falcondeck", "/Projects/falcondeck"), project("quizgecko", "/Projects/quizgecko"),
        project("lookset", "/Projects/lookset"), project("lucidpic", "/Projects/lucidpic")
    ]
    static let tasks: [AgentTask] = [
        task("native", "falcondeck", "A more native way to work", "codex", "running", "Exploring the little details that make an app feel right at home on iPhone.", pinned: true),
        task("relay", "falcondeck", "Make reconnects feel instant", "claude", "idle", "The relay recovery path now restores a fresh snapshot when history has been pruned."),
        task("review", "falcondeck", "Review the new project sidebar", "codex", "waiting_for_input", "The implementation is ready. There’s one decision to make about the compact layout."),
        task("quiz", "quizgecko", "Bring the study flow to SwiftUI", "claude", "running", "The flashcard transition now follows your gesture with a spring animation."),
        task("voice", "quizgecko", "Polish the voice tutor", "codex", "idle", "The tutor keeps listening while you move between study materials."),
        task("samples", "lookset", "A fresh set of product scenes", "claude", "idle", "Four directions, with consistent lighting and a quieter background."),
        task("images", "lucidpic", "Simplify the image library", "codex", "idle", "The library now groups recent generations into a single collection.")
    ]
    static let messages: [Message] = [
        message("1", "user_message", "Let’s explore a truly native FalconDeck. Keep the core experience simple, but make it feel great on iPhone."),
        message("2", "assistant_message", "I’ve narrowed the pilot down to three things: your projects, the tasks inside them, and the conversations that matter.\n\nThe interface uses **native SwiftUI navigation**, SF Symbols, and glass controls. Project cards open with a zoom transition, and the layout adapts to your text size."),
        message("3", "user_message", "Can it talk to the real relay too?"),
        message("4", "assistant_message", "Yes. Paste a secure pairing link from your computer into **Connection**. This client has its own identity and stores its credentials in Keychain.\n\nThe pilot reads projects and the latest 50 conversation items over the encrypted relay. Pull to refresh whenever you want an updated view.\n\nThis sample conversation is demo content. Your live tasks appear only after connecting.")
    ]
    private static func project(_ id: String, _ path: String) -> Project {
        Project(.object(["id": .string(id), "path": .string(path), "status": .string("connected")]))
    }
    private static func task(_ id: String, _ project: String, _ title: String, _ provider: String, _ status: String, _ preview: String, pinned: Bool = false) -> AgentTask {
        AgentTask(.object(["id": .string(id), "workspace_id": .string(project), "title": .string(title), "provider": .string(provider),
                           "status": .string(status), "last_message_preview": .string(preview), "updated_at": .string("2026-10-17T07:00:00Z"), "is_pinned": .bool(pinned)]))
    }
    private static func message(_ id: String, _ kind: String, _ text: String) -> Message {
        Message(.object(["id": .string(id), "kind": .string(kind), "text": .string(text)]))
    }
}
