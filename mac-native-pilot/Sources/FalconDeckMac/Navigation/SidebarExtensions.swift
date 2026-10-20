import SwiftUI

struct NativeSidebarExtensionFilter: Identifiable {
    let extensionID: String
    let contribution: JSON
    let document: JSON
    var id: String { extensionID + ":" + contribution["id"].string }
    var title: String {
        let label = document["root"]["label"].string
        return label.isEmpty ? contribution["title"].string : label
    }
    var options: [JSON] { document["root"]["options"].array }
    var multiple: Bool { document["root"]["multiple"].bool }
    var supported: Bool {
        let binding = document["root"]["binding"], path = binding["path"].array
        return document["version"].int == 1 && document["root"]["type"].string == "select"
            && binding["operator"].string == "includes_any" && !binding["view"].string.isEmpty
            && !path.isEmpty && path.count <= 16
            && path.allSatisfy { !$0.string.isEmpty && !["__proto__", "prototype", "constructor"].contains($0.string) }
            && options.count <= 100
    }
}

struct NativeSidebarExtensionPanel: Identifiable {
    let extensionID: String
    let panelID: String
    let title: String
    let symbol: String
    var id: String { extensionID + ":" + panelID }
}

/// Index the daemon's bounded projections once per extension update. Filtering
/// a large project never scans the full projection list for every task.
struct NativeSidebarExtensions {
    static let stagesID = "falcondeck.thread-tags"
    let enabled: [JSON]
    private let views: [JSON: JSON]

    init(_ snapshot: JSON) {
        enabled = snapshot["catalog"].array.filter { $0["enabled"].bool }
        views = Dictionary(snapshot["views"].array.map { (Self.key($0), $0) }, uniquingKeysWith: { _, latest in latest })
    }

    private static func key(_ view: JSON) -> JSON {
        .array([view["extension_id"], view["view_id"], view["scope"]["kind"], view["scope"]["id"]])
    }

    func view(extensionID: String, viewID: String, taskID: String? = nil) -> JSON {
        views[.array([.string(extensionID), .string(viewID), taskID == nil ? .null : .string("thread"), taskID.map(JSON.string) ?? .null])]?["value"] ?? .null
    }

    var panels: [NativeSidebarExtensionPanel] {
        enabled.flatMap { item in item["contributes"]["panels"].array.map { panel in
            NativeSidebarExtensionPanel(extensionID: item["id"].string, panelID: panel["id"].string,
                title: panel["title"].string.isEmpty ? item["name"].string : panel["title"].string,
                symbol: Self.symbol(panel["icon"].string))
        }}
    }

    var filters: [NativeSidebarExtensionFilter] {
        enabled.flatMap { item in item["contributes"]["sidebarFilters"].array.map { contribution in
            let published = view(extensionID: item["id"].string, viewID: contribution["view"].string)
            var document = published["version"] != .null && published["root"] != .null ? published : contribution["ui"]
            // The bundled Kanban projection publishes custom stages as data;
            // its manifest supplies the binding and default declarative UI.
            if item["id"].string == Self.stagesID, !stages.isEmpty {
                let options = stages.map { stage in JSON.object(["value": stage["id"], "label": stage["label"], "tone": stage["color"]]) }
                document = document.setting("root", document["root"].setting("options", .array(options)))
            }
            return NativeSidebarExtensionFilter(extensionID: item["id"].string, contribution: contribution, document: document)
        }}
    }

    func matches(taskID: String, selections: [String: Set<String>]) -> Bool {
        filters.allSatisfy { filter in
            let selected = selections[filter.id] ?? []
            guard filter.supported, !selected.isEmpty else { return true }
            let binding = filter.document["root"]["binding"]
            let value = binding["path"].array.reduce(view(extensionID: filter.extensionID, viewID: binding["view"].string, taskID: taskID)) { $0[$1.string] }
            return value.array.contains { selected.contains($0.string) }
        }
    }

    var stagesEnabled: Bool { enabled.contains { $0["id"].string == Self.stagesID } }
    var stages: [JSON] {
        guard stagesEnabled else { return [] }
        let values = view(extensionID: Self.stagesID, viewID: "tag-index")["tags"].array.filter { !$0["id"].string.isEmpty && !$0["label"].string.isEmpty }
        let legacy: Set<String> = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"]
        if !values.isEmpty && !(values.count == 8 && Set(values.map { $0["id"].string }) == legacy) { return values }
        return [("backlog", "Backlog", "gray"), ("in_progress", "In progress", "yellow"), ("in_review", "In review", "green"), ("done", "Done", "orange"), ("canceled", "Canceled", "gray")].map {
            .object(["id": .string($0.0), "label": .string($0.1), "color": .string($0.2)])
        }
    }

    func stage(_ task: AgentTask) -> JSON? {
        let ids = view(extensionID: Self.stagesID, viewID: "thread-tags", taskID: task.id)["tagIds"].array
        return stages.first { ids.contains($0["id"]) }
    }

    @MainActor static func tone(_ tone: String) -> Color {
        switch tone {
        case "red": FDTheme.danger
        case "yellow", "orange": FDTheme.warning
        case "green": FDTheme.accent
        case "blue", "purple", "pink": FDTheme.info
        default: FDTheme.muted
        }
    }

    private static func symbol(_ icon: String) -> String {
        switch icon {
        case "kanban": "rectangle.split.3x1"
        case "notebook-pen", "notebook", "sticky-note": "note.text"
        case "calendar", "calendar-days": "calendar"
        case "clock": "clock"
        case "chart-bar", "chart-no-axes-combined": "chart.bar"
        case "list-checks": "checklist"
        case "folder": "folder"
        default: "square.stack.3d.up"
        }
    }
}

struct NativeSidebarStageMenu: View {
    let store: AppStore
    let task: AgentTask
    private var extensions: NativeSidebarExtensions { .init(store.extensionsForHost(NativeHostManager.split(task.id).hostID)) }

    var body: some View {
        if extensions.stagesEnabled {
            Menu("Set stage") {
                Button("No stage", systemImage: extensions.stage(task) == nil ? "checkmark" : "circle") { setStage(nil) }
                Divider()
                ForEach(extensions.stages, id: \.self) { stage in
                    Button(stage["label"].string, systemImage: extensions.stage(task)?["id"] == stage["id"] ? "checkmark.circle.fill" : "circle") {
                        setStage(stage["id"].string)
                    }
                }
                Divider()
                Button("Add stage…", systemImage: "plus") { createStage() }
            }
        }
    }

    private func setStage(_ id: String?) {
        invoke(.object(["operation": .string("set_thread_stage"), "stageId": id.map(JSON.string) ?? .null]))
    }

    private func createStage() {
        guard let name = NativeNavigationDialogs.name(title: "New stage", detail: "Stages are shared across your projects.", action: "Create stage") else { return }
        invoke(.object(["operation": .string("create_stage"), "label": .string(name)]))
    }

    private func invoke(_ input: JSON) {
        NativeTaskActions.perform(store) {
            _ = try await store.request(path: "/api/extensions/\(NativeSidebarExtensions.stagesID)/actions/manage-tags", method: "POST", body: .object([
                "target": .object(["kind": .string("thread"), "id": .string(task.id)]), "input": input
            ]), hostID: NativeHostManager.split(task.id).hostID)
            await store.refresh()
        }
    }
}
