import Foundation

struct PairingRelayReview {
    let text: String
    let relay: URL
}

@MainActor extension AppModel {
    /// QR scans and incoming links use the same path as Expo: consume once,
    /// review a custom server if needed, then connect without another tap.
    func receivePairingPayload(_ payload: String, relayURL: String = PairingInput.defaultRelay) async {
        guard !claimingPairing, !pairingPending else { return }
        if restoringSession || busy {
            queuedPairingPayload = (payload, relayURL)
            return
        }
        pairingText = payload
        pairingRelayReview = nil
        showConnection = true
        await pair(relayURL: relayURL)
    }

    func consumeQueuedPairingPayload() {
        guard !restoringSession, !busy, !pairingPending, let payload = queuedPairingPayload else { return }
        queuedPairingPayload = nil
        Task { await self.receivePairingPayload(payload.text, relayURL: payload.relayURL) }
    }

    func acceptPairingRelay() async {
        guard let review = pairingRelayReview, !busy, !pairingPending else { return }
        pairingText = review.text
        await pair(relayURL: review.relay.absoluteString, approvedRelay: true)
    }
}
