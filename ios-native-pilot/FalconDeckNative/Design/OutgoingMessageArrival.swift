import SwiftUI

/// A single local send settles gently into the list. History loads and token
/// updates keep their existing stillness; moving a draft to its real task shares
/// the claim so it cannot animate twice. No opacity animation touches glass.
struct OutgoingMessageArrival: ViewModifier {
    @Environment(\.nativeMotion) private var motion
    let delivery: OutgoingMessage?
    @State private var appeared = false
    private var entering: Bool { delivery != nil && delivery?.entranceClaimed == false && !appeared && motion.effectsEnabled }
    func body(content: Content) -> some View {
        content
            .offset(y: entering ? 12 : 0)
            .scaleEffect(entering ? 0.985 : 1, anchor: .bottom)
            .onAppear {
                guard let delivery, !delivery.entranceClaimed else { return }
                delivery.entranceClaimed = true
                withAnimation(motion.interactionAnimation) { appeared = true }
            }
    }
}
