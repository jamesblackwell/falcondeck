import Foundation

// Deliberately replaces the native module in this isolated runner. No test
// opens a microphone, installs a shortcut, pastes text, or requests a grant.
public enum SpeechBridgeFixture {
    public static var retainedPath: String?
    public static var droppedCancelled = 0
    public static var retryFiles = 0
    public static var retries = 0
}

public func fd_native_speech_set_event_handler(_ callback: @escaping @convention(c) (Int32, UnsafePointer<CChar>?) -> Void) {}
public func fd_native_speech_set_insert_handler(_ callback: @escaping @convention(c) (UnsafePointer<CChar>?) -> Bool) {}
public func fd_native_speech_suspend_shortcuts(_ suspended: Bool) {}
public func fd_native_speech_cancel_processing() {}
public func fd_native_speech_retained_provider() -> Int32 { 0 }
public func fd_native_speech_retry_file(_ path: UnsafePointer<CChar>, _ provider: Int32) { SpeechBridgeFixture.retryFiles += 1 }
public func fd_dictation_retained_recording_path() -> UnsafeMutablePointer<CChar>? { SpeechBridgeFixture.retainedPath.flatMap { strdup($0) } }
public func fd_dictation_retained_recording_duration_seconds() -> Double { 1 }
public func fd_dictation_free_string(_ value: UnsafeMutablePointer<CChar>) { free(value) }
public func fd_dictation_audio_devices_json() -> UnsafeMutablePointer<CChar>? { strdup("[]") }
public func fd_dictation_microphone_permission() -> Int32 { 2 }
public func fd_dictation_speech_permission() -> Int32 { 2 }
public func fd_dictation_accessibility_permission() -> Bool { true }
public func fd_dictation_request_microphone_permission() {}
public func fd_dictation_request_speech_permission() {}
public func fd_dictation_request_accessibility_permission() {}
public func fd_dictation_configure(_ enabled: Bool, _ shortcut: UnsafePointer<CChar>, _ activation: Int32, _ provider: Int32,
                                  _ microphone: UnsafePointer<CChar>, _ retain: Bool, _ rewrite: Bool,
                                  _ rewriteShortcut: UnsafePointer<CChar>, _ cleanup: Bool) {}
public func fd_dictation_start() {}
public func fd_dictation_stop() {}
public func fd_dictation_cancel() {}
public func fd_dictation_drop_cancelled() { SpeechBridgeFixture.droppedCancelled += 1; SpeechBridgeFixture.retainedPath = nil }
public func fd_dictation_retry(_ copy: Bool) { SpeechBridgeFixture.retries += 1 }
public func fd_dictation_retry_paste(_ text: UnsafePointer<CChar>) {}
public func fd_dictation_discard() { SpeechBridgeFixture.retainedPath = nil }
public func fd_dictation_copy_text(_ text: UnsafePointer<CChar>) -> Bool { false }
public func fd_dictation_paste_text(_ text: UnsafePointer<CChar>) -> Bool { false }
public func fd_dictation_replace_transcript(_ original: UnsafePointer<CChar>, _ replacement: UnsafePointer<CChar>) -> Bool { false }
public func fd_dictation_mark_completed() {}
public func fd_dictation_shutdown() {}
