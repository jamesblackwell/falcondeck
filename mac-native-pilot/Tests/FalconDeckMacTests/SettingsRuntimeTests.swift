import XCTest
@testable import FalconDeckMac

final class SettingsRuntimeTests: XCTestCase {
    func testAttachedRuntimeShowsDaemonGrantsWithoutOfferingNativeGrant() {
        let permissions = NativeComputerUsePermissionState(status: status(accessibility: true, screenRecording: true), ownsRuntime: false)
        XCTAssertTrue(permissions.accessibility)
        XCTAssertTrue(permissions.screenRecording)
        XCTAssertTrue(permissions.allGranted)
        XCTAssertFalse(permissions.canRequest)
    }

    func testAttachedRuntimeDoesNotOfferNativeGrantForMissingDaemonPermissions() {
        let permissions = NativeComputerUsePermissionState(status: status(accessibility: false, screenRecording: true), ownsRuntime: false)
        XCTAssertFalse(permissions.accessibility)
        XCTAssertTrue(permissions.screenRecording)
        XCTAssertFalse(permissions.allGranted)
        XCTAssertFalse(permissions.canRequest)
    }

    func testOwnedRuntimeCanRequestItsMissingPermissions() {
        let permissions = NativeComputerUsePermissionState(status: status(accessibility: true, screenRecording: false), ownsRuntime: true)
        XCTAssertTrue(permissions.accessibility)
        XCTAssertFalse(permissions.screenRecording)
        XCTAssertFalse(permissions.allGranted)
        XCTAssertTrue(permissions.canRequest)
    }

    func testPermissionRefreshDetectsBothGrantsOnTheConnectedDaemon() {
        let before = NativeComputerUsePermissionState(status: status(accessibility: true, screenRecording: false), ownsRuntime: false)
        let after = NativeComputerUsePermissionState(status: status(accessibility: true, screenRecording: true), ownsRuntime: false)
        XCTAssertFalse(before.allGranted)
        XCTAssertTrue(after.allGranted)
    }

    private func status(accessibility: Bool, screenRecording: Bool) -> JSON {
        .object(["permissions": .object(["accessibility": .bool(accessibility), "screen_recording": .bool(screenRecording)])])
    }
}
