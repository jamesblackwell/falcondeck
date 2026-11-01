import Observation
import SwiftUI

/// Owns one presentation of the file viewer. Each view that can show a sheet
/// (the app root, the bot sheet) installs its own, because a full-screen cover
/// cannot be presented from behind a sheet.
@MainActor @Observable final class FilePresenter {
    var presented: FileReference?
    func present(_ reference: FileReference) { presented = reference }
    #if DEBUG
    private static var launched = false
    func openLaunchArgument() async {
        guard !Self.launched, let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--open-file=") }) else { return }
        Self.launched = true
        try? await Task.sleep(for: .seconds(Double(ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--open-file-after=") }.flatMap { Double($0.dropFirst(18)) } ?? 8)))
        present(FileReference(path: String(argument.dropFirst("--open-file=".count))))
    }
    #endif
}

private struct FileViewerPresenter: ViewModifier {
    @State private var presenter = FilePresenter()
    func body(content: Content) -> some View {
        content
            .environment(\.openFile) { [presenter] reference in presenter.present(reference) }
            .fullScreenCover(item: $presenter.presented) { reference in FileViewer(reference: reference) }
            #if DEBUG
            // QA: `--open-file=<path>` opens the viewer once the computer is paired and connected.
            .task { await presenter.openLaunchArgument() }
            #endif
    }
}

extension View {
    /// Makes links to files on the computer open in the full-screen viewer.
    func fileViewerPresenter() -> some View { modifier(FileViewerPresenter()) }
}

/// Pushes the files a document links to onto the viewer's own stack, so Back
/// returns to the report that linked them.
@MainActor @Observable final class FileNavigator {
    var path: [FileReference] = []
}

/// A full-screen document viewer. It takes a file reference and nothing about
/// where the reference came from, so a transcript link, a bot sheet or a future
/// review inbox can all open it.
struct FileViewer: View {
    let reference: FileReference
    @State private var navigator = FileNavigator()
    var body: some View {
        @Bindable var navigator = navigator
        NavigationStack(path: $navigator.path) {
            FileScreen(reference: reference, closable: true)
                .navigationDestination(for: FileReference.self) { FileScreen(reference: $0, closable: false) }
        }
        .environment(\.openFile) { [navigator] in navigator.path.append($0) }
        .tint(FD.accent)
        .accessibilityIdentifier("file-viewer")
    }
}

@MainActor @Observable final class FileScreenModel {
    enum Phase: Equatable {
        case loading(FileProgress?)
        case ready(LoadedFile)
        case failed(FilePreviewError)
    }
    var phase: Phase = .loading(nil)

    func load(_ reference: FileReference, store: RemoteFileStore, connected: Bool) async {
        phase = .loading(nil)
        do {
            let file = try await store.open(reference, probe: .stat) { [weak self] progress in
                Task { @MainActor in
                    // A finished transfer must not be dragged back to "loading".
                    if case .loading = self?.phase { self?.phase = .loading(progress) }
                }
            }
            phase = .ready(file)
        } catch is CancellationError {
            return
        } catch {
            let failure = FilePreviewError(error)
            // Offline with a saved copy beats an error: show it, marked as saved.
            if !failure.isAboutTheFile, let saved = await store.savedCopy(of: reference) { phase = .ready(saved) }
            else { phase = .failed(failure) }
        }
    }
}

extension FilePreviewError {
    /// The computer answered and the answer was about the file itself.
    var isAboutTheFile: Bool {
        switch self {
        case .denied, .notFound, .tooLarge, .unsupported, .changed: true
        case .notConnected, .failed: false
        }
    }
}

private struct FileScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let reference: FileReference
    let closable: Bool
    @State private var screen = FileScreenModel()
    @State private var attempt = 0
    @State private var showSource = false
    @State private var copied = false

    private var ready: LoadedFile? { if case .ready(let file) = screen.phase { file } else { nil } }
    private var title: String { ready?.meta.name ?? reference.name }
    private var canShowSource: Bool { ready.map { [.markdown, .html].contains($0.meta.fileKind) } ?? false }

    var body: some View {
        ZStack {
            FD.background.ignoresSafeArea()
            switch screen.phase {
            case .loading(let progress):
                FileLoadingView(name: reference.name, progress: progress)
            case .failed(let error):
                FileErrorView(error: error, retry: error.retryable ? { attempt += 1 } : nil)
            case .ready(let file):
                VStack(spacing: 0) {
                    if file.stale { SavedCopyBanner(file: file) { attempt += 1 } }
                    FileContent(file: file, reference: reference, showSource: showSource).id(file.url)
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if closable {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close", systemImage: "xmark") { dismiss() }.accessibilityIdentifier("file-viewer-close")
                }
            }
            if let file = ready {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    ShareLink(item: file.url) { Label("Share", systemImage: "square.and.arrow.up") }
                        .accessibilityIdentifier("file-viewer-share")
                    Menu {
                        if canShowSource {
                            Button(showSource ? "Show rendered" : "Show source", systemImage: showSource ? "doc.richtext" : "chevron.left.forwardslash.chevron.right") { showSource.toggle() }
                        }
                        Button(copied ? "Copied" : "Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = file.meta.path; copied = true }
                        Button("Reload from Mac", systemImage: "arrow.clockwise") { attempt += 1 }
                    } label: { Label("More", systemImage: "ellipsis.circle") }
                        .accessibilityIdentifier("file-viewer-menu")
                }
            }
        }
        .toolbarBackground(.visible, for: .navigationBar)
        .task(id: attempt) { await screen.load(reference, store: model.files, connected: model.connected) }
        .onChange(of: model.connected) { _, connected in
            // The link may have been opened while reconnecting.
            if connected, case .failed(let error) = screen.phase, !error.isAboutTheFile { attempt += 1 }
        }
    }
}

private struct SavedCopyBanner: View {
    let file: LoadedFile
    let retry: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "icloud.slash").foregroundStyle(FD.warning)
            VStack(alignment: .leading, spacing: 1) {
                Text("Your Mac isn't reachable").font(.footnote.weight(.semibold)).foregroundStyle(FD.foreground)
                Text("Showing a copy saved \(file.meta.modified.formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(FD.secondary)
            }
            Spacer(minLength: 8)
            Button("Retry", action: retry).font(.footnote.weight(.semibold))
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(FD.warning.opacity(0.12))
        .overlay(alignment: .bottom) { FD.hairline.frame(height: 1) }
        .accessibilityIdentifier("file-viewer-saved-copy")
    }
}

/// Large files cross a slow relay; say how far along and how long is left.
private struct FileLoadingView: View {
    let name: String
    let progress: FileProgress?
    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: FileIcon.symbol(forName: name)).font(.system(size: 34, weight: .light)).foregroundStyle(FD.muted)
            Text(name).font(.headline).foregroundStyle(FD.foreground).lineLimit(2).multilineTextAlignment(.center)
            if let progress, progress.total > 0 {
                VStack(spacing: 8) {
                    ProgressView(value: progress.fraction).progressViewStyle(.linear).tint(FD.accent).frame(maxWidth: 240)
                        .accessibilityIdentifier("file-viewer-progress")
                    Text(FileLoadingView.caption(progress)).font(.footnote).foregroundStyle(FD.secondary).monospacedDigit()
                }
            } else {
                HStack(spacing: 8) { ActivityDiamond(); Text("Loading from your Mac…").font(.footnote).foregroundStyle(FD.secondary) }
            }
        }
        .padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("file-viewer-loading")
    }

    static func caption(_ progress: FileProgress) -> String {
        let format = ByteCountFormatStyle(style: .file)
        var text = "\(progress.loaded.formatted(format)) of \(progress.total.formatted(format))"
        if let remaining = progress.remaining, remaining >= 3 {
            text += " · " + (remaining < 90 ? "about \(Int(remaining.rounded())) sec left" : "about \(Int((remaining / 60).rounded(.up))) min left")
        }
        return text
    }
}

private struct FileErrorView: View {
    let error: FilePreviewError
    let retry: (() -> Void)?
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: error.symbol).font(.system(size: 36, weight: .light)).foregroundStyle(error == .denied ? FD.warning : FD.muted)
            Text(error.title).font(.headline).foregroundStyle(FD.foreground).multilineTextAlignment(.center)
            Text(error.detail).font(.subheadline).foregroundStyle(FD.secondary).multilineTextAlignment(.center)
            if let retry { Button("Try again", action: retry).buttonStyle(.borderedProminent).padding(.top, 4).accessibilityIdentifier("file-viewer-retry") }
        }
        .padding(32).frame(maxWidth: 420).frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("file-viewer-error")
    }
}

enum FileIcon {
    static func symbol(forName name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "md", "markdown", "txt", "log": "doc.text"
        case "html", "htm": "safari"
        case "pdf": "doc.richtext"
        case "png", "jpg", "jpeg", "gif", "webp", "svg", "heic": "photo"
        case "mp4", "mov": "film"
        case "mp3", "wav", "m4a": "waveform"
        case "csv", "tsv", "xlsx": "tablecells"
        default: "doc"
        }
    }
}
