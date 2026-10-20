import AppKit
import Foundation
import Observation
import SwiftTerm

struct NativeTerminalInfo: Identifiable, Sendable {
    let id: String
    let workspaceID: String
    let title: String
    let cwd: String

    init?(_ raw: JSON) {
        guard !raw["id"].string.isEmpty else { return nil }
        id = raw["id"].string
        workspaceID = raw["workspace_id"].string
        title = raw["title"].string.isEmpty ? "Shell" : raw["title"].string
        cwd = raw["cwd"].string
    }
}

/// Protocol replies generated while replaying old output must never be sent
/// back to a live shell. Keyboard input uses a separate SwiftTerm path.
private final class TerminalReplayGate: @unchecked Sendable {
    private let lock = NSLock()
    private var suppressed = false

    var isSuppressed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return suppressed
    }

    func whileSuppressed(_ body: () -> Void) {
        lock.lock()
        suppressed = true
        lock.unlock()
        defer {
            lock.lock()
            suppressed = false
            lock.unlock()
        }
        body()
    }
}

@MainActor final class NativePTYView: SwiftTerm.TerminalView {
    nonisolated private let replayGate = TerminalReplayGate()
    private var keyMonitor: Any?
    var selectTab: ((Int) -> Void)?

    nonisolated override func send(source: SwiftTerm.Terminal, data: ArraySlice<UInt8>) {
        guard !replayGate.isSuppressed else { return }
        super.send(source: source, data: data)
    }

    func render(_ output: NativeTerminalOutput) {
        let bytes = [UInt8](output.bytes)
        if output.replay { replayGate.whileSuppressed { feed(byteArray: bytes[...]) } }
        else { feed(byteArray: bytes[...]) }
    }

    deinit { if let keyMonitor { NSEvent.removeMonitor(keyMonitor) } }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor); self.keyMonitor = nil }
        if window != nil {
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self else { return event }
                return self.handleShortcut(event) ? nil : event
            }
        }
    }

    private func handleShortcut(_ event: NSEvent) -> Bool {
        // Only intercept while focus is within this terminal, so app-wide
        // commands retain their usual meaning in the composer and sidebars.
        guard event.window === window, let responder = window?.firstResponder as? NSView,
              responder === self || responder.isDescendant(of: self) else {
            return false
        }
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if let input = responder as? NSTextInputClient, input.hasMarkedText() { return false }
        if let binding = NativeShortcutDefinition.binding(from: event),
           NativeShortcutDefinition.all.contains(where: {
               ["terminal", "global"].contains($0.context)
                   && NativePreferences.shared.bindings(for: $0.id).contains(binding)
           }) { return false }
        // Configurable commands are handled once by NativeCommandDispatcher.
        // Direct numbered tab selection is a separate native convenience.
        if modifiers == .command, let number = Int(key), (1...9).contains(number) {
            selectTab?(number - 1)
            return true
        }
        return false
    }

    func showFind() {
        let item = NSMenuItem()
        item.tag = NSTextFinder.Action.showFindInterface.rawValue
        performTextFinderAction(item)
    }
}

@MainActor @Observable final class NativeTerminalSession: NSObject, Identifiable, TerminalViewDelegate {
    enum Status: String { case connecting = "Connecting", connected = "Running", reconnecting = "Reconnecting", exited = "Exited" }
    let info: NativeTerminalInfo
    nonisolated let id: String
    private(set) var title: String
    private(set) var status = Status.connecting
    private(set) var detail: String?
    @ObservationIgnored let terminal: NativePTYView
    @ObservationIgnored private var connectionTask: Task<Void, Never>?
    @ObservationIgnored private var heartbeatTask: Task<Void, Never>?
    @ObservationIgnored private var inputTask: Task<Void, Never>?
    @ObservationIgnored private var resizeTask: Task<Void, Never>?
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var sequence = NativeTerminalSequence()
    @ObservationIgnored private var identity = UUID()
    @ObservationIgnored private var columns = 100
    @ObservationIgnored private var rows = 24

    init(info: NativeTerminalInfo) {
        self.info = info
        id = info.id
        title = info.title
        terminal = NativePTYView(frame: .zero, font: NativeCodeTypography.font(size: 14))
        super.init()
        terminal.terminalDelegate = self
        terminal.setAccessibilityLabel("Terminal, \(info.cwd)")
        applyTheme()
    }

    deinit {
        connectionTask?.cancel()
        heartbeatTask?.cancel()
        inputTask?.cancel()
        resizeTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    func applyTheme() {
        let font = NativeCodeTypography.font(size: 14)
        if terminal.font != font { terminal.font = font }
        terminal.nativeBackgroundColor = NSColor(FDTheme.background)
        terminal.nativeForegroundColor = NSColor(FDTheme.foreground)
        terminal.caretColor = NSColor(FDTheme.accent)
    }

    func attach(endpoint: @escaping @MainActor () async throws -> URL) {
        guard connectionTask == nil, status != .exited else { return }
        identity = UUID()
        let token = identity
        connectionTask = Task { [weak self] in
            var retry = 0
            while !Task.isCancelled {
                guard let self, self.identity == token, self.status != .exited else { return }
                do {
                    let base = try await endpoint()
                    try Task.checkCancellation()
                    guard self.identity == token else { return }
                    let url = DaemonClient.apiURL(base: base, path: ["api", "terminals", self.id, "ws"], query: [
                        URLQueryItem(name: "since_seq", value: String(self.sequence.resumeFrom))
                    ])
                    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                        throw PilotError("The terminal address is invalid.")
                    }
                    components.scheme = base.scheme == "https" ? "wss" : "ws"
                    guard let socketURL = components.url else { throw PilotError("The terminal address is invalid.") }
                    var request = URLRequest(url: socketURL)
                    request.setValue("tauri://localhost", forHTTPHeaderField: "Origin")
                    let ws = URLSession.shared.webSocketTask(with: request)
                    ws.maximumMessageSize = 8 * 1024 * 1024
                    self.socket = ws
                    ws.resume()
                    self.startHeartbeat(ws, token: token)
                    var bytesSinceYield = 0
                    while !Task.isCancelled, self.identity == token, self.status != .exited {
                        let message = try await ws.receive()
                        guard self.identity == token else { return }
                        switch message {
                        case .data(let data):
                            if let output = NativeTerminalOutput.decode(data) {
                                self.apply(output)
                                bytesSinceYield += output.bytes.count
                            }
                        case .string(let text):
                            let frame = try JSON.decode(Data(text.utf8))
                            self.applyControl(frame)
                            if frame["type"].string == "terminal_attached" {
                                retry = 0
                                self.resizeNow()
                            }
                        @unknown default: break
                        }
                        if bytesSinceYield >= 64 * 1024 {
                            bytesSinceYield = 0
                            await Task.yield()
                        }
                    }
                    ws.cancel(with: .goingAway, reason: nil)
                    self.heartbeatTask?.cancel()
                    self.socket = nil
                    if self.status == .exited { self.connectionTask = nil; return }
                } catch {
                    guard !Task.isCancelled, self.identity == token else { return }
                    self.heartbeatTask?.cancel()
                    self.socket?.cancel(with: .goingAway, reason: nil)
                    self.socket = nil
                    self.status = .reconnecting
                    self.detail = error.localizedDescription
                }
                retry = min(retry + 1, 5)
                do { try await Task.sleep(for: .seconds(min(Double(retry), 5))) }
                catch { return }
            }
        }
    }

    /// Detaching a view leaves the daemon-owned PTY running for later replay.
    func detach() {
        identity = UUID()
        connectionTask?.cancel()
        connectionTask = nil
        heartbeatTask?.cancel()
        inputTask?.cancel()
        resizeTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        if status != .exited { status = .connecting }
    }

    func focus() {
        terminal.window?.makeFirstResponder(terminal)
        let dimensions = terminal.terminalDimensions
        columns = dimensions.cols
        rows = dimensions.rows
        resizeNow()
    }

    func markExited(_ message: String) {
        guard status != .exited else { return }
        status = .exited
        detail = message
        terminal.feed(text: "\r\n\u{1b}[2m\(message)\u{1b}[0m\r\n")
    }

    private func apply(_ output: NativeTerminalOutput) {
        switch sequence.accept(output.sequence) {
        case .duplicate: return
        case .gap:
            terminal.resetToInitialState()
            terminal.feed(text: "\r\nSome terminal output was unavailable.\r\n")
        case .append: break
        }
        terminal.render(output)
    }

    private func applyControl(_ frame: JSON) {
        switch frame["type"].string {
        case "terminal_attached": status = .connected; detail = nil
        case "terminal_exited":
            let code = frame["exit_code"]
            let suffix: String
            if case .number(let value) = code { suffix = " with code \(Int(value))" }
            else { suffix = "" }
            markExited("Terminal exited\(suffix).")
        case "terminal_error": markExited(frame["message"].string)
        case "terminal_output", "terminal_replay":
            if let data = Data(base64Encoded: frame["chunk"]["data_base64"].string),
               let value = frame["chunk"]["seq"].optionalInt {
                apply(.init(replay: frame["type"].string == "terminal_replay", sequence: UInt64(value), bytes: data))
            }
        default: break
        }
    }

    private func startHeartbeat(_ ws: URLSessionWebSocketTask, token: UUID) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) }
                catch { return }
                guard let self, self.identity == token else { return }
                ws.sendPing { error in
                    if error != nil { ws.cancel(with: .goingAway, reason: nil) }
                }
            }
        }
    }

    private func transmit(_ message: URLSessionWebSocketTask.Message) {
        guard status == .connected, let socket else { return }
        let previous = inputTask
        let token = identity
        inputTask = Task { [weak self] in
            await previous?.value
            guard !Task.isCancelled, let self, self.identity == token else { return }
            do { try await socket.send(message) }
            catch {
                guard self.identity == token else { return }
                self.detail = "Terminal input could not be delivered. Reconnecting…"
                socket.cancel(with: .goingAway, reason: nil)
            }
        }
    }

    private func resizeNow() {
        guard columns >= 2, rows >= 1 else { return }
        let frame = JSON.object(["type": .string("terminal_resize"), "cols": .number(Double(columns)), "rows": .number(Double(rows))])
        guard let data = try? frame.data(), let text = String(data: data, encoding: .utf8) else { return }
        transmit(.string(text))
    }

    func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
        columns = min(max(newCols, 2), 65535)
        rows = min(max(newRows, 1), 65535)
        resizeTask?.cancel()
        resizeTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(32)) }
            catch { return }
            self?.resizeNow()
        }
    }

    func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
        // Serializing writes preserves the byte order of rapid keystrokes,
        // mouse reporting and bracketed paste without retrying uncertain input.
        transmit(.data(NativeTerminalOutput.input(Data(data))))
    }

    func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !clean.isEmpty { self.title = String(clean.prefix(160)) }
    }
    func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
    func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
    func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}
    func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
        NSWorkspace.shared.open(url)
    }
}
