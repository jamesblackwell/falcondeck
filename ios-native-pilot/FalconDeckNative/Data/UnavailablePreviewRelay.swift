#if DEBUG
import Foundation

/// Deterministic offline/error previews never open a socket or read a pairing.
actor UnavailablePreviewRelay: RelayServing {
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) throws { throw unavailable }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) throws -> JSON { throw unavailable }
    func call(_ method: String, params: JSON) throws -> JSON { throw unavailable }
    private var unavailable: PilotError { PilotError("The preview computer is unavailable.") }
}
#endif
