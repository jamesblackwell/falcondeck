import XCTest
@testable import FalconDeckMac

final class RuntimeTests: XCTestCase {
    func testNativeRuntimeDiscoveryIncludesBothShellsWithoutRemoteListeners() {
        let listeners = NativeRuntime.listenerCandidates(from: """
        p1
        cFalconDeckMac
        n127.0.0.1:49571
        n*:9999
        p2
        cfalcondeck-desktop
        n127.0.0.1:49572
        p3
        cnode
        n127.0.0.1:49573
        p4
        cfalcondeck-daemon
        n[::1]:4123
        n192.168.1.2:4123
        """)
        XCTAssertEqual(listeners.map(\.absoluteString), ["http://127.0.0.1:49571", "http://127.0.0.1:49572", "http://[::1]:4123"])
    }

    func testPassiveRuntimeShutdownDoesNotLoadOrStartTheHost() async throws {
        let runtime = NativeRuntime()
        let owned = await runtime.isOwned()
        XCTAssertFalse(owned)
        try await runtime.shutdown()
        let active = await runtime.activeThreadCount()
        XCTAssertEqual(active, 0)
    }

    func testStdioHelpersDoNotBlockDaemonRecovery() {
        XCTAssertFalse(NativeRuntime.hasOtherRuntime(processes: """
        1 /Applications/FalconDeck.app/Contents/MacOS/falcondeck-desktop
        2 /Applications/FalconDeck Native.app/Contents/MacOS/FalconDeckMac
        3 /opt/falcondeck-daemon
        4 /Applications/FalconDeck.app/Contents/MacOS/falcondeck-desktop
        """, arguments: """
        1 /Applications/FalconDeck.app/Contents/MacOS/falcondeck-desktop mcp
        2 /Applications/FalconDeck Native.app/Contents/MacOS/FalconDeckMac mcp-extensions
        3 falcondeck-daemon mcp-future
        4 /Applications/FalconDeck.app/Contents/MacOS/falcondeck-desktop
        """, ownPID: 4))
    }

    func testOrdinaryRuntimeStillBlocksDaemonTakeover() {
        XCTAssertTrue(NativeRuntime.hasOtherRuntime(
            processes: "1 /Applications/FalconDeck Native.app/Contents/MacOS/FalconDeckMac",
            arguments: "1 /Applications/FalconDeck Native.app/Contents/MacOS/FalconDeckMac",
            ownPID: 2
        ))
    }

    func testMissingProcessArgumentsConservativelyProtectsTheRuntime() {
        XCTAssertTrue(NativeRuntime.hasOtherRuntime(
            processes: "1 /opt/falcondeck-daemon", arguments: "", ownPID: 2
        ))
    }
}
