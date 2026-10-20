import Darwin
import Foundation

/// Owns an embedded Rust daemon only when no existing FalconDeck runtime is
/// available. Attaching never transfers lifecycle ownership to the native app.
actor NativeRuntime {
    static let shared = NativeRuntime()

    private var baseURL: URL?
    private var ownsRuntime = false
    private var library: NativeRuntimeLibrary?
    private var startup: Task<URL, Error>?

    func endpoint() async throws -> URL {
        if let baseURL, await Self.isHealthy(baseURL) { return baseURL }
        if let startup { return try await startup.value }
        let startup = Task { try await self.connectOrStart() }
        self.startup = startup
        defer { self.startup = nil }
        return try await startup.value
    }

    func isOwned() -> Bool { ownsRuntime }

    func activeThreadCount() async -> Int {
        guard ownsRuntime, let library else { return 0 }
        return (try? await Task.detached { try library.status()["active_threads"].int }.value) ?? 0
    }

    func shutdown() async throws {
        if let startup {
            startup.cancel()
            _ = try? await startup.value
        }
        startup = nil
        guard ownsRuntime, let library else { return }
        try await Task.detached { _ = try library.shutdown() }.value
        ownsRuntime = false
        baseURL = nil
    }

    private func connectOrStart() async throws -> URL {
        if ownsRuntime, let library {
            let result = try await Task.detached { try library.status() }.value
            if let url = URL(string: result["base_url"].string), await Self.isHealthy(url) {
                baseURL = url
                return url
            }
            throw PilotError("The embedded daemon stopped responding. Quit and reopen FalconDeck Native to recover.")
        }
        // An explicit address is an intentional attach. Failure must not start
        // a different runtime or silently switch the selected daemon.
        if let value = ProcessInfo.processInfo.environment["FALCONDECK_DAEMON_URL"], !value.isEmpty {
            guard let supplied = URL(string: value) else { throw PilotError("The local daemon address is invalid.") }
            let url = try DaemonClient.validateEndpoint(supplied)
            guard await Self.isHealthy(url) else { throw PilotError("The configured FalconDeck daemon is unavailable or incompatible.") }
            baseURL = url
            return url
        }

        let customStatePath = ProcessInfo.processInfo.environment["FALCONDECK_STATE_PATH"].flatMap { $0.isEmpty ? nil : $0 }
        let defaultStateDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".falcondeck", isDirectory: true).resolvingSymlinksInPath()
        let customStateDirectory = customStatePath.map {
            URL(fileURLWithPath: $0).deletingLastPathComponent().resolvingSymlinksInPath()
        }
        let isolatedStateDirectory = customStateDirectory.map { $0 != defaultStateDirectory } ?? false
        // A launch that is still starting, or a live runtime whose health probe
        // fails, is not evidence that its persisted state is safe to take over.
        // The shared Rust state lock is the final guard for new daemon builds;
        // this process check also protects already-installed older Tauri apps.
        // A separate state directory requests an isolated runtime. Auxiliary
        // stores share the state directory, so a different filename alone is
        // not sufficient isolation from the installed app's persisted state.
        for attempt in 0..<(isolatedStateDirectory ? 0 : 20) {
            try Task.checkCancellation()
            let discovery = try await Task.detached { try Self.discoverProcesses() }.value
            var candidates = discovery.listeners
            if let defaultURL = URL(string: "http://127.0.0.1:4123"), !candidates.contains(defaultURL) {
                candidates.append(defaultURL)
            }
            for url in candidates where await Self.isHealthy(url) {
                baseURL = url
                return url
            }
            if !discovery.hasOtherRuntime { break }
            if attempt == 19 {
                throw PilotError("Another FalconDeck runtime is starting or unavailable. Reconnect after it is ready, or quit that app before starting the native runtime.")
            }
            try await Task.sleep(for: .milliseconds(500))
        }

        try Task.checkCancellation()
        let library = try NativeRuntimeLibrary.load()
        self.library = library
        var config: [String: JSON] = [
            "computer_use_host_bundle_id": .string(Bundle.main.bundleIdentifier ?? "com.falcondeck.mac-native-pilot")
        ]
        let executableDirectory = Bundle.main.executableURL?.deletingLastPathComponent()
        for (name, key) in [("deno", "deno_bin"), ("cua-driver", "computer_use_bin")] {
            if let url = executableDirectory?.appendingPathComponent(name), FileManager.default.isExecutableFile(atPath: url.path) {
                config[key] = .string(url.path)
            }
        }
        if let path = customStatePath {
            config["state_path"] = .string(path)
        }
        let payload = try JSON.object(config).data()
        let result = try await Task.detached { try library.start(String(decoding: payload, as: UTF8.self)) }.value
        guard result["owned"].bool, let url = URL(string: result["base_url"].string) else {
            throw PilotError("The native runtime returned an invalid endpoint.")
        }
        ownsRuntime = true
        baseURL = try DaemonClient.validateEndpoint(url)
        guard await Self.isHealthy(url) else { throw PilotError("The native daemon started but did not become ready.") }
        return url
    }

    nonisolated static func dispatchHelperIfNeeded() -> Int32? {
        guard let argument = CommandLine.arguments.dropFirst().first,
              argument == "mcp" || argument.hasPrefix("mcp-") else { return nil }
        do { return try NativeRuntimeLibrary.load().dispatchHelper() }
        catch {
            fputs("falcondeck: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }

    nonisolated private static func isHealthy(_ url: URL) async -> Bool {
        guard (try? DaemonClient.validateEndpoint(url)) != nil else { return false }
        var request = URLRequest(url: url.appendingPathComponent("api/health"))
        request.timeoutInterval = 1.5
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            let health = try JSON.decode(data)
            // The current daemon API has a fixed protocol generation distinct
            // from the app release number. Do not attach to an unknown schema.
            return health["ok"].bool && health["version"].string == "0.1.0" && health["workspaces"].optionalInt != nil
        } catch { return false }
    }

    nonisolated private static func discoverProcesses() throws -> (listeners: [URL], hasOtherRuntime: Bool) {
        let output = try commandOutput("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], allowEmptyResult: true)
        let listeners = listenerCandidates(from: output)
        let processOutput = try commandOutput("/bin/ps", ["-axo", "pid=,comm="])
        let argumentsOutput = try commandOutput("/bin/ps", ["-axww", "-o", "pid=,args="])
        let ownPID = ProcessInfo.processInfo.processIdentifier
        return (listeners, hasOtherRuntime(processes: processOutput, arguments: argumentsOutput, ownPID: ownPID))
    }

    nonisolated static func hasOtherRuntime(processes: String, arguments: String, ownPID: Int32) -> Bool {
        func records(_ output: String) -> [(Int32, String)] {
            output.split(separator: "\n").compactMap { line in
                let parts = line.trimmingCharacters(in: .whitespaces).split(maxSplits: 1, whereSeparator: \.isWhitespace)
                guard parts.count == 2, let pid = Int32(parts[0]) else { return nil }
                return (pid, String(parts[1]))
            }
        }
        let argumentsByPID = Dictionary(records(arguments), uniquingKeysWith: { _, newer in newer })
        let names: Set<String> = ["falcondeck-desktop", "falcondeck-daemon", "FalconDeck", "FalconDeckMac"]
        return records(processes).contains { pid, executable in
            let name = URL(fileURLWithPath: executable).lastPathComponent
            guard pid != ownPID, names.contains(name) else { return false }
            // MCP helpers execute the app binary but own no daemon. A crashed
            // shell can leave these children alive; they must not block recovery.
            // Keep unknown/racing process records conservative for older shells.
            guard let arguments = argumentsByPID[pid] else { return true }
            for invocation in [executable, name] where arguments.hasPrefix(invocation + " ") {
                let firstArgument = arguments.dropFirst(invocation.count)
                    .split(whereSeparator: \.isWhitespace).first.map(String.init)
                return firstArgument != "mcp" && !(firstArgument?.hasPrefix("mcp-") ?? false)
            }
            return true
        }
    }

    nonisolated static func listenerCandidates(from output: String) -> [URL] {
        var recognized = false
        var result: [URL] = []
        let names: Set<String> = ["falcondeck-desktop", "falcondeck-daemon", "FalconDeck", "FalconDeckMac"]
        for line in output.split(separator: "\n") {
            switch line.first {
            case "p": recognized = false
            case "c": recognized = names.contains(String(line.dropFirst()))
            case "n" where recognized:
                let address = String(line.dropFirst())
                guard address.hasPrefix("127.0.0.1:") || address.hasPrefix("[::1]:"),
                      let url = URL(string: "http://" + address),
                      let validated = try? DaemonClient.validateEndpoint(url), !result.contains(validated) else { continue }
                result.append(validated)
            default: break
            }
        }
        return result
    }

    nonisolated private static func commandOutput(_ executable: String, _ arguments: [String], allowEmptyResult: Bool = false) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 || (allowEmptyResult && process.terminationStatus == 1),
              allowEmptyResult || !data.isEmpty else {
            throw PilotError("FalconDeck could not verify whether another runtime is running. Reconnect before starting the native daemon.")
        }
        return String(decoding: data, as: UTF8.self)
    }
}

/// Dynamically linked so `swift test` and an attaching development client do not
/// require a Rust build. Packaged apps always include and sign the host library.
private final class NativeRuntimeLibrary: @unchecked Sendable {
    private typealias Start = @convention(c) (UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?
    private typealias Call = @convention(c) () -> UnsafeMutablePointer<CChar>?
    private typealias Free = @convention(c) (UnsafeMutablePointer<CChar>?) -> Void
    private typealias Helper = @convention(c) () -> Int32

    private let handle: UnsafeMutableRawPointer
    private let startFunction: Start
    private let statusFunction: Call
    private let shutdownFunction: Call
    private let freeFunction: Free
    private let helperFunction: Helper

    static func load() throws -> NativeRuntimeLibrary {
        let override = ProcessInfo.processInfo.environment["FALCONDECK_NATIVE_HOST_LIBRARY"]
        let path = override ?? Bundle.main.bundleURL.appendingPathComponent("Contents/Frameworks/libfalcondeck_native_host.dylib").path
        return try NativeRuntimeLibrary(path: path)
    }

    private init(path: String) throws {
        guard let handle = dlopen(path, RTLD_NOW | RTLD_LOCAL) else {
            let detail = dlerror().map { String(cString: $0) } ?? "Library not found."
            throw PilotError("The embedded runtime could not load. Build the packaged app with scripts/build-app.sh, or open FalconDeck to attach to its daemon. \(detail)")
        }
        self.handle = handle
        func symbol<T>(_ name: String, _ type: T.Type) throws -> T {
            guard let address = dlsym(handle, name) else { throw PilotError("The embedded runtime is missing \(name).") }
            return unsafeBitCast(address, to: type)
        }
        do {
            startFunction = try symbol("fd_native_start", Start.self)
            statusFunction = try symbol("fd_native_status", Call.self)
            shutdownFunction = try symbol("fd_native_shutdown", Call.self)
            freeFunction = try symbol("fd_native_string_free", Free.self)
            helperFunction = try symbol("fd_native_dispatch_helper", Helper.self)
        } catch {
            dlclose(handle)
            throw error
        }
        // Never dlclose a live runtime: Tokio workers and stdio helpers execute
        // code from this image until process exit, even after Swift releases it.
    }

    func dispatchHelper() -> Int32 { helperFunction() }
    func start(_ config: String) throws -> JSON { try config.withCString { try decode(startFunction($0)) } }
    func status() throws -> JSON { try decode(statusFunction()) }
    func shutdown() throws -> JSON { try decode(shutdownFunction()) }

    private func decode(_ pointer: UnsafeMutablePointer<CChar>?) throws -> JSON {
        guard let pointer else { throw PilotError("The embedded runtime returned no result.") }
        defer { freeFunction(pointer) }
        let result = try JSON.decode(Data(String(cString: pointer).utf8))
        guard result["ok"].bool else {
            let message = result["error"].string
            throw PilotError(message.isEmpty ? "The embedded runtime failed." : message)
        }
        return result
    }
}
