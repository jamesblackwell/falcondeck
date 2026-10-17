import SwiftUI

struct SpeechSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var modal = false
    @AppStorage("native.speech.provider") private var provider = NativeSpeechSettings.defaultProvider
    @AppStorage("native.speech.model") private var transcriptionModel = NativeSpeechSettings.defaultModel
    @AppStorage("native.speech.language") private var language = ""
    @AppStorage("native.readAloud.provider") private var readAloud = "on-device"
    @State private var desktopStatus = "Not checked"
    @State private var models: [JSON] = []
    @State private var recovered = ""
    @State private var error: String?
    @State private var loading = false
    @State private var inserting = false
    var body: some View {
        Form {
            Section {
                Picker("Transcription", selection: $provider) { Text("On-device").tag("on-device"); Text("OpenRouter on computer").tag("openrouter") }
                TextField("Language (automatic)", text: $language).textInputAutocapitalization(.never).autocorrectionDisabled()
            } footer: { Text("On-device recognition keeps audio on this device. OpenRouter sends it encrypted to your paired computer, which holds the API key.") }.listRowBackground(FD.surface)
            if provider == "openrouter" {
                Section("OpenRouter") {
                    LabeledContent("Computer", value: desktopStatus)
                    if models.isEmpty { TextField("Transcription model", text: $transcriptionModel).textInputAutocapitalization(.never).autocorrectionDisabled() }
                    else {
                        Picker("Model", selection: $transcriptionModel) {
                            if !models.contains(where: { $0["id"].string == transcriptionModel }) { Text(transcriptionModel).tag(transcriptionModel) }
                            ForEach(models, id: \.self) { Text($0["name"].string.nonempty ?? $0["id"].string).tag($0["id"].string) }
                        }
                    }
                    Button(loading ? "Checking…" : "Refresh speech models") { Task { await refresh() } }.disabled(loading || !model.connected)
                }.listRowBackground(FD.surface)
            }
            Section("Read aloud") {
                Picker("Voice", selection: $readAloud) { Text("System voice").tag("on-device"); Text("Computer voice").tag("desktop") }
                if model.readAloud.messageID != nil {
                    Button(model.readAloud.paused ? "Resume read aloud" : "Pause read aloud") { model.readAloud.togglePause() }
                    Button("Stop read aloud") { model.readAloud.stop() }
                }
            }.listRowBackground(FD.surface)
            if model.voice.pendingURL != nil {
                Section {
                    Text(model.voice.recording ? "A recording is in progress." : "Your saved recording can be recovered here, even if its original task is no longer available.").font(.footnote).foregroundStyle(FD.secondary)
                    Button("Transcribe on this device") { recover(using: "on-device") }
                    Button("Transcribe on paired computer") { recover(using: "openrouter") }.disabled(!model.connected)
                    if model.voice.transcribing { HStack { ActivityDiamond(); Text("Transcribing…") } }
                    if !recovered.isEmpty {
                        TextField("Recovered transcript", text: $recovered, axis: .vertical).lineLimit(3...12)
                        Button("Copy transcript") { UIPasteboard.general.string = recovered }
                        Button("Use in a new task") {
                            guard !inserting else { return }; inserting = true
                            Task {
                                defer { inserting = false }
                                if await model.insertRecoveredSpeech(recovered) { recovered = ""; model.showSpeechSettings = false }
                                else { error = model.error ?? "Couldn't create a task. Your transcript is still here; you can retry or copy it." }
                            }
                        }.disabled(!model.demo && !model.connected)
                    }
                    Button("Discard recording", role: .destructive) { model.voice.discard(); recovered = "" }
                } header: { Text("Saved recording") }.listRowBackground(FD.surface).disabled(model.voice.transcribing || inserting)
            }
            if let error = error ?? model.voice.error { Text(error).font(.footnote).foregroundStyle(.orange) }
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Speech")
            .task { if provider == "openrouter" { await refresh() } }
            .onChange(of: provider) { _, value in error = nil; if value == "openrouter" { Task { await refresh() } } }
            .toolbar { if modal { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(inserting) } } }
            .interactiveDismissDisabled(inserting)
    }
    private func recover(using provider: String) {
        model.readAloud.stop(); error = nil
        Task {
            do { recovered = try await model.voice.transcribe(model: model, using: provider) }
            catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
        }
    }
    private func refresh() async {
        guard !loading else { return }; loading = true; error = nil
        defer { loading = false }
        if model.demo { desktopStatus = "Demo · on-device speech available"; return }
        let current = model.connectionID
        do {
            let status = try await model.relay.call("speech.status", params: .object([:]))
            guard current == model.connectionID else { return }
            desktopStatus = status["configured"].bool ? "Ready" : "Add a key in desktop settings"
            let response = try await model.relay.call("speech.models", params: .object([:]))
            guard current == model.connectionID else { return }
            models = response.array
        } catch { if current == model.connectionID { self.error = error.localizedDescription; desktopStatus = "Could not connect" } }
    }
}
