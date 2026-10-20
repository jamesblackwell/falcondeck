import AppKit

/// The native app confirms destructive quit only when it owns an active daemon.
/// An attaching client's exit never stops tasks in another FalconDeck app.
@MainActor final class RuntimeLifecycle: NSObject, NSApplicationDelegate {
    weak var store: AppStore?
    private var shutdownInProgress = false

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !shutdownInProgress else { return .terminateLater }
        shutdownInProgress = true
        Task {
            do { try await store?.persistInputState() }
            catch {
                let alert = NSAlert(error: error)
                alert.messageText = "Input couldn’t be saved before quitting"
                alert.addButton(withTitle: "Keep Open")
                alert.addButton(withTitle: "Quit Without Saving")
                guard alert.runModal() == .alertSecondButtonReturn else {
                    shutdownInProgress = false
                    sender.reply(toApplicationShouldTerminate: false)
                    return
                }
            }
            let count = await NativeRuntime.shared.activeThreadCount()
            if count > 0 {
                let alert = NSAlert()
                alert.messageText = "Stop active tasks and quit?"
                alert.informativeText = "\(count == 1 ? "1 task has" : "\(count) tasks have") an active turn. Quitting FalconDeck Native will stop \(count == 1 ? "it" : "them"). You can resume after reopening the app."
                alert.alertStyle = .warning
                alert.addButton(withTitle: "Quit and Stop Tasks")
                alert.addButton(withTitle: "Keep Open")
                guard alert.runModal() == .alertFirstButtonReturn else {
                    shutdownInProgress = false
                    sender.reply(toApplicationShouldTerminate: false)
                    return
                }
            }
            await store?.prepareForQuit()
            do { try await NativeRuntime.shared.shutdown() }
            catch {
                let alert = NSAlert(error: error)
                alert.messageText = "FalconDeck could not finish shutting down"
                alert.addButton(withTitle: "Quit")
                alert.runModal()
            }
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
