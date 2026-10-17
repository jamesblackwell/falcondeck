import Foundation

@MainActor extension AppModel {
    func setForeground(_ active: Bool) {
        foreground = active
        Task { await relay.setForeground(active) }
        if active {
            synchronizePush()
            if hasSession && !demo { Task { if self.connected { await self.refresh() } else { await self.reconnect() } } }
        } else { reconnectTask?.cancel(); reconnectTask = nil; Task { await self.saveAllInputs() } }
    }
    func scheduleReconnect() {
        guard hasSession, !demo, foreground, networkAvailable, reconnectTask == nil else { return }
        let delay = ReconnectDelay.seconds(attempt: reconnectAttempt)
        reconnectAttempt += 1
        reconnectTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self else { return }
            self.reconnectTask = nil
            guard !self.connected, self.foreground, self.networkAvailable else { return }
            await self.reconnect()
        }
    }

}
