import Observation
import SwiftUI
import WebKit

/// Everything an HTML page asks for under `fdfile://` is read from the paired
/// computer through the same file RPCs as the viewer, so relative CSS, scripts,
/// JSON and images work without the page ever touching the file system. The
/// daemon's access policy applies to each request.
@MainActor final class FileSchemeHandler: NSObject, WKURLSchemeHandler {
    nonisolated static let scheme = "fdfile"
    /// https and local files only: no cleartext, sockets, forms or plugins.
    nonisolated static let contentSecurityPolicy = "default-src fdfile: https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src fdfile: https:; form-action 'none'; object-src 'none'"

    nonisolated static func url(forPath path: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme; components.host = "doc"; components.path = path
        return components.url
    }

    private let store: RemoteFileStore
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    init(store: RemoteFileStore) { self.store = store }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask)
        guard let url = urlSchemeTask.request.url, let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path, path.hasPrefix("/") else {
            respond(urlSchemeTask, url: urlSchemeTask.request.url, status: 400, body: Data("Bad file request".utf8))
            return
        }
        let range = urlSchemeTask.request.value(forHTTPHeaderField: "Range")
        tasks[id] = Task {
            defer { tasks[id] = nil }
            do {
                let file = try await store.open(FileReference(path: path), probe: .firstRange)
                let data = try await Task.detached(priority: .userInitiated) { try Data(contentsOf: file.url, options: .mappedIfSafe) }.value
                guard tasks[id] != nil, !Task.isCancelled else { return }
                respond(urlSchemeTask, url: url, status: 200, body: data, meta: file.meta, range: range)
            } catch is CancellationError {
                return
            } catch {
                guard tasks[id] != nil else { return }
                let failure = FilePreviewError(error)
                let status: Int = switch failure { case .denied: 403; case .notFound: 404; case .tooLarge: 413; default: 502 }
                respond(urlSchemeTask, url: url, status: status, body: Data(failure.title.utf8))
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        tasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }

    private func respond(_ task: any WKURLSchemeTask, url: URL?, status: Int, body: Data, meta: FileMeta? = nil, range: String? = nil) {
        guard let url else { return }
        var status = status, body = body
        var headers = [
            "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Content-Security-Policy": Self.contentSecurityPolicy,
            "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff",
        ]
        if let meta {
            let textual = meta.fileKind.isTextual || meta.contentType.hasPrefix("text/") || meta.contentType.contains("json") || meta.contentType.contains("svg")
            headers["Content-Type"] = meta.contentType + (textual ? "; charset=utf-8" : "")
            if let range, let slice = Self.slice(body, header: range) {
                status = 206; body = slice.data
                headers["Content-Range"] = "bytes \(slice.start)-\(slice.start + slice.data.count - 1)/\(meta.size)"
            }
        } else {
            headers["Content-Type"] = "text/plain; charset=utf-8"
        }
        headers["Content-Length"] = String(body.count)
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else { return }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    /// `bytes=a-b`, `bytes=a-` and `bytes=-n`; media elements seek with these.
    nonisolated static func slice(_ data: Data, header: String) -> (start: Int, data: Data)? {
        guard header.hasPrefix("bytes="), !data.isEmpty else { return nil }
        let parts = header.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let start: Int, end: Int
        if parts[0].isEmpty {
            guard let suffix = Int(parts[1]), suffix > 0 else { return nil }
            start = max(0, data.count - suffix); end = data.count - 1
        } else {
            guard let first = Int(parts[0]), first < data.count else { return nil }
            start = first; end = min(Int(parts[1]) ?? data.count - 1, data.count - 1)
        }
        guard end >= start else { return nil }
        return (start, data.subdata(in: data.startIndex.advanced(by: start)..<data.startIndex.advanced(by: end + 1)))
    }
}

@MainActor @Observable final class FileWebState {
    var progress = 0.0
    var loading = true
    var failure: String?
}

/// An HTML page in a sandbox: no persistent storage, no popups, no navigation
/// away from the page. Subresources may come from the computer or over https,
/// because dashboards load charting libraries from CDNs.
struct FileHTMLView: View {
    let file: LoadedFile
    let store: RemoteFileStore
    @State private var state = FileWebState()
    var body: some View {
        FileWebView(path: file.meta.path, store: store, state: state)
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .top) {
                if state.loading && state.progress < 1 { ProgressView(value: max(0.05, state.progress)).progressViewStyle(.linear).tint(FD.accent).transition(.opacity) }
            }
            .overlay { if let failure = state.failure { FileUnreadableNote(text: failure).background(FD.background) } }
            .accessibilityIdentifier("file-viewer-html")
    }
}

private struct FileWebView: UIViewRepresentable {
    @Environment(\.openFile) private var openFile
    let path: String
    let store: RemoteFileStore
    let state: FileWebState

    func makeCoordinator() -> Coordinator { Coordinator(state: state, path: path) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(FileSchemeHandler(store: store), forURLScheme: FileSchemeHandler.scheme)
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.limitsNavigationsToAppBoundDomains = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = UIColor(FD.surface)
        view.underPageBackgroundColor = UIColor(FD.surface)
        view.allowsBackForwardNavigationGestures = true
        view.isInspectable = false
        context.coordinator.observe(view)
        if let url = FileSchemeHandler.url(forPath: path) { view.load(URLRequest(url: url)) }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.openLocal = openFile
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let state: FileWebState
        let path: String
        var openLocal: @MainActor @Sendable (FileReference) -> Void = { _ in }
        private var progressObservation: NSKeyValueObservation?
        private var loadingObservation: NSKeyValueObservation?

        init(state: FileWebState, path: String) { self.state = state; self.path = path }

        func observe(_ view: WKWebView) {
            progressObservation = view.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
                let progress = view.estimatedProgress
                Task { @MainActor in self?.state.progress = progress }
            }
            loadingObservation = view.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
                let loading = view.isLoading
                Task { @MainActor in self?.state.loading = loading }
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            let userTapped = navigationAction.navigationType == .linkActivated
            let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            switch url.scheme?.lowercased() {
            case FileSchemeHandler.scheme:
                let target = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? ""
                if !mainFrame || target == path || navigationAction.navigationType == .other || navigationAction.navigationType == .reload {
                    // The page itself, its frames, and in-page anchors.
                    decisionHandler(.allow)
                } else if userTapped {
                    // Another file on the computer opens in its own viewer, whatever its type.
                    openLocal(FileReference(path: target))
                    decisionHandler(.cancel)
                } else { decisionHandler(.cancel) }
            case "about", "data", "blob":
                decisionHandler(.allow)
            case "https", "http":
                if userTapped, mainFrame { UIApplication.shared.open(url) }
                // Frames may load https content; the page itself never navigates away.
                decisionHandler(!mainFrame && url.scheme?.lowercased() == "https" ? .allow : .cancel)
            case "mailto", "tel":
                if userTapped { UIApplication.shared.open(url) }
                decisionHandler(.cancel)
            default:
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // target=_blank and window.open: a tapped web link goes to Safari, everything else is dropped.
            if let url = navigationAction.request.url, ["https", "mailto"].contains(url.scheme?.lowercased() ?? ""), navigationAction.navigationType == .linkActivated {
                UIApplication.shared.open(url)
            }
            return nil
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { fail(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { fail(error) }
        private func fail(_ error: any Error) {
            // A cancelled navigation is us blocking a link, not a broken page.
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            state.failure = "This page couldn't be displayed."
        }
    }
}
