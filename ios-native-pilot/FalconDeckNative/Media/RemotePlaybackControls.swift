import MediaPlayer

@MainActor final class RemotePlaybackControls {
    enum Action: Sendable { case play, pause, toggle, stop }
    private var handlers: [(MPRemoteCommand, Any)] = []
    init(perform: @escaping @MainActor @Sendable (Action) -> Void) {
        let center = MPRemoteCommandCenter.shared()
        for (command, action) in [(center.playCommand, Action.play), (center.pauseCommand, .pause), (center.togglePlayPauseCommand, .toggle), (center.stopCommand, .stop)] {
            command.isEnabled = true
            let target = command.addTarget { @Sendable _ in Task { @MainActor in perform(action) }; return .success }
            handlers.append((command, target))
        }
        center.nextTrackCommand.isEnabled = false; center.previousTrackCommand.isEnabled = false
        center.changePlaybackPositionCommand.isEnabled = false
    }
    func remove() { for (command, target) in handlers { command.removeTarget(target); command.isEnabled = false }; handlers = [] }
}
