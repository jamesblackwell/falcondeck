import SwiftUI

struct ConnectionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var relayURL = "https://connect.falcondeck.com"
    @State private var confirmForget = false
    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 14) {
                        Image(systemName: "laptopcomputer.and.iphone").font(.largeTitle).foregroundStyle(FD.accent)
                        Text("Your computer.\nAnywhere you are.").font(.title2.weight(.semibold))
                        Text("On your computer, open FalconDeck’s remote access settings and create a pairing link. Paste the full link below.")
                            .font(.subheadline).foregroundStyle(FD.secondary)
                    }.padding(.vertical, 12)
                }.listRowBackground(FD.surface)
                Section("Pair a computer") {
                    SecureField("Secure pairing link or code", text: $model.pairingText)
                        .textContentType(.none).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("pairing-input")
                    DisclosureGroup("Relay address") {
                        TextField("Relay URL", text: $relayURL).keyboardType(.URL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    Button {
                        Task { await model.pair(relayURL: relayURL) }
                    } label: {
                        HStack {
                            Label(model.busy ? "Connecting…" : "Connect securely", systemImage: "lock.shield")
                            Spacer()
                            if model.busy { ActivityDiamond() }
                        }
                    }.disabled(model.pairingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
                        .accessibilityIdentifier("pair-connect")
                }.listRowBackground(FD.surface)
                if let error = model.error {
                    Section { Text(error).font(.subheadline).foregroundStyle(.orange) }.listRowBackground(FD.surface)
                }
                Section("This pilot") {
                    LabeledContent("Connection", value: model.status)
                    LabeledContent("Client", value: "SwiftUI · Native pilot")
                    if let date = model.refreshedAt {
                        LabeledContent("Last refreshed") { Text(date, style: .time) }
                    }
                    if model.hasSession {
                        Button("Reconnect saved computer") {
                            Task {
                                await model.reconnect()
                                if model.error == nil { dismiss() }
                            }
                        }.disabled(model.busy)
                        Button("Forget this connection", role: .destructive) { confirmForget = true }.disabled(model.busy)
                    }
                    Button("Explore demo workspace") {
                        Task { await model.useDemo(); dismiss() }
                    }.disabled(model.busy)
                }.listRowBackground(FD.surface)
                Section {
                    Label("Pairing creates a separate trusted device named Falcon Native Pilot. Forgetting removes credentials on this device; you can revoke it from your computer.", systemImage: "lock.shield")
                        .font(.footnote).foregroundStyle(FD.secondary)
                }.listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden).background(FD.background)
            .navigationTitle("Connection").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Forget this computer?", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("Forget connection", role: .destructive) { Task { await model.forget() } }
            } message: { Text("You’ll need a new pairing link to connect again.") }
        }
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(model.busy)
    }
}
