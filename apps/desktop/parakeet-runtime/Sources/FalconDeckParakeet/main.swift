import Foundation
import FluidAudio

// SDK download callbacks can arrive on different queues. Keep each JSON line intact.
final class Output: @unchecked Sendable {
    private let lock = NSLock()
    func send(_ value: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(10)
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
    }
}

@main struct FalconDeckParakeet {
    static func main() async {
        let output = Output()
        guard CommandLine.arguments.count == 2 else {
            output.send(["error": "Missing model directory."])
            return
        }
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
            .appendingPathComponent(Repo.parakeetV3.folderName, isDirectory: true)
        // The SDK's original "int8" encoder uses LUT palettization and has
        // known word corruption (#760). Use the corrected linear INT8 export.
        let precision = ParakeetEncoderPrecision.int8V2
        var manager: AsrManager?
        while let line = readLine() {
            do {
                guard let data = line.data(using: .utf8),
                      let request = try JSONSerialization.jsonObject(with: data) as? [String: String],
                      let operation = request["operation"] else {
                    throw NSError(domain: "FalconDeckParakeet", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "Invalid request."])
                }
                if operation == "shutdown" { break }
                guard ["prepare", "warm", "transcribe"].contains(operation) else {
                    throw NSError(domain: "FalconDeckParakeet", code: 2,
                                  userInfo: [NSLocalizedDescriptionKey: "Unknown operation."])
                }
                if operation == "prepare" {
                    let force = request["force"] == "true"
                    if force, let current = manager {
                        await current.cleanup()
                        manager = nil
                    }
                    try await AsrModels.download(to: directory, force: force, version: .v3, encoderPrecision: precision) { progress in
                        let phase: String
                        switch progress.phase {
                        case .listing: phase = "Checking model files"
                        case .downloading: phase = "Downloading model"
                        case .compiling: phase = "Preparing model for this Mac"
                        }
                        output.send(["progress": progress.fractionCompleted, "phase": phase])
                    }
                }
                if manager == nil {
                    output.send(["progress": 1.0, "phase": "Loading model"])
                    // Inference must never download implicitly.
                    let models = try AsrModels.loadLocal(from: directory, version: .v3, encoderPrecision: precision)
                    let loaded = AsrManager()
                    try await loaded.loadModels(models)
                    manager = loaded
                }
                if operation == "transcribe" {
                    guard let path = request["path"], !path.isEmpty, let manager else {
                        throw NSError(domain: "FalconDeckParakeet", code: 3,
                                      userInfo: [NSLocalizedDescriptionKey: "Missing audio file path."])
                    }
                    var state = try TdtDecoderState()
                    let result = try await manager.transcribe(URL(fileURLWithPath: path), decoderState: &state)
                    output.send(["ok": true, "text": result.text])
                } else {
                    output.send(["ok": true])
                }
            } catch {
                output.send(["error": error.localizedDescription])
            }
        }
        if let manager { await manager.cleanup() }
    }
}
