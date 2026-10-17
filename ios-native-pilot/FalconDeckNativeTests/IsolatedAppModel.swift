import Foundation
@testable import FalconDeckNative

/// Fake relay tests must not read the development app's real Keychain identity,
/// mutate its remote registration, or schedule device notifications.
@MainActor extension AppModel {
    static func testing(relay: any RelayServing, voice: VoiceRecorder = VoiceRecorder()) -> AppModel {
        let suite = "NativeModelTests-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        let push = NativePushNotifications(defaults: defaults)
        defaults.removePersistentDomain(forName: suite)
        return AppModel(relay: relay, voice: voice, push: push, notifications: LocalNotifications(defaults: defaults), sessionLoader: { nil })
    }
}
