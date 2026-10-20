import AppKit
import Foundation
import NativeSpeechBridge

@main struct ControllerLifecycleTests {
    @MainActor static func main() throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent("falcondeck-controller-tests-\(UUID().uuidString)")
        try files.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? files.removeItem(at: root) }
        let suite = "falcondeck-controller-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        func controller(history: [NativeRecording] = []) throws -> NativeSpeechController {
            let destination = root.appendingPathComponent(UUID().uuidString)
            let historyURL = destination.appendingPathComponent("history.json")
            try NativeSpeechFiles.save(history, at: historyURL)
            return NativeSpeechController(defaults: defaults, historyURL: historyURL,
                recoveryURL: destination.appendingPathComponent("recovery.json"), recordingDirectory: root)
        }
        func audio() throws -> URL {
            let url = files.temporaryDirectory.appendingPathComponent("falcondeck-native-dictation-\(UUID().uuidString).m4a")
            try Data("fixture".utf8).write(to: url)
            return url
        }

        // Dismissing Undo must release the canceled take instead of canceling
        // the only task which would ever delete it.
        let cancelled = try controller()
        cancelled.receive(kind: 11, payload: "")
        cancelled.dismissOverlay()
        precondition(SpeechBridgeFixture.droppedCancelled == 1, "Dismiss leaked the cancelled recording")
        precondition(!cancelled.canUndo)
        cancelled.undoCancellation()
        precondition(SpeechBridgeFixture.retries == 0, "Dismissed Undo retried a recording")

        // History retry is queued by the bridge. Protect its take immediately,
        // before the queued native adoption/Processing event can run.
        let activeAudio = try audio()
        defer { try? files.removeItem(at: activeAudio) }
        let record = NativeRecording(provider: "system", duration: 1, path: activeAudio.path)
        let retry = try controller(history: [record])
        retry.retryHistory(record)
        precondition(retry.isBusy, "Queued history retry was still editable")
        retry.deleteHistory(record)
        retry.clearHistory()
        var settings = retry.config
        settings.historyRetentionHours = 0
        retry.config = settings
        precondition(files.fileExists(atPath: activeAudio.path), "History cleanup deleted the queued retry")
        precondition(retry.history.count == 1)
        retry.retryHistory(record)
        precondition(SpeechBridgeFixture.retryFiles == 1, "A duplicate retry was queued")

        // A pending retry must likewise become busy before its bridge event.
        let pending = try controller()
        pending.retryPending()
        precondition(pending.isBusy)
        pending.retryPending()
        precondition(SpeechBridgeFixture.retries == 1)

        // With history off, abandoned capture files are still swept. Enumerate
        // only an isolated directory; the symlink resolves to our owned fixture.
        let abandonedAudio = try audio()
        defer { try? files.removeItem(at: abandonedAudio) }
        try files.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -1800)], ofItemAtPath: abandonedAudio.path)
        let link = root.appendingPathComponent(abandonedAudio.lastPathComponent)
        try files.createSymbolicLink(at: link, withDestinationURL: abandonedAudio)
        let abandoned = try controller()
        var disabledHistory = abandoned.config
        disabledHistory.historyRetentionHours = 1
        abandoned.config = disabledHistory
        precondition(files.fileExists(atPath: abandonedAudio.path), "Unexpired audio was removed")
        disabledHistory.historyRetentionHours = 0
        abandoned.config = disabledHistory
        precondition(!files.fileExists(atPath: abandonedAudio.path), "Disabled history retained abandoned audio")

        let protectedAudio = try audio()
        defer { try? files.removeItem(at: protectedAudio) }
        try files.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -1800)], ofItemAtPath: protectedAudio.path)
        try files.createSymbolicLink(at: root.appendingPathComponent("audio-alias.m4a"), withDestinationURL: protectedAudio)
        SpeechBridgeFixture.retainedPath = protectedAudio.path
        let protected = try controller()
        var noHistory = protected.config
        noHistory.historyRetentionHours = 1
        protected.config = noHistory
        noHistory.historyRetentionHours = 0
        protected.config = noHistory
        precondition(files.fileExists(atPath: protectedAudio.path), "Orphan alias deleted protected audio")
        SpeechBridgeFixture.retainedPath = nil

        // Import validation follows the same ordinary-typing restriction as
        // the shortcut recorder.
        for unsafe in ["A", "Shift+A", "Space", "Shift+Space", "Mod++A"] {
            precondition(!NativeSpeechController.validShortcut(unsafe), "Unsafe shortcut accepted: \(unsafe)")
        }
        for safe in ["Mod+A", "Ctrl+Shift+Space", "right_command", "F8"] {
            precondition(NativeSpeechController.validShortcut(safe), "Valid shortcut rejected: \(safe)")
        }
        print("Native speech controller lifecycle: 6 checks passed")
    }
}
