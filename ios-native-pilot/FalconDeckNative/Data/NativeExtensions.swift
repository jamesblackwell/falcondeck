import Foundation
import Observation

struct NativeExtensionFilter: Identifiable {
    let extensionID: String
    let contribution: JSON
    let document: JSON
    var id: String { extensionID + ":" + contribution["id"].string }
    var title: String { document["root"]["label"].string.nonempty ?? contribution["title"].string }
    var supported: Bool {
        let binding = document["root"]["binding"]
        return document["version"].int == 1 && document["root"]["type"].string == "select" && binding["operator"].string == "includes_any" && !binding["path"].array.isEmpty && binding["path"].array.count <= 16 && binding["path"].array.allSatisfy { !$0.string.isEmpty && !["__proto__", "prototype", "constructor"].contains($0.string) } && document["root"]["options"].array.count <= 100
    }
}

struct NativeSuggestionOffer {
    let key: String
    let actions: [JSON]
}

@MainActor @Observable final class NativeExtensions {
    var catalog: [JSON] = []
    var views: [JSON] = [] {
        didSet {
            viewIndex = Dictionary(views.map { (Self.key($0), $0) }, uniquingKeysWith: { _, new in new })
            threadViews = Dictionary(grouping: views.filter { $0["scope"]["kind"].string == "thread" }) { $0["scope"]["id"].string }
        }
    }
    private var viewIndex: [JSON: JSON] = [:]
    private var threadViews: [String: [JSON]] = [:]
    var selections: [String: Set<String>] = [:]
    var dismissed: [String: String] = [:]
    var error: String?
    private var token: String?
    private var loaded = false
    private var loadingID: UUID?
    private var touched: Set<JSON> = []
    private var catalogTouched = false
    static let stagesID = "falcondeck.thread-tags"
    func reset() { catalog = []; views = []; selections = [:]; dismissed = [:]; token = nil; loaded = false; loadingID = nil; touched = []; catalogTouched = false; error = nil }
    func setBase(_ value: JSON, token: String?) {
        self.token = token; loadingID = nil; touched = []; catalogTouched = false
        loaded = token == nil
        if token == nil { catalog = value["catalog"].array; views = value["views"].array }
    }
    static func key(_ view: JSON) -> JSON { .array([view["extension_id"], view["view_id"], view["scope"]["kind"], view["scope"]["id"]]) }
    func apply(_ event: JSON) {
        switch event["type"].string {
        case "extension-catalog-updated": catalog = event["catalog"].array; catalogTouched = true
        case "extension-view-updated":
            let view = event["view"]
            let key = Self.key(view == .null ? event : view); touched.insert(key)
            views.removeAll { Self.key($0) == key }
            if view != .null { views.append(view) }
        default: break
        }
    }
    func load(model: AppModel, force: Bool = false) async {
        guard loadingID == nil, force || !loaded, model.connected, !model.demo else { return }
        let load = UUID(), current = model.connectionID, currentToken = token
        loadingID = load; error = nil
        defer { if loadingID == load { loadingID = nil } }
        do {
            let value = try await model.relay.call(currentToken == nil ? "extensions.read" : "sync.extensions", params: currentToken.map { .object(["token": .string($0)]) } ?? .object([:]))
            guard current == model.connectionID, loadingID == load, currentToken == token else { return }
            if !catalogTouched { catalog = value["catalog"].array }
            var merged = Dictionary(views.map { (Self.key($0), $0) }, uniquingKeysWith: { _, new in new })
            for view in value["views"].array where !touched.contains(Self.key(view)) { merged[Self.key(view)] = view }
            views = Array(merged.values); loaded = true
        } catch { if current == model.connectionID, loadingID == load { self.error = error.localizedDescription } }
    }
    var enabled: [JSON] { catalog.filter { $0["enabled"].bool } }
    func document(extensionID: String, contribution: JSON) -> JSON {
        let published = viewIndex[.array([.string(extensionID), contribution["view"], .null, .null])]?["value"] ?? .null
        return published["version"] != .null && published["root"] != .null ? published : contribution["ui"]
    }
    var filters: [NativeExtensionFilter] {
        enabled.flatMap { item in item["contributes"]["sidebarFilters"].array.map { NativeExtensionFilter(extensionID: item["id"].string, contribution: $0, document: document(extensionID: item["id"].string, contribution: $0)) } }.filter { $0.document != .null }
    }
    func matches(_ task: AgentTask) -> Bool {
        filters.allSatisfy { filter in
            let selected = selections[filter.id] ?? []
            guard filter.supported, !selected.isEmpty else { return true }
            let binding = filter.document["root"]["binding"]
            guard let view = viewIndex[.array([.string(filter.extensionID), binding["view"], .string("thread"), .string(task.id)])] else { return false }
            let values = binding["path"].array.reduce(view["value"]) { $0[$1.string] }
            return values.array.contains { selected.contains($0.string) }
        }
    }
    var stages: [JSON] {
        guard enabled.contains(where: { $0["id"].string == Self.stagesID }) else { return [] }
        let published = viewIndex[.array([.string(Self.stagesID), .string("tag-index"), .null, .null])]?["value"]["tags"].array ?? []
        let tags = published.filter { !$0["id"].string.isEmpty && !$0["label"].string.isEmpty && !$0["color"].string.isEmpty }
        let legacy: Set<String> = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"]
        if !tags.isEmpty, !(tags.count == 8 && Set(tags.map { $0["id"].string }) == legacy) { return tags }
        return [("backlog", "Backlog", "gray"), ("in_progress", "In progress", "yellow"), ("in_review", "In review", "green"), ("done", "Done", "orange"), ("canceled", "Canceled", "gray")].map { .object(["id": .string($0.0), "label": .string($0.1), "color": .string($0.2)]) }
    }
    func stage(_ task: AgentTask) -> JSON? {
        let ids = viewIndex[.array([.string(Self.stagesID), .string("thread-tags"), .string("thread"), .string(task.id)])]?["value"]["tagIds"].array ?? []
        return stages.first { ids.contains($0["id"]) }
    }
    func suggestions(_ task: AgentTask) -> NativeSuggestionOffer? {
        guard task.status == "idle", !task.isDraft else { return nil }
        for item in enabled.sorted(by: { $0["id"].string < $1["id"].string }) {
            let contributions = item["contributes"]["composerSuggestions"].array
            for view in threadViews[task.id] ?? [] where view["extension_id"] == item["id"] && contributions.contains(where: { $0["view"] == view["view_id"] }) {
                var actions = Array(view["value"]["actions"].array.filter { !$0["id"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !$0["label"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !$0["prompt"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.prefix(5)).map { $0.setting("label", .string(String($0["label"].string.prefix(30)))).setting("prompt", .string(String($0["prompt"].string.prefix(512)))) }
                if let preferred = actions.firstIndex(where: { $0["id"] == view["value"]["preferredActionId"] }), preferred > 0 { actions.insert(actions.remove(at: preferred), at: 0) }
                guard !actions.isEmpty else { continue }
                let key = item["id"].string + ":" + view["updated_at"].string + ":" + actions.map { $0["id"].string }.joined(separator: ",")
                if dismissed[task.id] != key { return NativeSuggestionOffer(key: key, actions: actions) }
            }
        }
        return nil
    }
    func invoke(_ extensionID: String, actionID: String, target: JSON = .null, input: JSON = .null, model: AppModel) async throws -> JSON {
        guard enabled.contains(where: { $0["id"].string == extensionID }) else { throw PilotError("This extension is disabled.") }
        if model.demo { return .null }
        let current = model.connectionID
        let before = Dictionary(views.map { (Self.key($0), $0) }, uniquingKeysWith: { _, new in new })
        let result = try await model.relay.call("extensions.action.invoke", params: .object(["extension_id": .string(extensionID), "action_id": .string(actionID), "target": target, "input": input]))
        guard current == model.connectionID else { throw CancellationError() }
        for view in result["updated_views"].array {
            let key = Self.key(view)
            if views.first(where: { Self.key($0) == key }) == before[key] { apply(.object(["type": .string("extension-view-updated"), "view": view])) }
        }
        return result
    }
    func setStage(_ stageID: String?, task: AgentTask, model: AppModel) async throws {
        _ = try await invoke(Self.stagesID, actionID: "manage-tags", target: .object(["kind": .string("thread"), "id": .string(task.id)]), input: .object(["operation": .string("set_thread_stage"), "stageId": stageID.map(JSON.string) ?? .null]), model: model)
        if model.demo {
            let view = JSON.object(["extension_id": .string(Self.stagesID), "view_id": .string("thread-tags"), "scope": .object(["kind": .string("thread"), "id": .string(task.id)]), "value": .object(["tagIds": .array(stageID.map { [.string($0)] } ?? [])]), "updated_at": .string(Date.now.ISO8601Format())])
            apply(.object(["type": .string("extension-view-updated"), "view": view]))
        }
    }
}
