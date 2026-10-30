import SwiftUI

struct NativeCloudSettingsView: View {
    let store: AppStore
    var hostID: String? = nil
    @State private var settings: JSON = .null
    @State private var draft = NativeCloudSettingsDraft()
    @State private var loadedCoordinatorID: String?
    @State private var requestGeneration = UUID()
    @State private var loading = false
    @State private var saving = false
    @State private var error: String?
    @State private var saved = false

    private var coordinatorID: String { hostID ?? "local" }
    private var loaded: Bool { loadedCoordinatorID == coordinatorID }

    var body: some View {
        Form {
            Section {
                Toggle("Enable Cloud execution", isOn: $draft.enabled)
                Text("Cloud tasks run Codex in a Vercel Linux sandbox from a reviewed copy of your project's current files. Other agents and macOS tools are not supported in this runtime.")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
                Text("A started worker runs independently of this Mac until it stops or reaches its time limit. Launching and collecting results require the coordinator daemon to be available.")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            } header: { Text("Execution") }
                .disabled(!loaded || saving)

            Section {
                credentialStatus("Vercel access token", configured: settings["has_provider_token"].bool)
                SecureField("New Vercel access token", text: $draft.providerToken)
                    .textContentType(.password).privacySensitive()
                    .disabled(draft.clearProviderToken)
                    .accessibilityIdentifier("cloud-provider-token")
                Toggle("Remove saved Vercel token", isOn: $draft.clearProviderToken)
                Divider()
                credentialStatus("OpenAI API key", configured: settings["has_openai_api_key"].bool)
                SecureField("New OpenAI API key", text: $draft.openaiAPIKey)
                    .textContentType(.password).privacySensitive()
                    .disabled(draft.clearOpenaiAPIKey)
                    .accessibilityIdentifier("cloud-openai-api-key")
                Toggle("Remove saved OpenAI key", isOn: $draft.clearOpenaiAPIKey)
                Text("Saved credentials are write-only. Leave replacement fields empty to keep them. The coordinator returns only whether each credential is configured.")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            } header: { Text("Credentials") }
                .disabled(!loaded || saving)

            Section {
                TextField("Vercel team ID", text: $draft.teamID)
                TextField("Vercel project ID", text: $draft.projectID)
                TextField("Digest-pinned Linux image", text: $draft.image)
                Text("Use an image reference ending in @sha256: followed by its 64-character digest.")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
                LabeledContent("Worker resources", value: "2 vCPUs · provider-managed memory")
                Stepper("Worker time limit: \(draft.timeoutMinutes) minutes", value: $draft.timeoutMinutes, in: 1...1440)
                Text("The time limit bounds worker lifetime and provider charges. Stop a worker when its results have been saved. Model/API spending limits are managed with your providers.")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            } header: { Text("Vercel sandbox") }
                .disabled(!loaded || saving)

            Section {
                TextField("Linux worker binary HTTPS URL (optional)", text: $draft.workerDaemonURL)
                    .accessibilityIdentifier("cloud-worker-binary-url")
                TextField("Linux worker binary SHA-256 (optional)", text: $draft.workerDaemonSHA256)
                    .font(NativePreferences.shared.font(size: 12, surface: "code"))
                Text("Leave both download fields empty when the pinned image includes falcondeck-daemon. Otherwise provide a Linux binary URL and its SHA-256; the coordinator verifies the checksum before starting it.")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
                TextField("Node executable on coordinator", text: $draft.nodeBinary)
                TextField("Cloud runtime adapter path on coordinator", text: $draft.runtimePath)
                Text("The runtime adapter uses the Vercel Sandbox SDK. These paths belong to the coordinator that launches the job.")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            } header: { Text("Worker runtime") }
                .disabled(!loaded || saving)

            Section {
                Text("Allowed outbound domains (one per line)")
                TextEditor(text: $draft.allowedDomains)
                    .font(NativePreferences.shared.font(size: 12, surface: "code"))
                    .frame(minHeight: 80, maxHeight: 120)
                    .accessibilityLabel("Allowed outbound domains")
                Text("Only listed domains can be reached by the sandbox. Include the Codex model endpoint and any package or source hosts required by the task.")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            } header: { Text("Network access") }
                .disabled(!loaded || saving)

            Section {
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(FDTheme.danger).textSelection(.enabled)
                } else if saved {
                    Label("Cloud execution settings saved", systemImage: "checkmark.circle")
                        .foregroundStyle(FDTheme.accent)
                }
                if loaded, let issue = NativeCloudSettingsDraft.validationError(settings: settings) {
                    Text(issue).font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
                }
                HStack {
                    Button("Save settings") { Task { await save() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!loaded || loading || saving)
                        .accessibilityIdentifier("cloud-settings-save")
                    Button(loaded ? "Refresh status" : "Retry") { Task { await refresh() } }
                        .disabled(loading || saving)
                    if loading || saving { ProgressView().controlSize(.small) }
                }
                if loaded {
                    Text("Refreshing status keeps your unsaved entries.")
                        .font(NativePreferences.shared.font(size: 11)).foregroundStyle(FDTheme.muted)
                }
            }
        }
        .formStyle(.grouped)
        .font(NativePreferences.shared.font(size: 13))
        .task(id: coordinatorID) {
            if !loaded {
                requestGeneration = UUID()
                loading = false; saving = false; settings = .null; saved = false
            }
            await refresh()
        }
    }

    private func credentialStatus(_ title: String, configured: Bool) -> some View {
        HStack {
            Text(title)
            Spacer()
            Label(loaded ? (configured ? "Configured" : "Not configured") : "Loading", systemImage: configured ? "checkmark.circle" : "key")
                .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
        }
    }

    @MainActor private func refresh() async {
        guard !loading, !saving else { return }
        let generation = UUID(), coordinator = coordinatorID
        requestGeneration = generation
        loading = true; error = nil
        defer { if requestGeneration == generation { loading = false } }
        do {
            let result = try await store.request(["api", "cloud", "settings"], hostID: hostID)
            guard requestGeneration == generation else { return }
            settings = result
            if loadedCoordinatorID != coordinator {
                draft = NativeCloudSettingsDraft(result)
                loadedCoordinatorID = coordinator
            }
        } catch {
            if requestGeneration == generation { self.error = error.localizedDescription }
        }
    }

    @MainActor private func save() async {
        guard loaded, !loading, !saving else { return }
        let generation = UUID()
        requestGeneration = generation
        let payload = draft.payload
        saving = true; error = nil; saved = false
        defer { if requestGeneration == generation { saving = false } }
        do {
            let result = try await store.request(["api", "cloud", "settings"], method: "PUT", body: payload, hostID: hostID)
            guard requestGeneration == generation else { return }
            settings = result
            draft = NativeCloudSettingsDraft(result)
            saved = true
        } catch {
            if requestGeneration == generation { self.error = error.localizedDescription }
        }
    }
}
