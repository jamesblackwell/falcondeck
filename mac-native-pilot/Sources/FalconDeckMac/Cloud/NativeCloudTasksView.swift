import SwiftUI

/// Cloud jobs keep their own identity. All conversation and file operations go
/// through the owning coordinator's job proxy, never a worker's filesystem path.
struct NativeCloudTasksView: View {
    let store: AppStore
    @State private var model: NativeCloudModel
    @State private var showingSettings = false
    @State private var importJob: NativeCloudJob?
    @State private var exclusionsExpanded = true

    init(store: AppStore) {
        self.store = store
        _model = State(initialValue: NativeCloudModel.forHost(store.selectedHostID))
    }

    private var projects: [Project] { store.allProjects.filter { $0.raw["kind"].string != "casual" } }
    private var selectedJob: NativeCloudJob? { model.jobs.first { $0.id == model.selectedJobID } }
    private var connected: Bool {
        guard let hostID = model.hostID else { return store.isConnected }
        return NativeHostManager.shared.hosts.first { $0.id == hostID }?.status == .connected
    }
    private var coordinatorName: String {
        guard let hostID = model.hostID else { return "This Mac" }
        return NativeHostManager.shared.hosts.first { $0.id == hostID }?.name ?? "Paired server"
    }
    private var request: NativeCloudRequest {
        let hostID = model.hostID
        return { path, method, body in
            let raw = try await store.request(path, method: method, body: body, hostID: hostID)
            return NativeCloudScope.response(raw, hostID: hostID, path: path)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Label("Cloud tasks", systemImage: "cloud").font(NativePreferences.shared.font(size: 18, weight: .semibold))
                Spacer()
                Button { showingSettings = true } label: { Label("Cloud settings", systemImage: "gearshape") }
                Button { Task { await model.refresh(request: request) } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Refresh cloud tasks").accessibilityLabel("Refresh cloud tasks").disabled(model.loading)
                Button("New cloud task", systemImage: "plus") { model.selectedJobID = nil }
                    .buttonStyle(.borderedProminent).tint(FDTheme.accent)
            }.padding(.horizontal, 20).padding(.vertical, 14)
            Divider()
            if let error = model.error {
                HStack { Label(error, systemImage: "exclamationmark.triangle").textSelection(.enabled); Spacer() }
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.warning).padding(12)
                Divider()
            }
            HSplitView {
                jobList.frame(minWidth: 200, idealWidth: 245, maxWidth: 330)
                Group {
                    if let selectedJob { jobDetail(selectedJob) }
                    else { newTask }
                }.frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(FDTheme.surface)
        .task(id: "\(connected):\(model.hostID ?? "local")") {
            if model.selectedProjectID.isEmpty {
                model.selectedProjectID = projects.first(where: { $0.id == store.selectedProjectID })?.id
                    ?? projects.first(where: { NativeHostManager.split($0.id).hostID == model.hostID })?.id ?? ""
            }
            await model.refresh(request: request)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(4)) } catch { return }
                guard !model.busy else { continue }
                if let id = model.selectedJobID { await model.refreshDetail(jobID: id, request: request) }
                else { await model.refresh(request: request) }
            }
        }
        .task(id: "\(model.hostID ?? "local"):\(model.selectedJobID ?? "")") {
            if let id = model.selectedJobID { await model.refreshDetail(jobID: id, request: request) }
        }
        .sheet(isPresented: $showingSettings) {
            VStack(spacing: 0) {
                HStack { Text("Cloud execution").font(.headline); Spacer(); Button("Done") { showingSettings = false } }.padding(16)
                Divider()
                NativeCloudSettingsView(store: store, hostID: model.hostID)
            }.frame(width: 640, height: 720)
        }
        .onChange(of: showingSettings) { _, visible in if !visible { Task { await model.refresh(request: request) } } }
        .confirmationDialog("Import collected changes into the source project?", isPresented: Binding(get: { importJob != nil }, set: { if !$0 { importJob = nil } }), titleVisibility: .visible) {
            Button("Import changes") {
                if let job = importJob { Task { await model.operate(jobID: job.id, action: "import", request: request) } }
                importJob = nil
            }
            Button("Cancel", role: .cancel) { importJob = nil }
        } message: { Text("The daemon checks the source against the captured working state and refuses conflicts. Review the changed and deleted paths before importing.") }
    }

    private var jobList: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                if model.jobs.isEmpty {
                    Text(model.loading ? "Loading cloud tasks…" : "No cloud tasks yet")
                        .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted).padding(20)
                }
                ForEach(model.jobs) { job in
                    Button { model.selectedJobID = job.id } label: {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(job.title).lineLimit(2).foregroundStyle(FDTheme.foreground)
                            HStack(spacing: 6) {
                                Circle().fill(statusColor(job)).frame(width: 5, height: 5)
                                Text(job.statusLabel).font(NativePreferences.shared.font(size: 11)).foregroundStyle(FDTheme.muted)
                            }
                        }.font(NativePreferences.shared.font(size: 12, weight: .medium))
                            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                            .background(model.selectedJobID == job.id ? FDTheme.hover : Color.clear, in: .rect(cornerRadius: 8))
                            .contentShape(.rect)
                    }.buttonStyle(.plain)
                }
            }.padding(8)
        }.background(FDTheme.background)
    }

    private var draft: NativeCloudTaskDraft { model.drafts[model.selectedProjectID] ?? NativeCloudTaskDraft() }
    private func editDraft(_ update: (inout NativeCloudTaskDraft) -> Void) {
        var value = model.drafts[model.selectedProjectID] ?? NativeCloudTaskDraft()
        update(&value); model.drafts[model.selectedProjectID] = value
    }

    private var newTask: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Run a Codex task in an isolated Linux worker.")
                    .font(NativePreferences.shared.font(size: 16, weight: .medium))
                Text("Capture the project's current working files, including safe modified and untracked files. The project's own daemon coordinates the worker. A started worker runs independently until stopped or its time limit expires.")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
                if projects.isEmpty {
                    Label("Open a project to create a cloud task.", systemImage: "folder")
                } else {
                    Picker("Source project", selection: Binding(get: { model.selectedProjectID }, set: selectSource)) {
                        ForEach(projects) { project in
                            Text(project.name + (NativeHostManager.split(project.id).hostID == nil ? " · This Mac" : " · Paired server")).tag(project.id)
                        }
                    }.disabled(model.busy || draft.submittedPayload != nil)
                    Text("Coordinator: \(coordinatorName)")
                        .font(.caption).foregroundStyle(FDTheme.muted)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Task instructions").font(NativePreferences.shared.font(size: 12, weight: .medium))
                        TextEditor(text: Binding(get: { draft.prompt }, set: { text in editDraft { $0.prompt = text } }))
                            .font(NativePreferences.shared.font(size: 14, surface: "chat"))
                            .frame(minHeight: 120).padding(6).background(FDTheme.background, in: .rect(cornerRadius: 8))
                            .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(FDTheme.hairline) }
                            .disabled(model.busy || draft.submittedPayload != nil)
                        TextField("Model ID (optional; Codex default when empty)", text: Binding(get: { draft.modelID }, set: { text in editDraft { $0.modelID = text } }))
                            .textFieldStyle(.roundedBorder).disabled(model.busy || draft.submittedPayload != nil)
                        Text("Codex is supported in this version. Local CLI sign-in, Claude and custom ACP agents are not transferred to the worker.")
                            .font(NativePreferences.shared.font(size: 11)).foregroundStyle(FDTheme.muted)
                    }
                    HStack {
                        Button(draft.source == .null ? "Review source capture" : "Capture current files again", systemImage: "doc.viewfinder") {
                            Task { await model.capture(workspaceID: model.selectedProjectID, request: request) }
                        }.disabled(model.busy || draft.submittedPayload != nil)
                        if model.busy { ProgressView().controlSize(.small) }
                    }
                    if draft.source != .null { sourcePreview(draft.source) }
                    if let issue = NativeCloudSettingsDraft.validationError(settings: model.settings) {
                        HStack(alignment: .top) {
                            Label(issue, systemImage: "gearshape").font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.warning)
                            Spacer()
                            Button("Set up Cloud") { showingSettings = true }
                        }
                    }
                    if draft.submittedPayload != nil {
                        Text("A launch was submitted. Retry sends the same saved request and launch key. Refresh tasks to check whether the worker was created.")
                            .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.warning)
                    }
                    Button(draft.submittedPayload == nil ? "Start cloud task" : "Retry cloud launch", systemImage: "cloud") {
                        Task { await model.create(workspaceID: model.selectedProjectID, settings: model.settings, request: request) }
                    }.buttonStyle(.borderedProminent).tint(FDTheme.accent)
                        .disabled(model.busy || !connected || draft.source == .null || draft.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || NativeCloudSettingsDraft.validationError(settings: model.settings) != nil)
                }
            }.padding(24).frame(maxWidth: 780, alignment: .leading).frame(maxWidth: .infinity)
        }
    }

    private func selectSource(_ id: String) {
        model = NativeCloudModel.forHost(NativeHostManager.split(id).hostID)
        model.selectedProjectID = id
        model.selectedJobID = nil
    }

    private func sourcePreview(_ source: JSON) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Source captured", systemImage: "checkmark.shield").font(NativePreferences.shared.font(size: 13, weight: .medium))
            Text("\(source["included_paths"].array.count) files · \(ByteCountFormatter.string(fromByteCount: Int64(source["total_bytes"].optionalInt ?? 0), countStyle: .file)) · \(source["excluded_paths"].array.count) excluded")
                .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            Text(source["tree_hash"].string).font(NativePreferences.shared.font(size: 10, surface: "code")).foregroundStyle(FDTheme.muted).textSelection(.enabled)
            DisclosureGroup("Excluded paths (not uploaded)", isExpanded: $exclusionsExpanded) { paths(source["excluded_paths"].array) }
            DisclosureGroup("Included paths") { paths(source["included_paths"].array) }
            Text("This launch uses this exact captured tree. Capture again to include later edits.")
                .font(NativePreferences.shared.font(size: 11)).foregroundStyle(FDTheme.muted)
        }.padding(16).background(FDTheme.background, in: .rect(cornerRadius: 10))
    }

    private func jobDetail(_ job: NativeCloudJob) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(job.title).font(NativePreferences.shared.font(size: 15, weight: .semibold)).lineLimit(2)
                    Label(job.statusLabel, systemImage: "cloud").font(NativePreferences.shared.font(size: 12)).foregroundStyle(statusColor(job))
                    if !job.raw["expires_at"].string.isEmpty { Text("Worker expires \(job.raw["expires_at"].string)").font(.caption).foregroundStyle(FDTheme.muted) }
                }
                Spacer()
                if job.status == "stopped" {
                    Button("Resume worker", systemImage: "play") {
                        Task { await model.operate(jobID: job.id, action: "resume", request: request) }
                    }.help("Resume the retained worker snapshot and its original native task")
                }
                if job.hasWorker && !job.stopped {
                    if job.status == "running" { Button("Interrupt turn") { Task { await model.operate(jobID: job.id, action: "interrupt", request: request) } } }
                    Menu("Worker actions") {
                        Button("Collect results") { Task { await model.operate(jobID: job.id, action: "collect", request: request) } }
                            .disabled(!["completed", "failed"].contains(job.status))
                        Button("Collect results and stop") {
                            Task {
                                await model.operate(jobID: job.id, action: "collect", request: request)
                                if model.error == nil { await model.operate(jobID: job.id, action: "stop", request: request) }
                            }
                        }
                        .disabled(!["completed", "failed"].contains(job.status))
                        Divider()
                        Button("Stop worker", role: .destructive) { Task { await model.operate(jobID: job.id, action: "stop", request: request) } }
                    }
                }
            }.padding(16).disabled(model.busy)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if !job.raw["error"].string.isEmpty { Label(job.raw["error"].string, systemImage: "exclamationmark.triangle").foregroundStyle(FDTheme.warning).textSelection(.enabled) }
                    if job.status == "stopped" {
                        Text("A private worker snapshot is retained for up to 24 hours so this task can resume.")
                            .font(.caption).foregroundStyle(FDTheme.muted)
                    }
                    if let error = model.detailError { Text(error).font(.caption).foregroundStyle(FDTheme.warning) }
                    if job.working && model.details[job.id] == nil { ProgressView(job.statusLabel).controlSize(.small) }
                    if job.raw["result"] != .null { resultView(job) }
                    let detail = model.details[job.id] ?? .null
                    if detail["is_live"] == .bool(false) {
                        Label("Collected transcript · \(detail["collected_at"].string)", systemImage: "archivebox")
                            .font(.caption).foregroundStyle(FDTheme.muted)
                    }
                    ForEach(detail["items"].array.map(Message.init)) { item in
                        ConversationTranscriptRow(message: item, provider: "codex", preferences: store.preferences)
                    }
                    ForEach(detail["interactive_requests"].array, id: \.self) { item in
                        NativeInteractiveRequestCard(request: item, preferences: store.preferences, connected: connected && !job.stopped) { response in
                            try await model.respond(jobID: job.id, interactive: item, response: response, request: request)
                        }
                    }
                    if !job.hasWorker && !job.working { Text("No worker conversation is available.").font(.caption).foregroundStyle(FDTheme.muted) }
                }.padding(24).frame(maxWidth: 880).frame(maxWidth: .infinity, alignment: .leading)
            }
            if job.hasWorker && !job.stopped {
                Divider()
                HStack(alignment: .bottom, spacing: 12) {
                    TextField("Reply to cloud task", text: Binding(get: { model.followUps[job.id, default: ""] }, set: { model.followUps[job.id] = $0 }), axis: .vertical)
                        .textFieldStyle(.roundedBorder).lineLimit(2...6)
                    Button("Send", systemImage: "arrow.up") { Task { await model.sendFollowUp(jobID: job.id, request: request) } }
                        .buttonStyle(.borderedProminent).tint(FDTheme.accent)
                        .disabled(model.busy || model.followUps[job.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !connected)
                }.padding(16)
            }
        }
    }

    private func resultView(_ job: NativeCloudJob) -> some View {
        let result = job.raw["result"]
        return VStack(alignment: .leading, spacing: 10) {
            Label(result["imported_at"] == .null ? "Results collected" : "Results imported", systemImage: "tray.and.arrow.down")
                .font(NativePreferences.shared.font(size: 13, weight: .medium))
            Text("\(result["changed_paths"].array.count) changed · \(result["deleted_paths"].array.count) deleted · \(result["native_session_count"].int) native session files")
                .font(.caption).foregroundStyle(FDTheme.muted)
            DisclosureGroup("Changed paths") { paths(result["changed_paths"].array) }
            if !result["deleted_paths"].array.isEmpty { DisclosureGroup("Deleted paths") { paths(result["deleted_paths"].array) } }
            if result["imported_at"] == .null {
                Button("Import collected changes…") { importJob = job }.disabled(model.busy)
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(FDTheme.background, in: .rect(cornerRadius: 10))
    }

    private func paths(_ values: [JSON]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                if values.isEmpty { Text("None") }
                ForEach(values, id: \.self) { Text($0.string).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            }.font(NativePreferences.shared.font(size: 11, surface: "code")).padding(.top, 6)
        }.frame(maxHeight: 160)
    }

    private func statusColor(_ job: NativeCloudJob) -> Color {
        if ["failed", "unknown", "awaiting_input"].contains(job.status) { return FDTheme.warning }
        return job.working ? FDTheme.accent : FDTheme.muted
    }
}
