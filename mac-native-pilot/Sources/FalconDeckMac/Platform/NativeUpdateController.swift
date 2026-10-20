import AppKit
import Foundation
import Observation
import Sparkle

/// Sparkle owns appcast validation, signature verification and installation.
/// An unconfigured local build never reports a successful update check.
@MainActor @Observable final class NativeUpdateController: NSObject, SPUUserDriver, SPUUpdaterDelegate {
    static let shared = NativeUpdateController()

    private(set) var state = "idle"
    private(set) var version: String?
    private(set) var releaseNotes: String?
    private(set) var error: String?
    private(set) var progress: Double?
    private(set) var canCheck = false

    @ObservationIgnored private var updater: SPUUpdater?
    @ObservationIgnored private var updateChoice: ((SPUUserUpdateChoice) -> Void)?
    @ObservationIgnored private var installChoice: ((SPUUserUpdateChoice) -> Void)?
    @ObservationIgnored private var retryTermination: (() -> Void)?
    @ObservationIgnored private var expectedBytes: UInt64 = 0
    @ObservationIgnored private var receivedBytes: UInt64 = 0
    @ObservationIgnored private var restarting = false
    @ObservationIgnored private var installationRevision = UUID()
    @ObservationIgnored private let activeThreadCount: @MainActor () async -> Int

    init(startUpdater: Bool = true,
         activeThreadCount: @escaping @MainActor () async -> Int = { await NativeRuntime.shared.activeThreadCount() }) {
        self.activeThreadCount = activeThreadCount
        super.init()
        guard startUpdater, Self.configurationIsValid(Bundle.main) else {
            state = "unavailable"
            return
        }
        let updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: self, delegate: self)
        self.updater = updater
        do {
            try updater.start()
            canCheck = true
        } catch {
            state = "error"
            self.error = error.localizedDescription
        }
    }

    static func configurationIsValid(_ bundle: Bundle) -> Bool {
        // Never target the stable Tauri app or use its JSON updater feed.
        guard bundle.bundleIdentifier == "com.falcondeck.mac-native-pilot",
              bundle.bundleURL.pathExtension == "app",
              let address = bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              let url = URL(string: address), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil,
              url.pathExtension.lowercased() != "json",
              let publicKey = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              Data(base64Encoded: publicKey)?.count == 32 else { return false }
        return true
    }

    func check() async {
        guard let updater, canCheck else { return }
        error = nil
        version = nil
        releaseNotes = nil
        progress = nil
        state = "checking"
        canCheck = false
        updater.checkForUpdates()
    }

    func downloadAndInstall() async {
        guard state == "available", let reply = updateChoice else { return }
        updateChoice = nil
        error = nil
        state = "downloading"
        progress = 0
        reply(.install)
    }

    func restart() async {
        guard state == "installed", !restarting, installChoice != nil || retryTermination != nil else { return }
        restarting = true
        defer { restarting = false }
        let revision = installationRevision
        let count = await activeThreadCount()
        // Sparkle can abort while the daemon count is being fetched. Never
        // invoke a termination retry from a different or dismissed cycle.
        guard installationRevision == revision, state == "installed", installChoice != nil || retryTermination != nil else { return }
        if count > 0 {
            error = "\(count == 1 ? "1 task is" : "\(count) tasks are") still running in the native daemon. Let active tasks finish or stop them before restarting to install the update."
            return
        }
        error = nil
        // RuntimeLifecycle performs the final owned-daemon guard and shutdown
        // when Sparkle asks NSApplication to terminate. Attached runtimes live on.
        if let reply = installChoice { installChoice = nil; reply(.install) }
        else { retryTermination?() }
    }

    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: false, automaticUpdateDownloading: false, sendSystemProfile: false))
    }

    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        state = "checking"
        canCheck = false
    }

    func showUpdateFound(with appcastItem: SUAppcastItem, state updateState: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        installationRevision = UUID()
        version = appcastItem.displayVersionString
        releaseNotes = Self.readableNotes(appcastItem.itemDescription)
        error = nil
        progress = nil
        guard !appcastItem.isInformationOnlyUpdate, appcastItem.fileURL?.scheme == "https" else {
            state = "error"
            error = "This release has no installable HTTPS native update. View downloads for details."
            reply(.dismiss)
            return
        }
        if updateState.stage == .installing {
            installChoice = reply
            state = "installed"
        } else {
            updateChoice = reply
            state = "available"
        }
    }

    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
        releaseNotes = Self.readableNotes(String(data: downloadData.data, encoding: .utf8))
    }

    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {
        releaseNotes = "Release notes could not be loaded. \(error.localizedDescription)"
    }

    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        let reason = (error as NSError).userInfo[SPUNoUpdateFoundReasonKey] as? NSNumber
        if reason?.int32Value == SPUNoUpdateFoundReason.onLatestVersion.rawValue
            || reason?.int32Value == SPUNoUpdateFoundReason.onNewerThanLatestVersion.rawValue {
            state = "upToDate"
            self.error = nil
            canCheck = true
        } else { fail(error) }
        acknowledgement()
    }

    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        fail(error)
        acknowledgement()
    }

    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        state = "downloading"
        expectedBytes = 0
        receivedBytes = 0
        progress = nil
    }

    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
        expectedBytes = expectedContentLength
        updateProgress()
    }

    func showDownloadDidReceiveData(ofLength length: UInt64) {
        receivedBytes = receivedBytes.addingReportingOverflow(length).partialValue
        updateProgress()
    }

    func showDownloadDidStartExtractingUpdate() { progress = nil }
    func showExtractionReceivedProgress(_ progress: Double) {
        self.progress = progress.isFinite ? min(1, max(0, progress)) : nil
    }

    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        installationRevision = UUID()
        installChoice = reply
        state = "installed"
        progress = nil
        canCheck = false
    }

    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
        retryTermination = applicationTerminated ? nil : retryTerminatingApplication
        state = "installed"
    }

    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
        state = "installed"
        progress = nil
        acknowledgement()
    }

    func dismissUpdateInstallation() {
        installationRevision = UUID()
        updateChoice = nil
        installChoice = nil
        retryTermination = nil
        // Removed callbacks cannot service Download or Restart buttons. Keep
        // outcome messages, but tear down every state with an active action.
        if ["checking", "available", "downloading", "installed"].contains(state) { state = "idle" }
        progress = nil
        canCheck = updater != nil
    }

    func updaterShouldPromptForPermissionToCheck(forUpdates updater: SPUUpdater) -> Bool { false }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        if let error, state != "upToDate" { fail(error) }
        else if state == "checking" { state = "idle" }
        canCheck = state != "downloading" && state != "installed" && updateChoice == nil
    }

    private func updateProgress() {
        progress = expectedBytes == 0 ? nil : min(1, Double(receivedBytes) / Double(expectedBytes))
    }

    private func fail(_ error: Error) {
        state = "error"
        self.error = error.localizedDescription
        progress = nil
        canCheck = true
    }

    private static func readableNotes(_ notes: String?) -> String? {
        guard let notes, !notes.isEmpty else { return nil }
        // Render notes as plain text; never load appcast HTML into a web view.
        return notes.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
