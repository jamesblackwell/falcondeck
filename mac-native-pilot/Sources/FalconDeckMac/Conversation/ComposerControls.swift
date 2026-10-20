import SwiftUI

struct ConversationComposerControls: View {
    @Bindable var store: AppStore
    @Binding var selection: NativeComposerSelection
    let skills: [JSON]
    let prompts: [JSON]
    let loadingCatalog: Bool
    var insert: (String) -> Void
    var attach: () -> Void
    var refreshCatalog: () -> Void
    var chooseAgent: (String) -> Void
    @State private var showOptions = false
    @State private var showModels = false
    @State private var showAgents = false
    @State private var modelSearch = ""
    @AppStorage("native.favoriteModels") private var favorites = ""

    private var provider: String { store.selectedTask?.provider ?? store.provider }
    private var agent: JSON { ConversationCatalog.agent(store.selectedProject, provider: provider) }
    private var models: [JSON] { ConversationCatalog.models(store.selectedProject, provider: provider) }
    private var modelID: String { selection.value("model_id", task: store.selectedTask) }
    private var activeModel: JSON { models.first { $0["id"].string == modelID } ?? models.first { $0["is_default"].bool } ?? .null }
    private var starred: Set<String> { Set(favorites.split(separator: "\n").map(String.init)) }
    private var offeredModels: [JSON] {
        models.filter { modelSearch.isEmpty || $0["label"].string.localizedCaseInsensitiveContains(modelSearch) || $0["id"].string.localizedCaseInsensitiveContains(modelSearch) }
            .sorted { starred.contains($0["id"].string) && !starred.contains($1["id"].string) }
    }

    var body: some View {
        HStack(spacing: 9) {
            Button(action: attach) { Image(systemName: "paperclip") }
                .help("Attach images or text files")
                .accessibilityLabel("Attach files")
            Menu {
                if loadingCatalog { Text("Loading skills and prompts…") }
                if !skills.isEmpty {
                    Section("Skills") {
                        ForEach(skills, id: \.self) { skill in
                            Button(skill["label"].string.isEmpty ? skill["alias"].string : skill["label"].string) {
                                insert(ConversationCatalog.alias(skill["alias"].string) + " ")
                            }
                        }
                    }
                }
                if !prompts.isEmpty {
                    Section("Saved prompts") {
                        ForEach(prompts, id: \.self) { prompt in
                            Button(prompt["label"].string.isEmpty ? prompt["alias"].string : prompt["label"].string) {
                                insert(ConversationSlash.expandPrompt(prompt["body"].string, arguments: ""))
                            }
                        }
                    }
                }
                Divider()
                Button("Refresh skills and prompts", action: refreshCatalog)
            } label: { Image(systemName: "slash.circle") }
            .menuStyle(.borderlessButton).fixedSize().help("Skills and saved prompts")

            Button { showAgents.toggle() } label: {
                HStack(spacing: 4) {
                    Text(FDTheme.providerName(provider)).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 8))
                }
            }.accessibilityIdentifier("agent-picker").help("Choose agent")
                .popover(isPresented: $showAgents, arrowEdge: .bottom) { agentPicker }
            Button { showModels.toggle() } label: {
                HStack(spacing: 4) {
                    Text(modelID.isEmpty ? (activeModel["label"].string.isEmpty ? "Default model" : activeModel["label"].string) : models.first { $0["id"].string == modelID }?["label"].string ?? modelID)
                        .lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 8))
                }
            }.frame(maxWidth: 180).help("Choose model").accessibilityIdentifier("composer-model")
                .popover(isPresented: $showModels, arrowEdge: .bottom) { modelPicker }
            if !ConversationCatalog.efforts(activeModel).isEmpty {
                Picker("Reasoning effort", selection: choice("reasoning_effort")) {
                    Text("Default effort").tag("")
                    ForEach(ConversationCatalog.efforts(activeModel), id: \.self) { Text(ConversationCatalog.label($0)).tag($0) }
                }.labelsHidden().pickerStyle(.menu).fixedSize().help("Reasoning effort")
            }
            Button { showOptions.toggle() } label: { Image(systemName: "slider.horizontal.3") }
                .help("Agent permissions, mode, speed and task location")
                .accessibilityLabel("Task settings")
                .popover(isPresented: $showOptions, arrowEdge: .bottom) { options }
        }
        .buttonStyle(.plain).controlSize(.small)
        .font(NativePreferences.shared.font(size: 12))
        .foregroundStyle(FDTheme.secondary)
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("native.command"))) { note in
            switch note.object as? String {
            case "openModelMenu": showModels = true
            case "openHarnessMenu": showAgents = true
            case "openPermissionMenu", "openSandboxMenu": showOptions = true
            default: break
            }
        }
    }

    private var agentPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(store.selectedTaskID == nil ? "Choose agent" : "Continue with another agent")
                .font(NativePreferences.shared.font(size: 13, weight: .semibold)).padding(.bottom, 4)
            if store.selectedTaskID != nil {
                Text("A new conversation will include the context from this one.")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
                    .fixedSize(horizontal: false, vertical: true).padding(.bottom, 5)
            }
            ForEach(store.availableProviders, id: \.self) { offered in
                Button {
                    showAgents = false
                    if offered != provider { chooseAgent(offered) }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: offered == provider ? "checkmark" : "circle").frame(width: 16)
                        Text(FDTheme.providerName(offered))
                        Spacer()
                    }.font(NativePreferences.shared.font(size: 13)).padding(8).contentShape(.rect)
                }.buttonStyle(.plain)
                    .disabled(store.selectedTaskID != nil && (store.isRunning || offered == provider))
            }
            if store.isRunning {
                Text("Stop the response before switching agents.")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            }
        }.padding(14).frame(width: 285)
    }

    private var modelPicker: some View {
        VStack(spacing: 0) {
            TextField("Search models", text: $modelSearch).textFieldStyle(.roundedBorder).padding(12)
            Divider()
            ScrollView {
                LazyVStack(spacing: 2) {
                    modelRow(.object(["id": .string(""), "label": .string("Provider default")]))
                    ForEach(offeredModels, id: \.self) { modelRow($0) }
                    if models.isEmpty {
                        VStack(spacing: 8) {
                            Text(agent["models_loading"].bool ? "Loading models…" : "Models are not loaded yet.")
                            Button("Load models", action: refreshCatalog)
                        }.padding(16).foregroundStyle(FDTheme.muted)
                    }
                }.padding(8)
            }.frame(maxHeight: 350)
        }.frame(width: 360)
    }

    private func modelRow(_ model: JSON) -> some View {
        HStack {
            Button {
                selection.select("model_id", value: model["id"].string, provider: provider)
                showModels = false
            } label: {
                HStack {
                    Image(systemName: modelID == model["id"].string ? "checkmark" : "circle").frame(width: 14)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model["label"].string.isEmpty ? model["id"].string : model["label"].string)
                        if !model["id"].string.isEmpty { Text(model["id"].string).font(NativePreferences.shared.font(size: 12, surface: "code")).foregroundStyle(FDTheme.muted) }
                    }
                    Spacer()
                }.padding(7).contentShape(.rect)
            }.buttonStyle(.plain)
            if !model["id"].string.isEmpty {
                Button {
                    var values = starred
                    if !values.insert(model["id"].string).inserted { values.remove(model["id"].string) }
                    favorites = values.sorted().joined(separator: "\n")
                } label: { Image(systemName: starred.contains(model["id"].string) ? "star.fill" : "star") }
                    .buttonStyle(.plain).help("Favorite model")
            }
        }
    }

    private var options: some View {
        Form {
            let capabilities = agent["capabilities"]
            let modes = agent["collaboration_modes"].array
            if !modes.isEmpty {
                Picker("Mode", selection: choice("collaboration_mode_id")) {
                    Text("Default").tag("")
                    ForEach(modes, id: \.self) { Text($0["label"].string).tag($0["id"].string) }
                }
            }
            if !capabilities["permission_modes"].array.isEmpty { modePicker("Permissions", key: "permission_mode", values: capabilities["permission_modes"].array.map(\.string)) }
            if !capabilities["sandbox_modes"].array.isEmpty { modePicker("Sandbox", key: "sandbox_mode", values: capabilities["sandbox_modes"].array.map(\.string)) }
            if !activeModel["service_tiers"].array.isEmpty {
                Picker("Speed", selection: choice("service_tier")) {
                    Text("Standard").tag("default")
                    ForEach(activeModel["service_tiers"].array.filter { $0["id"].string != "default" }, id: \.self) {
                        Text($0["name"].string.isEmpty ? $0["id"].string : $0["name"].string).tag($0["id"].string)
                    }
                }
            }
            if store.selectedTaskID == nil && store.selectedProject?.raw["kind"].string != "casual" {
                Picker("Location", selection: $selection.isolation) {
                    Text("Project folder").tag("project_folder")
                    Text("Isolated checkout").tag("isolated")
                }
                Text("An isolated task works on its own branch and checkout.").font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            }
            if capabilities["supports_steering"].bool {
                Picker("While agent is working", selection: $selection.followUp) {
                    Text("Queue follow-up").tag("queue")
                    Text("Steer current turn").tag("steer")
                }
            }
            Button("Reset to provider defaults") { selection.fields = [:] }
        }.formStyle(.grouped).frame(width: 360).fixedSize(horizontal: false, vertical: true)
    }

    private func modePicker(_ title: String, key: String, values: [String]) -> some View {
        Picker(title, selection: choice(key)) {
            Text("Default").tag("")
            ForEach(values, id: \.self) { Text(ConversationCatalog.label($0)).tag($0) }
        }
    }
    private func choice(_ key: String) -> Binding<String> {
        Binding(get: {
            let value = selection.value(key, task: store.selectedTask)
            return key == "service_tier" && value.isEmpty ? "default" : value
        }, set: { selection.select(key, value: $0, provider: provider) })
    }
}
