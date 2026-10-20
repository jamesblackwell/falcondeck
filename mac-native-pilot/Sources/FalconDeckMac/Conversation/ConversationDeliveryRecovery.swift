import SwiftUI

/// A transport error cannot tell us whether the daemon accepted a message.
/// Keep recovery explicit so reconnecting never sends the same message twice.
struct ConversationDeliveryRecovery: View {
    let store: AppStore
    let pending: NativePendingSubmission
    @State private var confirmDismiss = false

    private var checking: Bool { pending.status == .checking }
    private var mayRetry: Bool { pending.status == .prepared || pending.status == .checkedMissing }
    private var title: String {
        switch pending.status {
        case .prepared: return "Saved message ready to recover"
        case .uncertain: return "Check whether your message was delivered"
        case .checking: return "Checking message delivery…"
        case .checkedMissing: return "Your message was not found in this conversation"
        }
    }
    private var explanation: String {
        switch pending.status {
        case .prepared: return "Your message and attachments were saved before sending."
        case .uncertain: return "The connection ended before delivery was confirmed. Your input is saved."
        case .checking: return "Looking for this message in the conversation and its queued follow-ups."
        case .checkedMissing: return "Delivery has been checked. You can send the saved message when you are ready."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Group {
                    if checking { ProgressView().controlSize(.small) }
                    else { Image(systemName: "tray.and.arrow.down").foregroundStyle(FDTheme.warning) }
                }.frame(width: 18)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(NativePreferences.shared.font(size: 13, weight: .semibold))
                    Text(explanation).font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.secondary)
                    if let error = pending.lastError, !error.isEmpty {
                        Text(error).font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted).textSelection(.enabled)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 12) {
                Button("Check delivery") { Task { await store.recheckPendingSubmission() } }
                    .disabled(checking || !store.isSelectedHostConnected || store.isSending)
                    .accessibilityIdentifier("check-message-delivery")
                if mayRetry {
                    Button(pending.status == .prepared ? "Send saved message" : "Send again") {
                        Task { await store.retryPendingSubmission() }
                    }.disabled(checking || !store.isSelectedHostConnected || store.isSending)
                        .accessibilityIdentifier("retry-saved-message")
                }
                Button("Recover input") { Task { await store.recoverPendingSubmission() } }
                    .disabled(checking || store.isSending).accessibilityIdentifier("recover-message-input")
                Spacer(minLength: 0)
                Button("Keep draft and dismiss") {
                    if pending.status == .prepared { Task { await store.dismissPendingSubmission() } }
                    else { confirmDismiss = true }
                }.foregroundStyle(FDTheme.muted).disabled(checking || store.isSending)
                    .accessibilityIdentifier("dismiss-message-recovery")
            }.font(NativePreferences.shared.font(size: 12, weight: .medium)).buttonStyle(.borderless)
        }.foregroundStyle(FDTheme.foreground).padding(14)
            .background(FDTheme.warning.opacity(0.07), in: .rect(cornerRadius: 10))
            .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(FDTheme.warning.opacity(0.22)) }
            .padding(.horizontal, 28).padding(.top, 12)
            .accessibilityIdentifier("message-delivery-recovery")
            .confirmationDialog("Keep this message as a draft?", isPresented: $confirmDismiss) {
                Button("Keep draft and dismiss recovery") { Task { await store.dismissPendingSubmission(acknowledgeDeliveryRisk: true) } }
                Button("Cancel", role: .cancel) { }
            } message: {
                Text("The message may already have been delivered. Your text and attachments will be recovered as a draft. Check the conversation before sending them again.")
            }
    }
}
