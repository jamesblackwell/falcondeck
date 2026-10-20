import AppKit
import Observation
import SwiftUI

extension Notification.Name {
    static let nativeTerminalNewTab = Notification.Name("FalconDeck.nativeTerminalNewTab")
    static let nativeTerminalFind = Notification.Name("FalconDeck.nativeTerminalFind")
}

@MainActor @Observable private final class NativeTerminalPanelModel {
    var workspaceID: String?
    var selected: [String: String] = [:]
    var sessions: [String: [NativeTerminalSession]] = [:]
    var loading = false
    var creating = false
    var error: String?
    @ObservationIgnored private var creatingScopes: Set<String> = []
    @ObservationIgnored private var loadToken = UUID()

    var tabs: [NativeTerminalSession] { workspaceID.flatMap { sessions[$0] } ?? [] }
    var active: NativeTerminalSession? {
        guard let workspaceID else { return nil }
        return tabs.first { $0.id == selected[workspaceID] } ?? tabs.last
    }

    func load(_ workspaceID: String?, store: AppStore) async {
        let workspaceID = store.selectedHostID == nil ? workspaceID : nil
        if self.workspaceID != workspaceID {
            tabs.forEach { $0.detach() }
        }
        self.workspaceID = workspaceID
        loadToken = UUID()
        let token = loadToken
        error = nil
        loading = workspaceID != nil
        creating = workspaceID.map { creatingScopes.contains($0) } ?? false
        guard let workspaceID else { return }
        do {
            let response = try await store.request(["api", "workspaces", workspaceID, "terminals"])
            try Task.checkCancellation()
            guard loadToken == token, store.selectedHostID == nil, self.workspaceID == workspaceID else { return }
            let infos = response["sessions"].array.compactMap(NativeTerminalInfo.init)
            let previous = sessions[workspaceID] ?? []
            let restored = infos.map { info in previous.first { $0.id == info.id } ?? NativeTerminalSession(info: info) }
            let disappeared = previous.filter { old in !infos.contains { $0.id == old.id } }
            for session in disappeared where session.status != .exited {
                session.detach()
                session.markExited("This terminal is no longer running.")
            }
            sessions[workspaceID] = restored + disappeared
            for session in restored { session.attach { try await store.daemonEndpoint() } }
            loading = false
            if tabs.isEmpty, store.terminalCreationRequest == nil { await create(store: store) }
        } catch {
            guard loadToken == token, !Task.isCancelled else { return }
            loading = false
            self.error = "Couldn’t load terminals. \(error.localizedDescription)"
        }
    }

    func create(store: AppStore) async {
        guard store.selectedHostID == nil, let workspaceID, !loading, !creatingScopes.contains(workspaceID) else { return }
        creatingScopes.insert(workspaceID)
        creating = true
        error = nil
        defer {
            creatingScopes.remove(workspaceID)
            if self.workspaceID == workspaceID { creating = false }
        }
        do {
            let result = try await store.request(["api", "workspaces", workspaceID, "terminals"], method: "POST", body: .object([
                "cols": .number(100), "rows": .number(24)
            ]))
            guard let info = NativeTerminalInfo(result["session"]) else { throw PilotError("The daemon returned an invalid terminal.") }
            let session = NativeTerminalSession(info: info)
            sessions[workspaceID, default: []].append(session)
            selected[workspaceID] = session.id
            if self.workspaceID == workspaceID, store.selectedHostID == nil {
                session.attach { try await store.daemonEndpoint() }
            }
        } catch {
            if self.workspaceID == workspaceID { self.error = "Couldn’t start a terminal. \(error.localizedDescription)" }
        }
    }

    func close(_ session: NativeTerminalSession, store: AppStore) async {
        guard store.selectedHostID == nil else { return }
        do {
            _ = try await store.request(["api", "terminals", session.id, "close"], method: "POST")
        } catch {
            // An exited shell is already absent from the daemon. Removing its
            // local tab is still a valid close; live failures stay reviewable.
            if session.status != .exited { self.error = "Couldn’t close terminal. \(error.localizedDescription)"; return }
        }
        session.detach()
        let workspace = session.info.workspaceID
        let previous = sessions[workspace] ?? []
        let index = previous.firstIndex { $0.id == session.id } ?? 0
        let remaining = previous.filter { $0.id != session.id }
        sessions[workspace] = remaining
        if selected[workspace] == session.id || selected[workspace] == nil {
            selected[workspace] = remaining.isEmpty ? nil : remaining[min(index, remaining.count - 1)].id
        }
    }

    func cycle(_ offset: Int) {
        guard let workspaceID, !tabs.isEmpty else { return }
        let index = tabs.firstIndex { $0.id == active?.id } ?? 0
        selected[workspaceID] = tabs[(index + offset + tabs.count) % tabs.count].id
    }

    func select(_ index: Int) {
        guard let workspaceID, tabs.indices.contains(index) else { return }
        selected[workspaceID] = tabs[index].id
    }

    func detach() { sessions.values.flatMap { $0 }.forEach { $0.detach() } }
}

/// A native VT100/xterm surface backed exclusively by daemon-owned PTYs.
/// Hiding the panel detaches its sockets; it never terminates a shell.
struct NativeTerminalPanel: View {
    let store: AppStore
    var onHide: (() -> Void)? = nil
    @State private var model = NativeTerminalPanelModel()

    private var isRemote: Bool { store.selectedHostID != nil }
    private var workspaceID: String? { isRemote ? nil : store.selectedTask?.projectID ?? store.selectedProject?.id }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("TERMINAL").font(NativePreferences.shared.font(size: 11, surface: "ui", weight: .semibold)).foregroundStyle(FDTheme.muted)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(isRemote ? [] : model.tabs) { session in terminalTab(session) }
                    }
                }
                Button { if !isRemote { model.active?.terminal.showFind() } } label: { Image(systemName: "magnifyingglass") }
                    .buttonStyle(NativeIconButtonStyle())
                    .help(commandHelp("Find in Terminal", command: "findInThread"))
                    .accessibilityLabel("Find in terminal")
                    .disabled(isRemote || model.active == nil)
                Button { Task { await model.create(store: store) } } label: { Image(systemName: "plus") }
                    .buttonStyle(NativeIconButtonStyle())
                    .help(commandHelp("New Terminal", command: "terminalNewTab"))
                    .accessibilityLabel("New terminal")
                    .disabled(workspaceID == nil || model.loading || model.creating)
                if let onHide {
                    Button(action: onHide) { Image(systemName: "rectangle.bottomthird.inset.filled") }
                        .buttonStyle(NativeIconButtonStyle())
                        .help(commandHelp("Hide Terminal", command: "toggleTerminal"))
                        .accessibilityLabel("Hide terminal")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(FDTheme.surface)
            Divider().overlay(FDTheme.hairline)

            if let error = model.error {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                    Text(error).textSelection(.enabled)
                    Spacer()
                    Button("Retry") { Task { await model.load(workspaceID, store: store) } }
                }
                .font(NativePreferences.shared.font(size: 13, surface: "ui"))
                .foregroundStyle(FDTheme.warning)
                .padding(10)
                .background(FDTheme.raised)
            }

            if isRemote {
                VStack(spacing: 10) {
                    Image(systemName: "terminal").font(.system(size: 24, weight: .light))
                    Text("Remote terminals aren’t available over this server connection.")
                        .multilineTextAlignment(.center)
                }
                .font(NativePreferences.shared.font(size: 13, surface: "ui")).foregroundStyle(FDTheme.muted)
                .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let active = model.active {
                NativeTerminalSurface(session: active, model: model, appearance: NativeCodeTypography.signature)
                    .id(active.id)
                    .overlay(alignment: .topTrailing) {
                        if active.status == .connecting || active.status == .reconnecting {
                            Label(active.status.rawValue, systemImage: "network")
                                .font(NativePreferences.shared.font(size: 12, surface: "ui")).foregroundStyle(FDTheme.muted)
                                .padding(6).background(FDTheme.raised, in: .rect(cornerRadius: 6)).padding(8)
                                .help(active.detail ?? "Connecting to your project’s terminal.")
                        }
                    }
            } else {
                VStack(spacing: 10) {
                    if model.loading || model.creating {
                        MacActivityDiamond()
                        Text("Starting terminal…")
                    } else if workspaceID == nil {
                        Image(systemName: "terminal").font(.system(size: 24, weight: .light))
                        Text("Select a project to open a terminal.")
                    } else {
                        Button("New Terminal") { Task { await model.create(store: store) } }
                    }
                }
                .font(NativePreferences.shared.font(size: 13, surface: "ui"))
                .foregroundStyle(FDTheme.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(FDTheme.background)
        .frame(minHeight: 120)
        .task(id: workspaceID) {
            await model.load(workspaceID, store: store)
            await consumeCreationRequest()
        }
        .onChange(of: store.terminalCreationRequest) { _, request in
            if request != nil { Task { await consumeCreationRequest() } }
        }
        .onChange(of: model.creating) { _, creating in
            if !creating { Task { await consumeCreationRequest() } }
        }
        .onDisappear { model.detach() }
        .onReceive(NotificationCenter.default.publisher(for: .nativeTerminalNewTab)) { _ in
            Task { await model.create(store: store) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .nativeTerminalFind)) { _ in
            if !isRemote { model.active?.terminal.showFind() }
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("native.command"))) { note in
            handleCommand(note)
        }
    }

    private func consumeCreationRequest() async {
        guard store.terminalCreationRequest != nil else { return }
        guard !isRemote, let workspaceID else {
            store.terminalCreationRequest = nil
            return
        }
        guard !model.loading, !model.creating, model.workspaceID == workspaceID else { return }
        // Clear before awaiting the POST: observation and a concurrent command
        // must not replay this request against an existing terminal tab.
        store.terminalCreationRequest = nil
        await model.create(store: store)
    }

    private func handleCommand(_ note: Notification) {
        guard !isRemote, let command = note.object as? String else { return }
        switch command {
        case "newTerminal":
            // The persistent request also covers the event arriving before the
            // panel mounts, or while its existing tabs are being restored.
            Task { await consumeCreationRequest() }
        case "terminalNewTab":
            guard note.userInfo?["context"] as? String == "terminal" else { return }
            Task { await model.create(store: store) }
        case "terminalCloseTab":
            guard note.userInfo?["context"] as? String == "terminal", let active = model.active else { return }
            Task {
                await model.close(active, store: store)
                if model.workspaceID == active.info.workspaceID, model.tabs.isEmpty { onHide?() }
            }
        case "terminalNextTab", "terminalPreviousTab":
            guard note.userInfo?["context"] as? String == "terminal" else { return }
            model.cycle(command == "terminalNextTab" ? 1 : -1)
        case "findInThread":
            guard note.userInfo?["context"] as? String == "terminal" else { return }
            model.active?.terminal.showFind()
        default: break
        }
    }

    private func commandHelp(_ label: String, command: String) -> String {
        guard let binding = NativePreferences.shared.bindings(for: command).first else { return label }
        return "\(label) (\(NativeShortcutDefinition.display(binding)))"
    }

    private func terminalTab(_ session: NativeTerminalSession) -> some View {
        HStack(spacing: 4) {
            Button {
                if let workspaceID { model.selected[workspaceID] = session.id }
            } label: {
                HStack(spacing: 6) {
                    Circle().fill(session.status == .exited ? FDTheme.subtle : FDTheme.accent).frame(width: 5, height: 5)
                    Text(session.title).lineLimit(1).frame(maxWidth: 150)
                    if session.status == .exited { Text("exited").foregroundStyle(FDTheme.subtle) }
                }
                .font(NativePreferences.shared.font(size: 12, surface: "ui"))
                .foregroundStyle(model.active?.id == session.id ? FDTheme.foreground : FDTheme.muted)
                .padding(.vertical, 5).padding(.leading, 8)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help(session.info.cwd)
            Button {
                Task {
                    await model.close(session, store: store)
                    if model.workspaceID == session.info.workspaceID, model.tabs.isEmpty { onHide?() }
                }
            } label: { Image(systemName: "xmark").font(.system(size: 9)) }
            .buttonStyle(.plain)
            .foregroundStyle(FDTheme.muted)
            .padding(.trailing, 6)
            .help("Close Terminal")
            .accessibilityLabel("Close \(session.title)")
        }
        .background(model.active?.id == session.id ? FDTheme.raised : Color.clear, in: .rect(cornerRadius: 6))
    }
}

private struct NativeTerminalSurface: NSViewRepresentable {
    let session: NativeTerminalSession
    let model: NativeTerminalPanelModel
    let appearance: String

    func makeNSView(context: Context) -> NativePTYView {
        configure()
        DispatchQueue.main.async { session.focus() }
        return session.terminal
    }

    func updateNSView(_ nsView: NativePTYView, context: Context) {
        configure()
        session.applyTheme()
    }

    private func configure() {
        session.terminal.selectTab = { [weak model] in model?.select($0) }
    }
}
