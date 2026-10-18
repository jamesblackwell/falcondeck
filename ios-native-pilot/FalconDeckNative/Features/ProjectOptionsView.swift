import SwiftUI

struct ProjectOptionsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let project: Project
    @State private var mode = "auto"
    @State private var domain = ""
    @State private var hidden = false
    @State private var pending = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Project icon") {
                    Picker("Icon", selection: $mode) { Text("Automatic").tag("auto"); Text("Folder").tag("folder"); Text("Website").tag("domain") }
                    if mode == "domain" { TextField("example.com", text: $domain).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL) }
                }.listRowBackground(FD.surface)
                Section { Toggle("Hide project", isOn: $hidden) } footer: { Text("Hidden projects remain available from Show hidden projects in the sidebar.") }.listRowBackground(FD.surface)
                Section { Text(project.path).font(.footnote.monospaced()).textSelection(.enabled) }.listRowBackground(FD.surface)
                if let error { Text(error).foregroundStyle(.orange) }
            }.scrollContentBackground(.hidden).background(FD.background).navigationTitle(project.name).navigationBarTitleDisplayMode(.inline).disabled(pending)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) }
                    ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(pending || (!model.demo && !model.connected)) }
                }
                .onAppear { let icon = model.preferences["workspace_icons"][project.id]; mode = icon["mode"].string.nonempty ?? "auto"; domain = icon["domain"].string; hidden = model.preferences["hidden_workspace_ids"].array.contains(.string(project.id)) }
        }.interactiveDismissDisabled(pending)
    }
    private func save() {
        var preference = JSON.object(["mode": .string(mode)])
        if mode == "domain" {
            guard let domain = ProjectDomain.normalize(domain) else { error = "Enter a valid website, such as example.com."; return }
            preference = preference.setting("domain", .string(domain))
        }
        var icons = model.preferences["workspace_icons"]
        if icons == .null { icons = .object([:]) }
        icons = icons.setting(project.id, preference)
        var ids = model.preferences["hidden_workspace_ids"].array.filter { $0 != .string(project.id) }
        if hidden { ids.append(.string(project.id)) }
        pending = true; error = nil
        Task {
            defer { pending = false }
            do { try await model.updatePreferences(.object(["workspace_icons": icons, "hidden_workspace_ids": .array(ids)])); dismiss() }
            catch { self.error = error.localizedDescription }
        }
    }
}

enum ProjectDomain {
    static func normalize(_ value: String) -> String? {
        let source = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let url = URL(string: source.contains("://") ? source : "https://" + source)
        guard let raw = url?.host?.lowercased(), !raw.hasPrefix(".") else { return nil }
        let host = raw.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard !host.contains(".."), host.contains("."), host.utf8.count <= 253, host.range(of: #"^[a-z0-9.-]+$"#, options: .regularExpression) != nil else { return nil }
        return host
    }
}

struct ProjectOrderView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var projects: [Project] = []
    @State private var saving = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.orange) }
                ForEach(projects) { project in Text(project.name) }.onMove { projects.move(fromOffsets: $0, toOffset: $1) }
            }.environment(\.editMode, .constant(.active)).navigationTitle("Project order")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            saving = true
                            Task {
                                defer { saving = false }
                                let ids = projects.map(\.id) + model.sortedProjects.filter { new in !projects.contains { $0.id == new.id } }.map(\.id)
                                do { try await model.updatePreferences(.object(["workspace_order": .array(ids.map(JSON.string))])); dismiss() }
                                catch { self.error = error.localizedDescription }
                            }
                        }.disabled(saving || (!model.demo && !model.connected))
                    }
                }.onAppear { projects = model.sortedProjects }
        }.interactiveDismissDisabled(saving)
    }
}

struct WorkspaceGlyph: View {
    @Environment(AppModel.self) private var model
    let project: Project
    var size: CGFloat = 18
    @State private var image: UIImage?
    var body: some View {
        Group {
            if model.preferences["workspace_icons"][project.id]["mode"].string == "folder" { Image(systemName: "folder") }
            else if let image { Image(uiImage: image).resizable().scaledToFit().frame(width: size, height: size).clipShape(.rect(cornerRadius: 5)) }
            else { ProjectIcon(name: project.name, size: size) }
        }.accessibilityHidden(true)
        .task(id: WorkspaceIconTrigger(connectionID: model.connectionID, projectID: project.id, icon: project.raw["icon"], preference: model.preferences["workspace_icons"][project.id], connected: model.connected)) {
            image = model.workspaceIcons.cached(project)
            guard model.connected, project.raw["icon"]["kind"].string == "image", model.preferences["workspace_icons"][project.id]["mode"].string != "folder" else { return }
            let current = model.connectionID
            do {
                let loaded = try await model.workspaceIcons.load(project, connectionID: current, relay: model.relay)
                guard current == model.connectionID, !Task.isCancelled else { return }
                image = loaded
            } catch { /* Automatic icon remains visible while offline. */ }
        }
    }
}

private struct WorkspaceIconTrigger: Hashable {
    let connectionID: UUID
    let projectID: String
    let icon: JSON
    let preference: JSON
    let connected: Bool
}
