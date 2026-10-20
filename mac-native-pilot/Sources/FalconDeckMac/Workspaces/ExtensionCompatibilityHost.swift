import AppKit
import SwiftUI
import WebKit

/// A narrow compatibility surface for compiled official React panels and owned
/// tool-result renderers. It receives no daemon URL or credentials, and a tool
/// renderer receives only its result, arguments and its extension's views.
struct NativeExtensionCompatibilityHost: NSViewRepresentable {
    static let supported: Set<String> = ["falcondeck.notes:library", "falcondeck.thread-tags:board"]
    static let registrations: [JSON] = {
        guard let url = resourceDirectory?.appendingPathComponent("registrations.json"),
              let data = try? Data(contentsOf: url), let value = try? JSON.decode(data) else { return [] }
        return value.array
    }()
    let store: AppStore
    let repository: NativeExtensionRepository
    let extensionID: String
    let panelID: String
    let appearance: String
    let appearanceSettings: JSON
    var toolResult: NativeExtensionToolResult? = nil
    var presentation: String = "inline"
    var hostID: String? = nil
    var onOpenDetails: (() -> Void)? = nil
    var onContentHeight: ((CGFloat) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "extension")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        context.coordinator.webView = webView
        if let directory = Self.resourceDirectory, FileManager.default.fileExists(atPath: directory.appendingPathComponent("index.html").path) {
            context.coordinator.resourceDirectory = directory
            webView.loadFileURL(directory.appendingPathComponent("index.html"), allowingReadAccessTo: directory)
        } else {
            repository.error = "The bundled extension frontend is missing. Rebuild the extension resources and the native app."
        }
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.updateData()
    }

    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        coordinator.prepareToClose(nsView)
    }

    private static var resourceDirectory: URL? {
        // SwiftPM owns this bundle both in development and the signed application.
        Bundle.module.url(forResource: "ExtensionResources", withExtension: nil)
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
        var parent: NativeExtensionCompatibilityHost
        weak var webView: WKWebView?
        var resourceDirectory: URL?
        private var ready = false
        private var closing = false
        private var lastPayload: JSON?
        private var scope: NativeExtensionBridgeScope { .init(hostID: parent.hostID) }
        private var identity: String {
            [parent.hostID ?? "local", parent.extensionID, parent.panelID, parent.toolResult?.id ?? "", parent.presentation].joined(separator: "\0")
        }

        init(_ parent: NativeExtensionCompatibilityHost) { self.parent = parent }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            ready = true
            updateData()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { parent.repository.error = error.localizedDescription }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { parent.repository.error = error.localizedDescription }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            ready = false
            lastPayload = nil
            webView.reload()
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if url.isFileURL, let resourceDirectory,
               url.standardizedFileURL == resourceDirectory.appendingPathComponent("index.html").standardizedFileURL {
                decisionHandler(.allow)
            } else {
                if navigationAction.navigationType == .linkActivated, ["https", "http"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
                decisionHandler(.cancel)
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
            guard message.frameInfo.isMainFrame,
                  let resourceDirectory,
                  message.frameInfo.request.url?.standardizedFileURL == resourceDirectory.appendingPathComponent("index.html").standardizedFileURL,
                  let data = try? JSONSerialization.data(withJSONObject: message.body), data.count <= 256 * 1024,
                  let request = try? JSON.decode(data) else {
                replyHandler(nil, "Invalid extension bridge request")
                return
            }
            if request["kind"].string == "ready" {
                ready = true
                updateData()
                replyHandler(NSNull(), nil)
                return
            }
            if request["kind"].string == "contentSize", parent.toolResult != nil {
                let height = request["height"].double
                if height.isFinite, height > 0 { parent.onContentHeight?(CGFloat(min(4096, max(64, height)))) }
                replyHandler(NSNull(), nil)
                return
            }
            if request["kind"].string == "renderFailure" {
                parent.repository.error = "This extension could not render its result. The ordinary tool result remains available in the transcript."
                replyHandler(NSNull(), nil)
                return
            }
            let requestIdentity = identity
            let store = parent.store
            let hostID = parent.hostID
            let extensionID = parent.extensionID
            Task {
                do {
                    // Recheck the daemon-owned catalog before each capability use.
                    let current = try await store.request(path: "/api/extensions", hostID: hostID)
                    // A panel may flush its final dirty draft while unmounting.
                    // Result renderers never gain a post-close capability.
                    guard requestIdentity == identity,
                          !closing || parent.toolResult == nil && request["kind"].string == "action" else { throw PilotError("This extension surface has closed.") }
                    guard let item = current["catalog"].array.first(where: { $0["id"].string == extensionID }), allowed(item) else {
                        throw PilotError("This extension surface is no longer enabled or granted.")
                    }
                    parent.repository.adopt(current)
                    switch request["kind"].string {
                    case "action":
                        let actionID = request["actionId"].string
                        let allowed = (item["contributes"]["panelActions"].array + item["contributes"]["threadMenuActions"].array).map { $0["id"].string }
                        guard allowed.contains(actionID) else { throw PilotError("The extension did not declare this action.") }
                        let response = try await store.request(path: "/api/extensions/\(extensionID)/actions/\(actionID)", method: "POST", body: .object(["input": request["input"], "target": request["target"]]), hostID: hostID)
                        guard requestIdentity == identity else { throw PilotError("This extension surface has changed.") }
                        if let refreshed = try? await store.request(path: "/api/extensions", hostID: hostID), requestIdentity == identity {
                            parent.repository.adopt(refreshed)
                        }
                        let projected = JSON.object(["result": response["result"], "updatedViews": .array(response["updated_views"].array.filter { $0["extension_id"].string == extensionID }.map(scope.appView))])
                        replyHandler(try JSONSerialization.jsonObject(with: projected.data(), options: .fragmentsAllowed), nil)
                    case "openThread":
                        let taskID = try scope.appID(request["threadId"].string)
                        let projectID = try scope.appID(request["workspaceId"].string)
                        guard parent.toolResult == nil, item["granted_permissions"].array.contains(.string("threads:read")),
                              parent.store.tasks.contains(where: { $0.id == taskID && $0.projectID == projectID }) else {
                            throw PilotError("This task is not available to the extension.")
                        }
                        await parent.store.selectTask(taskID)
                        replyHandler(NSNull(), nil)
                    case "startTask":
                        guard parent.toolResult == nil, parent.store.selectedHostID == hostID else { throw PilotError("Return to this extension's host before creating a task.") }
                        let draft = request["draft"].string
                        guard draft.count <= 128_000 else { throw PilotError("The proposed task is too large.") }
                        parent.store.newTask()
                        parent.store.draft = draft
                        parent.store.selectSection(parent.store.selectedProject?.raw["kind"].string == "casual" ? "chats" : "project")
                        replyHandler(NSNull(), nil)
                    case "settings":
                        guard parent.toolResult == nil else { throw PilotError("This result does not have settings access.") }
                        parent.store.selectSection("extensions")
                        replyHandler(NSNull(), nil)
                    case "openDetails":
                        guard parent.toolResult?.detailTitle != nil, let openDetails = parent.onOpenDetails else { throw PilotError("This result has no detail surface.") }
                        openDetails()
                        replyHandler(NSNull(), nil)
                    default: throw PilotError("Unknown extension bridge request")
                    }
                    updateData()
                } catch { replyHandler(nil, error.localizedDescription) }
            }
        }

        private func allowed(_ item: JSON) -> Bool {
            if let result = parent.toolResult {
                return NativeExtensionToolResultMatcher.allowed(item, extensionID: parent.extensionID, toolID: result.toolID,
                                                                registrations: NativeExtensionCompatibilityHost.registrations)
            }
            return item["enabled"].bool && item["bundled"].bool
                && NativeExtensionCompatibilityHost.supported.contains(parent.extensionID + ":" + parent.panelID)
                && item["contributes"]["panels"].array.contains(where: { $0["id"].string == parent.panelID })
        }

        func prepareToClose(_ webView: WKWebView) {
            closing = true
            // Retain this leaf host while the official frontend flushes its
            // dirty Notes draft; navigation never discards a debounce-window edit.
            Task { [self, webView] in
                _ = try? await webView.callAsyncJavaScript("await window.falconDeckPanelPrepareToClose?.()", in: nil, contentWorld: .page)
                webView.configuration.userContentController.removeScriptMessageHandler(forName: "extension", contentWorld: .page)
                webView.navigationDelegate = nil
                self.webView = nil
            }
        }

        func updateData() {
            guard ready, !closing, let webView else { return }
            guard let item = parent.repository.catalog.first(where: { $0["id"].string == parent.extensionID }) else { return }
            guard allowed(item) else { return }
            let permissions = item["granted_permissions"].array
            let canRead = parent.toolResult == nil && permissions.contains(.string("threads:read"))
            let threads: [JSON] = canRead ? parent.store.tasks.filter { NativeHostManager.split($0.id).hostID == parent.hostID }.sorted { $0.updatedAt > $1.updatedAt }.prefix(1000).map { task in
                .object([
                    "id": .string(scope.localID(task.id)), "workspaceId": .string(scope.localID(task.projectID)),
                    "title": .string(String(task.title.prefix(256))), "status": .string(task.status),
                    "updatedAt": .string(task.updatedAt),
                    "pendingApprovalCount": task.raw["attention"]["pending_approval_count"],
                    "pendingQuestionCount": task.raw["attention"]["pending_question_count"]
                ])
            } : []
            let workspaces: [JSON] = canRead ? parent.store.allProjects.filter { NativeHostManager.split($0.id).hostID == parent.hostID }.map { project in
                .object(["id": .string(scope.localID(project.id)), "name": .string(project.name), "kind": project.raw["kind"]])
            } : []
            let views = parent.repository.snapshot["views"].array.filter { $0["extension_id"].string == parent.extensionID }.map(scope.appView)
            var payload = JSON.object([
                "extensionId": .string(parent.extensionID), "panelId": .string(parent.panelID),
                "permissions": .array(permissions), "threads": .array(threads), "workspaces": .array(workspaces),
                "views": .array(views), "appearance": .string(parent.appearance), "appearanceSettings": parent.appearanceSettings
            ])
            if let result = parent.toolResult {
                payload = payload.setting("toolResult", .object([
                    "toolId": .string(result.toolID), "arguments": result.arguments, "result": result.result,
                    "presentation": .string(parent.presentation), "canOpenDetails": .bool(parent.onOpenDetails != nil)
                ]))
            }
            guard payload != lastPayload else { return }
            do {
                let value = try JSONSerialization.jsonObject(with: payload.data())
                lastPayload = payload
                webView.callAsyncJavaScript("window.falconDeckPanelUpdate(payload)", arguments: ["payload": value], in: nil, in: .page) { [weak self] result in
                    if case .failure(let error) = result {
                        self?.lastPayload = nil
                        self?.parent.repository.error = error.localizedDescription
                    }
                }
            } catch { parent.repository.error = error.localizedDescription }
        }
    }
}
