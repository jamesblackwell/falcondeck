import Foundation
import Darwin

struct NativeParakeetStatus: Sendable {
    var supported: Bool
    var installed: Bool
    var loaded = false
    var busy = false
    var progress: Double?
    var phase = ""
    var error: String?
}

/// Owns the disposable ASR helper. Checking status never starts a process or downloads models.
/// The cache and wire protocol match the desktop runtime so existing downloads can be reused.
actor NativeParakeetRuntime {
    static let shared = NativeParakeetRuntime()
    static let statusDidChange = Notification.Name("NativeParakeetStatusDidChange")

    private static let model = "nvidia/parakeet-tdt-0.6b-v3"
    private static let components = [
        "Encoder_v2.mlmodelc", "Decoder.mlmodelc", "Preprocessor.mlmodelc", "JointDecisionv3.mlmodelc"
    ]

    private let directory: URL
    private let binaryOverride: URL?
    private var worker: ParakeetWorker?
    private var currentStatus: NativeParakeetStatus
    private var idleMinutes = 0
    private var lastUsed = Date()
    private var idleTask: Task<Void, Never>?
    private var locked = false
    private var waiters: [CheckedContinuation<Void, Error>] = []
    private var generation = 0
    private var configurationGeneration = 0
    private var warmingAllowed = true
    private var stopAfterCurrent = false

    init(directory: URL? = nil, binary: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.falcondeck.desktop", isDirectory: true)
            .appendingPathComponent("parakeet-v3-int8-v2", isDirectory: true)
        binaryOverride = binary
        currentStatus = NativeParakeetStatus(supported: Self.isSupported, installed: false)
    }

    func status() async -> String {
        let value = snapshot()
        if !value.supported { return "Parakeet requires an Apple Silicon Mac running macOS 14 or later." }
        if value.busy {
            if let progress = value.progress {
                return "\(value.phase) (\(Int(max(0, min(progress, 1)) * 100))%)"
            }
            return value.phase.isEmpty ? "Preparing Parakeet…" : value.phase
        }
        if let error = value.error { return error }
        if !value.installed { return "Parakeet model is not downloaded." }
        return value.loaded ? "Parakeet is ready." : "Parakeet is installed. It will load when needed."
    }

    func snapshot() -> NativeParakeetStatus {
        if let worker, !worker.isRunning {
            self.worker = nil
            currentStatus.loaded = false
        }
        currentStatus.installed = Self.isInstalled(at: directory)
        return currentStatus
    }

    /// This is the only operation allowed to download or repair the model cache.
    func setup(redownload: Bool = false) async throws {
        _ = try await request(operation: "prepare", force: redownload)
    }

    /// Inference only loads a complete local cache; it never downloads implicitly.
    func transcribe(path: String) async throws -> String {
        guard FileManager.default.fileExists(atPath: path) else {
            throw ParakeetFailure("The recorded audio file could not be found.")
        }
        let response = try await request(operation: "transcribe", path: path)
        let text = response.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { throw ParakeetFailure("Parakeet did not detect any speech.") }
        return text
    }

    /// A zero-minute setting keeps inference disposable. Positive values retain it until idle.
    func prewarm(idleMinutes: Int) async throws {
        guard warmingAllowed else { return }
        self.idleMinutes = max(0, min(60, idleMinutes))
        if self.idleMinutes == 0 {
            if !currentStatus.busy { stopWorker(); publish() }
            return
        }
        _ = try await request(operation: "warm", warmGeneration: configurationGeneration)
    }

    /// Changes retention without loading or downloading the model.
    func configure(idleMinutes: Int, enabled: Bool = true) async {
        self.idleMinutes = max(0, min(60, idleMinutes))
        guard enabled else { requestStop(); return }
        configurationGeneration += 1
        warmingAllowed = true
        stopAfterCurrent = false
        if self.idleMinutes == 0, !currentStatus.busy {
            stopWorker()
            publish()
        } else {
            scheduleIdleCheck()
        }
    }

    /// Provider changes let the active download/inference finish, then release its model memory.
    /// A queued warm request must recheck this state before it can create another helper.
    func requestStop() {
        configurationGeneration += 1
        warmingAllowed = false
        stopAfterCurrent = true
        idleTask?.cancel()
        idleTask = nil
        if !currentStatus.busy {
            stopWorker()
            publish()
        }
    }

    func stop() async {
        generation += 1
        configurationGeneration += 1
        warmingAllowed = false
        stopAfterCurrent = true
        for waiter in waiters { waiter.resume(throwing: CancellationError()) }
        waiters.removeAll()
        stopWorker()
        currentStatus.busy = false
        currentStatus.progress = nil
        currentStatus.phase = ""
        publish()
    }

    private static var isSupported: Bool {
        #if arch(arm64)
        if #available(macOS 14, *) { return true }
        #endif
        return false
    }

    static func isInstalled(at directory: URL) -> Bool {
        isRegularFile(directory.appendingPathComponent("ready")) && hasCompleteModels(at: directory)
    }

    private static func hasCompleteModels(at directory: URL) -> Bool {
        let models = directory.appendingPathComponent("parakeet-tdt-0.6b-v3", isDirectory: true)
        guard isRegularFile(models.appendingPathComponent("parakeet_vocab.json")) else { return false }
        return components.allSatisfy {
            isRegularFile(models.appendingPathComponent($0).appendingPathComponent("model.mil"))
        }
    }

    private static func isRegularFile(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
    }

    private func binary() throws -> URL {
        if let binaryOverride { return binaryOverride }
        var candidates: [URL] = []
        if let executable = Bundle.main.executableURL {
            candidates.append(executable.deletingLastPathComponent().appendingPathComponent("falcondeck-parakeet"))
        }
        if let resources = Bundle.main.resourceURL {
            candidates.append(resources.appendingPathComponent("falcondeck-parakeet"))
        }
        #if DEBUG
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        #if arch(arm64)
        let architecture = "aarch64"
        #else
        let architecture = "x86_64"
        #endif
        candidates.append(repository.appendingPathComponent("apps/desktop/src-tauri/binaries/falcondeck-parakeet-\(architecture)-apple-darwin"))
        #endif
        guard let result = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
            throw ParakeetFailure("The Parakeet runtime is missing from this build.")
        }
        return result
    }

    private func acquire() async throws {
        try Task.checkCancellation()
        if !locked { locked = true; return }
        try await withCheckedThrowingContinuation { waiters.append($0) }
        do {
            try Task.checkCancellation()
        } catch {
            release()
            throw error
        }
    }

    private func release() {
        if stopAfterCurrent, !currentStatus.busy { stopWorker() }
        if waiters.isEmpty { locked = false } else { waiters.removeFirst().resume() }
    }

    private func request(operation: String, path: String? = nil, force: Bool = false, warmGeneration: Int? = nil) async throws -> ParakeetResponse {
        guard Self.isSupported else {
            throw ParakeetFailure("Parakeet requires an Apple Silicon Mac running macOS 14 or later.")
        }
        try await acquire()
        defer { release() }
        if operation == "warm",
           (!warmingAllowed || idleMinutes == 0 || warmGeneration != configurationGeneration) {
            return ParakeetResponse(ok: true)
        }
        guard operation == "prepare" || Self.isInstalled(at: directory) else {
            throw ParakeetFailure("Download Parakeet in Dictation settings first.")
        }
        if let worker, !worker.isRunning { self.worker = nil; currentStatus.loaded = false }
        if operation == "warm", worker != nil {
            lastUsed = Date()
            scheduleIdleCheck()
            return ParakeetResponse(ok: true)
        }
        currentStatus.busy = true
        currentStatus.error = nil
        currentStatus.progress = nil
        currentStatus.phase = "Preparing model"
        idleTask?.cancel()
        publish()
        let requestGeneration = generation
        do {
            if worker == nil {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                worker = try ParakeetWorker(binary: binary(), directory: directory)
            }
            guard let worker else { throw ParakeetFailure("Parakeet is unavailable.") }
            let timeout: TimeInterval = operation == "prepare" ? 1800 : operation == "warm" ? 60 : 1500
            let response = try await worker.exchange(
                ParakeetRequest(operation: operation, path: path, force: force ? "true" : "false"),
                timeout: timeout
            ) { [weak self] response in
                Task { await self?.receivedProgress(response, generation: requestGeneration) }
            }
            guard generation == requestGeneration else { throw CancellationError() }
            try Task.checkCancellation()
            if operation == "prepare" {
                guard Self.hasCompleteModels(at: directory) else {
                    throw ParakeetFailure("Parakeet setup returned an incomplete model cache. Re-download the model in Voice settings.")
                }
                try Data(Self.model.utf8).write(to: directory.appendingPathComponent("ready"), options: .atomic)
            }
            currentStatus.busy = false
            currentStatus.loaded = true
            currentStatus.progress = nil
            currentStatus.phase = ""
            lastUsed = Date()
            if stopAfterCurrent || idleMinutes == 0 { stopWorker() } else { scheduleIdleCheck() }
            publish()
            return response
        } catch {
            let failure: Error = Task.isCancelled ? CancellationError() : error
            if generation == requestGeneration {
                currentStatus.busy = false
                currentStatus.error = failure is CancellationError ? nil : failure.localizedDescription
                currentStatus.progress = nil
                currentStatus.phase = ""
                stopWorker()
                publish()
            }
            throw failure
        }
    }

    private func receivedProgress(_ response: ParakeetResponse, generation: Int) {
        guard self.generation == generation, currentStatus.busy else { return }
        currentStatus.progress = response.progress
        currentStatus.phase = response.phase ?? "Preparing model"
        publish()
    }

    private func scheduleIdleCheck() {
        idleTask?.cancel()
        guard worker != nil, warmingAllowed, !stopAfterCurrent, idleMinutes > 0, !currentStatus.busy else { return }
        let delay = max(0, Double(idleMinutes) * 60 - Date().timeIntervalSince(lastUsed))
        idleTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
            await self?.unloadIfIdle()
        }
    }

    private func unloadIfIdle() {
        guard !currentStatus.busy, Date().timeIntervalSince(lastUsed) >= Double(idleMinutes) * 60 else { return }
        stopWorker()
        publish()
    }

    private func stopWorker() {
        idleTask?.cancel()
        idleTask = nil
        worker?.stop()
        worker = nil
        currentStatus.loaded = false
    }

    private func publish() {
        NotificationCenter.default.post(name: Self.statusDidChange, object: nil)
    }
}

private struct ParakeetRequest: Encodable, Sendable {
    var operation: String
    var path: String?
    var force: String
}

private struct ParakeetResponse: Decodable, Sendable {
    var ok: Bool?
    var text: String?
    var error: String?
    var progress: Double?
    var phase: String?
}

private struct ParakeetFailure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

/// Blocking pipe reads live on one private queue, never the main actor or cooperative executor.
/// Each worker belongs to one Process; shutdown never targets a discovered/reused system PID.
private final class ParakeetWorker: @unchecked Sendable {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let queue = DispatchQueue(label: "com.falcondeck.native.parakeet")
    private var buffer = Data()
    var isRunning: Bool { process.isRunning }

    init(binary: URL, directory: URL) throws {
        process.executableURL = binary
        process.arguments = [directory.path]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() }
        catch { throw ParakeetFailure("Could not start Parakeet: \(error.localizedDescription)") }
        // Close the parent's copies of the child's pipe ends so process exit produces EOF.
        try? input.fileHandleForReading.close()
        try? output.fileHandleForWriting.close()
        // The child can exit between isRunning and a write; report EPIPE rather than
        // allowing a broken helper pipe to deliver SIGPIPE to the native application.
        _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
    }

    deinit { stop() }

    func stop() {
        guard process.isRunning else { return }
        process.terminate()
        let process = process
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }

    func exchange(
        _ request: ParakeetRequest,
        timeout: TimeInterval,
        progress: @escaping @Sendable (ParakeetResponse) -> Void
    ) async throws -> ParakeetResponse {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue.async { [self] in
                    let deadline = DispatchWorkItem { [weak self] in self?.stop() }
                    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: deadline)
                    defer { deadline.cancel() }
                    let started = Date()
                    do {
                        guard process.isRunning else { throw ParakeetFailure("Parakeet stopped unexpectedly. Please try again.") }
                        var payload = try JSONEncoder().encode(request)
                        payload.append(10)
                        try input.fileHandleForWriting.write(contentsOf: payload)
                        while true {
                            let response = try JSONDecoder().decode(ParakeetResponse.self, from: readLine())
                            if let error = response.error { throw ParakeetFailure(error) }
                            if response.ok == true { continuation.resume(returning: response); return }
                            progress(response)
                        }
                    } catch {
                        if Date().timeIntervalSince(started) >= timeout {
                            continuation.resume(throwing: ParakeetFailure("Parakeet timed out. Please try again."))
                        } else {
                            continuation.resume(throwing: error)
                        }
                    }
                }
            }
        } onCancel: { [weak self] in self?.stop() }
    }

    private func readLine() throws -> Data {
        while true {
            if let newline = buffer.firstIndex(of: 10) {
                let line = Data(buffer[..<newline])
                buffer.removeSubrange(...newline)
                if line.isEmpty { continue }
                return line
            }
            // FileHandle's length-based reads can wait for the entire requested size on
            // a pipe. A single POSIX read returns as soon as one JSON fragment arrives.
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = Darwin.read(output.fileHandleForReading.fileDescriptor, &bytes, bytes.count)
            if count < 0, errno == EINTR { continue }
            guard count > 0 else {
                throw ParakeetFailure("Parakeet stopped unexpectedly. Please try again.")
            }
            buffer.append(contentsOf: bytes.prefix(count))
            guard buffer.count <= 4 * 1_024 * 1_024 else { throw ParakeetFailure("Parakeet returned an invalid response.") }
        }
    }
}
