import Foundation
import Observation

/// Local delivery is separate from the wire's pending history echo. An RPC
/// acceptance can arrive before the echo, or after the whole turn has finished.
@MainActor @Observable final class OutgoingMessage {
    enum Phase: Equatable { case sending, accepted, queued }
    let submission: SavedSubmission
    let item: Message
    var phase = Phase.sending
    private(set) var observedActivity = false
    var needsHistoryRecheck = false
    @ObservationIgnored var entranceClaimed = false
    var id: String { submission.id }
    var awaitingAgent: Bool { phase == .accepted && !observedActivity }
    init(id: String, text: String, attachments: [NativeAttachment]) {
        submission = SavedSubmission(id: id, text: text, attachments: attachments)
        item = Message(.object(["id": .string(id), "kind": .string("user_message"), "text": .string(text), "pending": .bool(true), "attachments": .array(attachments.map(\.input))]))
    }
    func observe(_ event: JSON) {
        switch event["type"].string {
        case "conversation-item-added", "conversation-item-updated":
            let item = event["item"]
            if item["id"].string == id, item["kind"].string == "user_message" { phase = .accepted }
            if ["assistant_message", "reasoning", "tool_call", "interactive_request"].contains(item["kind"].string) { observedActivity = true }
        case "turn-end", "text", "tool-call-start", "interactive-request": observedActivity = true
        case "thread-updated":
            // Running summaries are coalesced before they reach task.running.
            // Keep the accepted fallback through that gap, until work or an
            // actual completion owns the visible status.
            if ["waiting_for_input", "error"].contains(event["thread"]["status"].string) { observedActivity = true }
        default: break
        }
    }
    func reconcile(history: [Message], thread: JSON, acceptedBeforeRead: Bool) {
        // A fresh read begun after this exact message's acceptance is a causal
        // barrier: the daemon sets running before it emits/acknowledges input.
        // A read already in flight can still describe the previous turn.
        needsHistoryRecheck = !acceptedBeforeRead
        if acceptedBeforeRead, ["idle", "error"].contains(thread["status"].string) { observedActivity = true }
        guard let index = history.firstIndex(where: { $0.id == id && !$0.raw["pending"].bool }) else { return }
        phase = .accepted
        // A reconnect can recover a completed turn without replaying its live
        // events. Authoritative output must end the local starting fallback.
        for item in history.dropFirst(index + 1) {
            observe(.object(["type": .string("conversation-item-added"), "item": item.raw]))
        }
        observe(.object(["type": .string("thread-updated"), "thread": thread]))
    }
}
