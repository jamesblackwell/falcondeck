import SwiftUI

/// The same scan-or-enter flow as mobile, using native camera and controls.
struct ConnectionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var onboarding = false
    @State private var relayURL = PairingInput.defaultRelay
    @State private var showScanner = false
    @FocusState private var codeFocused: Bool
    private var connecting: Bool { model.busy || model.pairingPending }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: 32) {
                        VStack(spacing: 8) {
                            Text("FalconDeck").font(.largeTitle.weight(.semibold))
                            Text("Connect to your desktop agent").foregroundStyle(FD.secondary)
                        }.multilineTextAlignment(.center)
                        if connecting {
                            connectingState
                        } else {
                            pairingControls
                            if !model.hasSession {
                                VStack(spacing: 10) {
                                    Text("Just looking around?").font(.subheadline.weight(.semibold))
                                    Text("Open a sample workspace with example conversations.")
                                        .font(.caption).foregroundStyle(FD.secondary).multilineTextAlignment(.center)
                                    Button("Explore demo workspace") { Task { await model.useDemo() } }
                                        .buttonStyle(.bordered)
                                }.padding(20).frame(maxWidth: .infinity)
                                    .background(FD.surface, in: .rect(cornerRadius: FD.radius))
                            }
                        }
                    }
                    .frame(maxWidth: 360)
                    .padding(24)
                    .frame(maxWidth: .infinity, minHeight: max(0, geometry.size.height))
                }.scrollDismissesKeyboard(.interactively)
            }
            .safeAreaInset(edge: .bottom) { footer }
            .background(FD.background).foregroundStyle(FD.foreground)
            .toolbar {
                if !onboarding && !connecting {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
            }
        }
        .interactiveDismissDisabled(connecting)
        .sheet(isPresented: $showScanner) {
            PairingScanner(relay: relayURL) { payload in
                Task { await model.receivePairingPayload(payload, relayURL: relayURL) }
            }
        }
    }

    private var pairingControls: some View {
        @Bindable var model = model
        return VStack(spacing: 14) {
            if let review = model.pairingRelayReview {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Review self-hosted relay").font(.headline)
                    Text("This code will connect FalconDeck to \(review.relay.host() ?? review.relay.absoluteString). Only continue if you recognise and trust this server.")
                        .font(.subheadline).foregroundStyle(FD.secondary)
                    HStack {
                        Button("Cancel") { model.pairingRelayReview = nil }
                        Spacer()
                        Button("Use this relay") { Task { await model.acceptPairingRelay() } }
                            .buttonStyle(.borderedProminent)
                    }
                }.padding().background(FD.surface, in: .rect(cornerRadius: 16))
                    .accessibilityIdentifier("pairing-relay-review")
            } else {
                Button {
                    codeFocused = false; showScanner = true
                } label: {
                    Label("Scan QR code", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity).padding(.vertical, 6).foregroundStyle(FD.background)
                }.buttonStyle(.borderedProminent).controlSize(.large)
                    .accessibilityIdentifier("pair-scan")
                HStack(spacing: 12) {
                    Rectangle().fill(FD.line).frame(height: 1)
                    Text("or enter the code").font(.caption).foregroundStyle(FD.muted).fixedSize()
                    Rectangle().fill(FD.line).frame(height: 1)
                }.padding(.vertical, 2)
                TextField("Pairing code", text: $model.pairingText)
                    .textContentType(.none).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .font(.body.monospaced()).multilineTextAlignment(.center)
                    .padding(15).background(FD.surface, in: .rect(cornerRadius: 12))
                    .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(FD.line) }
                    .focused($codeFocused).submitLabel(.go).onSubmit(connect)
                    .accessibilityLabel("Secure pairing code").accessibilityIdentifier("pairing-input")
                    .privacySensitive()
                Button(action: connect) { Text("Connect").frame(maxWidth: .infinity).padding(.vertical, 6) }
                    .buttonStyle(.bordered).controlSize(.large)
                    .disabled(model.pairingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("pair-connect")
            }
            if let error = model.error {
                Text(error).font(.subheadline).foregroundStyle(.orange).multilineTextAlignment(.center)
                    .accessibilityIdentifier("pairing-error")
            }
        }
    }

    private var connectingState: some View {
        VStack(spacing: 16) {
            ActivityDiamond()
            Text(model.busy ? "Connecting…" : model.status).font(.headline).multilineTextAlignment(.center)
            Text("Keep FalconDeck open on your computer while we secure your connection.")
                .font(.subheadline).foregroundStyle(FD.secondary).multilineTextAlignment(.center)
            if let error = model.error {
                Text(error).font(.subheadline).foregroundStyle(.orange).multilineTextAlignment(.center)
                if model.hasSession {
                    Button("Try again") { Task { await model.reconnect() } }.buttonStyle(.borderedProminent).disabled(model.busy)
                }
            }
            Button("Start over", role: .destructive) { Task { await model.forget() } }
                .disabled(model.busy)
        }.accessibilityIdentifier("pairing-progress")
    }

    private var footer: some View {
        VStack(spacing: 12) {
            if !connecting && model.pairingRelayReview == nil {
                DisclosureGroup("Self-hosted relay settings") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Only change this when using a self-hosted FalconDeck relay.").font(.caption)
                        TextField("Relay server URL", text: $relayURL).keyboardType(.URL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("pairing-relay")
                    }.padding(.top, 8)
                }.font(.caption).foregroundStyle(FD.secondary)
            }
            Label("End-to-end encrypted", systemImage: "lock")
                .font(.caption2).foregroundStyle(FD.muted)
        }.frame(maxWidth: 360).padding(.horizontal, 24).padding(.bottom, 12)
            .frame(maxWidth: .infinity).background(FD.background)
    }

    private func connect() {
        codeFocused = false
        Task { await model.pair(relayURL: relayURL) }
    }
}
