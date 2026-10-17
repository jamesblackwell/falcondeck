import AVFoundation
import Foundation

/// Own the notification token independently of an actor's deinitialization.
final class AudioInterruptionObserver {
    private let token: NSObjectProtocol
    init(_ began: @escaping @MainActor @Sendable () -> Void) {
        token = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(), queue: nil) { note in
            guard (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in began() }
        }
    }
    deinit { NotificationCenter.default.removeObserver(token) }
}
