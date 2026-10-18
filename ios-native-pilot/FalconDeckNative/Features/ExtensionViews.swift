import SwiftUI

@MainActor enum ExtensionTone {
    static func color(_ tone: String) -> Color {
        switch tone {
        case "red", "danger": .red
        case "orange", "warning": .orange
        case "yellow": .yellow
        case "green", "success": .green
        case "blue", "info": .blue
        case "purple": .purple
        case "pink": .pink
        case "accent": FD.accent
        default: FD.secondary
        }
    }
}

struct TaskStageMark: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    var body: some View {
        if let stage = model.extensions.stage(task) {
            Image(systemName: ["done": "checkmark.circle.fill", "canceled": "xmark.circle", "in_progress": "circle.lefthalf.filled", "in_review": "circle.dotted" ][stage["id"].string] ?? "circle")
                .foregroundStyle(ExtensionTone.color(stage["color"].string)).accessibilityLabel(stage["label"].string)
        }
    }
}

struct TaskStageMenu: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    var body: some View {
        if !model.extensions.stages.isEmpty {
            Menu("Set stage", systemImage: "circle.lefthalf.filled") {
                ForEach(model.extensions.stages, id: \.self) { stage in
                    Button(stage["label"].string) { set(stage["id"].string) }
                }
                Button("Clear stage") { set(nil) }
            }.disabled(!model.demo && !model.connected)
        }
    }
    private func set(_ id: String?) { Task { do { try await model.extensions.setStage(id, task: task, model: model) } catch { model.error = error.localizedDescription } } }
}

struct ExtensionFiltersView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                ForEach(model.extensions.filters) { filter in
                    Section(filter.title) {
                        if filter.supported {
                            ForEach(filter.document["root"]["options"].array, id: \.self) { option in
                                Toggle(isOn: Binding(get: { model.extensions.selections[filter.id]?.contains(option["value"].string) == true }, set: { enabled in
                                    var selected = model.extensions.selections[filter.id] ?? []
                                    if enabled { if !filter.document["root"]["multiple"].bool { selected = [] }; selected.insert(option["value"].string) } else { selected.remove(option["value"].string) }
                                    model.extensions.selections[filter.id] = selected
                                })) { Label(option["label"].string, systemImage: "circle.fill").foregroundStyle(ExtensionTone.color(option["tone"].string)) }
                            }
                        } else { Text("This filter needs a newer client or the desktop app.").font(.footnote).foregroundStyle(FD.secondary) }
                    }.listRowBackground(FD.surface)
                }
            }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Filter tasks")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Clear all") { model.extensions.selections = [:] } }
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }
    }
}

struct ComposerSuggestionsView: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    var body: some View {
        if let offer = model.extensions.suggestions(task), let primary = offer.actions.first {
            HStack(spacing: 12) {
                Button(primary["label"].string, systemImage: "sparkles") { submit(primary) }.lineLimit(1)
                if offer.actions.count > 1 {
                    Menu { ForEach(offer.actions, id: \.self) { action in Button(action["label"].string) { submit(action) } } } label: { Image(systemName: "chevron.down") }.accessibilityLabel("More suggested actions")
                }
                Spacer(minLength: 0)
                Button { model.extensions.dismissed[task.id] = offer.key } label: { Image(systemName: "xmark") }.accessibilityLabel("Dismiss suggestions")
            }.font(.caption).foregroundStyle(FD.secondary).padding(.horizontal, 14).padding(.vertical, 9).background(FD.surface, in: Capsule())
                .disabled(model.chat(for: task).sending || (!model.demo && !model.connected))
        }
    }
    private func submit(_ action: JSON) { Task { await model.send(task, textOverride: action["prompt"].string) } }
}

struct ExtensionPanelsView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        List {
            ForEach(model.extensions.enabled, id: \.self) { extensionItem in
                Section(extensionItem["name"].string) {
                    ForEach(extensionItem["contributes"]["panels"].array, id: \.self) { contribution in
                        NavigationLink(contribution["title"].string.nonempty ?? extensionItem["name"].string, value: DetailDestination.extensionPanel(extensionID: extensionItem["id"].string, contribution: contribution))
                    }
                    if extensionItem["contributes"]["panels"].array.isEmpty { Text("Connected extension").font(.footnote).foregroundStyle(FD.secondary) }
                }.listRowBackground(FD.surface)
            }
            if let error = model.extensions.error { Text(error).foregroundStyle(.orange); Button("Retry") { Task { await model.extensions.load(model: model, force: true) } } }
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Extensions")
            .overlay { if model.extensions.enabled.isEmpty && model.extensions.error == nil { ContentUnavailableView("No active extensions", systemImage: "puzzlepiece.extension").allowsHitTesting(false) } }
            .task { await model.extensions.load(model: model) }
    }
}

struct ExtensionPanelView: View {
    @Environment(AppModel.self) private var model
    let extensionID: String
    let contribution: JSON
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        let document = model.extensions.document(extensionID: extensionID, contribution: contribution)
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if document["version"].int == 1, ExtensionDocument.valid(document["root"]) { node(document["root"]) }
                else { ContentUnavailableView("Open this panel on desktop", systemImage: "macwindow", description: Text("This extension has not published a supported mobile panel.")) }
                if let error { Text(error).font(.footnote).foregroundStyle(.orange) }
            }.padding(20).frame(maxWidth: 720).frame(maxWidth: .infinity)
        }.background(FD.background).navigationTitle(contribution["title"].string).disabled(busy)
    }
    private func node(_ value: JSON) -> AnyView {
        switch value["type"].string {
        case "stack", "list": return AnyView(VStack(alignment: .leading, spacing: 12) { ForEach(Array((value[value["type"].string == "list" ? "items" : "children"].array).enumerated()), id: \.offset) { node($0.element) } })
        case "row": return AnyView(ViewThatFits(in: .horizontal) { HStack(spacing: 12) { ForEach(Array(value["children"].array.enumerated()), id: \.offset) { node($0.element) } }; VStack(alignment: .leading, spacing: 12) { ForEach(Array(value["children"].array.enumerated()), id: \.offset) { node($0.element) } } })
        case "text": return AnyView(Text(value["text"].string).font(value["style"].string == "heading" ? .headline : .body).foregroundStyle(ExtensionTone.color(value["tone"].string)).textSelection(.enabled))
        case "badge": return AnyView(Text(value["text"].string).font(.caption).padding(7).background(ExtensionTone.color(value["tone"].string).opacity(0.12), in: Capsule()))
        case "divider": return AnyView(Divider())
        case "state": return AnyView(VStack(alignment: .leading) { Text(value["title"].string).font(.headline); Text(value["description"].string).foregroundStyle(FD.secondary) })
        case "button": return AnyView(Button(value["label"].string) {
            busy = true
            Task { defer { busy = false }; do { _ = try await model.extensions.invoke(extensionID, actionID: value["action"]["actionId"].string, target: value["action"]["target"], input: value["action"]["input"], model: model) } catch { self.error = error.localizedDescription } }
        }.buttonStyle(.glass).disabled(value["disabled"].bool || !model.connected))
        default: return AnyView(Text("This control is available on desktop.").font(.footnote).foregroundStyle(FD.secondary))
        }
    }
}

enum ExtensionDocument {
    static func valid(_ root: JSON) -> Bool {
        var count = 0
        func visit(_ value: JSON, depth: Int) -> Bool {
            count += 1
            guard count <= 200, depth <= 12 else { return false }
            let kind = value["type"].string
            guard ["stack", "row", "text", "badge", "divider", "button", "list", "state"].contains(kind) else { return false }
            for key in ["text", "title", "description", "label"] { if value[key].string.count > 8_000 { return false } }
            if kind == "button", value["action"]["actionId"].string.isEmpty { return false }
            return value[kind == "list" ? "items" : "children"].array.allSatisfy { visit($0, depth: depth + 1) }
        }
        return visit(root, depth: 1)
    }
}
