import Foundation
import XCTest
@testable import FalconDeckMac

final class NativeParakeetLifecycleTests: XCTestCase {
    func testStatusAndTranscriptionNeverDownloadAnAbsentModel() async throws {
        try requireSupportedMac()
        let fixture = try ParakeetLifecycleFixture()
        defer { fixture.remove() }
        let runtime = NativeParakeetRuntime(directory: fixture.cache, binary: fixture.binary)

        let initial = await runtime.snapshot()
        XCTAssertFalse(initial.installed)
        XCTAssertFalse(initial.loaded)
        XCTAssertTrue(fixture.requests().isEmpty)
        do {
            _ = try await runtime.transcribe(path: fixture.audio.path)
            XCTFail("Missing models must require explicit setup")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("Download Parakeet"))
        }
        XCTAssertTrue(fixture.requests().isEmpty)

        try await runtime.setup()
        let prepared = await runtime.snapshot()
        XCTAssertTrue(prepared.installed)
        XCTAssertFalse(prepared.loaded)
        XCTAssertEqual(fixture.requests().count, 1)
        XCTAssertTrue(fixture.requests()[0].contains("prepare"))
        let transcript = try await runtime.transcribe(path: fixture.audio.path)
        XCTAssertEqual(transcript, "Fixture transcript")
        let finished = await runtime.snapshot()
        XCTAssertFalse(finished.loaded)
        await runtime.stop()
    }

    func testProviderStopDiscardsQueuedWarmWithoutStartingAnotherHelper() async throws {
        try requireSupportedMac()
        let fixture = try ParakeetLifecycleFixture()
        defer { fixture.remove() }
        let runtime = NativeParakeetRuntime(directory: fixture.cache, binary: fixture.binary)
        await runtime.configure(idleMinutes: 15)
        try Data().write(to: fixture.cache.appendingPathComponent("hold-prepare"))
        let preparing = Task { try await runtime.setup() }
        try await fixture.waitForRequests(1)
        let warming = Task { try await runtime.prewarm(idleMinutes: 15) }
        await runtime.requestStop()
        try FileManager.default.removeItem(at: fixture.cache.appendingPathComponent("hold-prepare"))
        try await preparing.value
        try await warming.value
        let stopped = await runtime.snapshot()
        XCTAssertTrue(stopped.installed)
        XCTAssertFalse(stopped.loaded)
        XCTAssertEqual(fixture.requests().count, 1)
        await runtime.stop()
    }

    func testCancelledInferenceStopsItsHelperAndTheNextRequestRecovers() async throws {
        try requireSupportedMac()
        let fixture = try ParakeetLifecycleFixture()
        defer { fixture.remove() }
        let runtime = NativeParakeetRuntime(directory: fixture.cache, binary: fixture.binary)
        try await runtime.setup()
        try Data().write(to: fixture.cache.appendingPathComponent("block-transcribe"))
        let inference = Task { try await runtime.transcribe(path: fixture.audio.path) }
        try await fixture.waitForRequests(2)
        inference.cancel()
        do {
            _ = try await inference.value
            XCTFail("Cancelled inference must not return a transcript")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        let cancelled = await runtime.snapshot()
        XCTAssertFalse(cancelled.loaded)
        XCTAssertFalse(cancelled.busy)
        XCTAssertNil(cancelled.error)
        try FileManager.default.removeItem(at: fixture.cache.appendingPathComponent("block-transcribe"))
        let transcript = try await runtime.transcribe(path: fixture.audio.path)
        XCTAssertEqual(transcript, "Fixture transcript")
        await runtime.stop()
    }

    func testUnexpectedHelperExitClearsLoadedStateAndAllowsRetry() async throws {
        try requireSupportedMac()
        let fixture = try ParakeetLifecycleFixture()
        defer { fixture.remove() }
        let runtime = NativeParakeetRuntime(directory: fixture.cache, binary: fixture.binary)
        await runtime.configure(idleMinutes: 15)
        try await runtime.setup()
        let loaded = await runtime.snapshot()
        XCTAssertTrue(loaded.loaded)
        try Data().write(to: fixture.cache.appendingPathComponent("crash-once"))
        do {
            _ = try await runtime.transcribe(path: fixture.audio.path)
            XCTFail("Helper exit must fail the current request")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("stopped unexpectedly"))
        }
        let failed = await runtime.snapshot()
        XCTAssertFalse(failed.loaded)
        XCTAssertFalse(failed.busy)
        let transcript = try await runtime.transcribe(path: fixture.audio.path)
        XCTAssertEqual(transcript, "Fixture transcript")
        let recovered = await runtime.snapshot()
        XCTAssertTrue(recovered.loaded)
        XCTAssertNil(recovered.error)
        await runtime.stop()
    }

    func testSilentInferenceUsesTheSharedNoSpeechErrorContract() async throws {
        try requireSupportedMac()
        let fixture = try ParakeetLifecycleFixture()
        defer { fixture.remove() }
        let runtime = NativeParakeetRuntime(directory: fixture.cache, binary: fixture.binary)
        try await runtime.setup()
        try Data().write(to: fixture.cache.appendingPathComponent("silent-transcribe"))
        do {
            _ = try await runtime.transcribe(path: fixture.audio.path)
            XCTFail("Empty output must report no speech")
        } catch {
            XCTAssertTrue(error.localizedDescription.lowercased().contains("no speech"))
        }
        await runtime.stop()
    }

    private func requireSupportedMac() throws {
        #if !arch(arm64)
        throw XCTSkip("Parakeet requires Apple Silicon")
        #endif
    }
}

private struct ParakeetLifecycleFixture {
    let root: URL
    let cache: URL
    let binary: URL
    let audio: URL

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("parakeet-lifecycle-\(UUID().uuidString)")
        cache = root.appendingPathComponent("cache")
        binary = root.appendingPathComponent("helper")
        audio = root.appendingPathComponent("fixture.caf")
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        try Data("audio fixture".utf8).write(to: audio)
        let script = #"""
        #!/bin/sh
        directory="$1"
        while IFS= read -r request; do
          printf '%s\n' "$request" >> "$directory/requests"
          case "$request" in
            *'"operation":"prepare"'*)
              while [ -f "$directory/hold-prepare" ]; do /bin/sleep 0.02; done
              models="$directory/parakeet-tdt-0.6b-v3"
              /bin/mkdir -p "$models"
              printf '{}' > "$models/parakeet_vocab.json"
              for component in Encoder_v2 Decoder Preprocessor JointDecisionv3; do
                /bin/mkdir -p "$models/$component.mlmodelc"
                printf 'fixture' > "$models/$component.mlmodelc/model.mil"
              done
              printf '{"progress":0.5,"phase":"Fixture download"}\n{"ok":true}\n'
              ;;
            *'"operation":"transcribe"'*)
              if [ -f "$directory/block-transcribe" ]; then exec /bin/sleep 30; fi
              if [ -f "$directory/crash-once" ]; then /bin/rm "$directory/crash-once"; exit 3; fi
              if [ -f "$directory/silent-transcribe" ]; then printf '{"ok":true,"text":"  "}\n'; continue; fi
              printf '{"ok":true,"text":"  Fixture transcript  "}\n'
              ;;
            *) printf '{"ok":true}\n' ;;
          esac
        done
        """#
        try Data(script.utf8).write(to: binary)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: binary.path)
    }

    func requests() -> [String] {
        let text = (try? String(contentsOf: cache.appendingPathComponent("requests"), encoding: .utf8)) ?? ""
        return text.split(separator: "\n").map(String.init)
    }

    func waitForRequests(_ count: Int) async throws {
        let deadline = Date().addingTimeInterval(5)
        while requests().count < count {
            guard Date() < deadline else { throw NSError(domain: "ParakeetLifecycleFixture", code: 1) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func remove() { try? FileManager.default.removeItem(at: root) }
}
