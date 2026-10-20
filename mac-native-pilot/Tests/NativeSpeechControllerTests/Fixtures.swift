import AppKit
import Foundation

@MainActor final class AppStore {
    var selectedProjectID: String?
    var selectedTaskID: String?
    func request(_ path: String, method: String = "GET", body: JSON? = nil) async throws -> JSON { .object([:]) }
}

@MainActor final class NativeSpeechPanel {
    init(controller: NativeSpeechController) {}
    func orderOut(_ sender: Any?) {}
    func show() {}
}

@MainActor final class NativeAudioPlayback {
    static let shared = NativeAudioPlayback()
    func stop() {}
    func stopRealtime() {}
}

actor NativeParakeetRuntime {
    static let shared = NativeParakeetRuntime()
    static let statusDidChange = Notification.Name("fixture.parakeet")
    func stop() {}
    func status() -> String { "fixture" }
    func configure(idleMinutes: Int, enabled: Bool) {}
    func setup(redownload: Bool) throws {}
    func prewarm(idleMinutes: Int) throws {}
    func transcribe(path: String) throws -> String { throw PilotError("No speech was detected.") }
}
