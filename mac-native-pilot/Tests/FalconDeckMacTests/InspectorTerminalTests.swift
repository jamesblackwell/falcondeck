import Foundation
import XCTest
@testable import FalconDeckMac

final class InspectorTerminalTests: XCTestCase {
    func testBinaryOutputPreservesEscapeSequencesAndNonUTF8Bytes() {
        let payload = Data([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xf0, 0x9f, 0xff])
        var frame = Data([2, 8, 7, 6, 5, 4, 3, 2, 1])
        frame.append(payload)

        let result = NativeTerminalOutput.decode(frame)
        XCTAssertEqual(result?.sequence, 0x0102030405060708)
        XCTAssertEqual(result?.bytes, payload)
        XCTAssertEqual(result?.replay, false)
        frame[0] = 1
        XCTAssertEqual(NativeTerminalOutput.decode(frame)?.replay, true)
    }

    func testMalformedAndInputFramesCannotBecomeOutput() {
        XCTAssertNil(NativeTerminalOutput.decode(Data()))
        XCTAssertNil(NativeTerminalOutput.decode(Data([1, 0, 0])))
        XCTAssertNil(NativeTerminalOutput.decode(Data([0x10, 0, 0, 0, 0, 0, 0, 0, 0])))
        let payload = Data([0x00, 0x1b, 0xff])
        XCTAssertEqual(NativeTerminalOutput.input(payload), Data([0x10]) + payload)
    }

    func testReconnectCursorDropsDuplicateReplayAndDetectsPrunedOutput() {
        var sequence = NativeTerminalSequence()
        XCTAssertEqual(sequence.resumeFrom, 0)
        XCTAssertEqual(sequence.accept(0), .append)
        XCTAssertEqual(sequence.accept(1), .append)
        XCTAssertEqual(sequence.resumeFrom, 2)
        XCTAssertEqual(sequence.accept(1), .duplicate)
        XCTAssertEqual(sequence.accept(0), .duplicate)
        XCTAssertEqual(sequence.resumeFrom, 2)
        XCTAssertEqual(sequence.accept(5), .gap)
        XCTAssertEqual(sequence.resumeFrom, 6)
        XCTAssertEqual(sequence.accept(6), .append)
    }

    func testFreshAttachMayStartAtRetainedReplayAndCursorCannotOverflow() {
        var sequence = NativeTerminalSequence()
        XCTAssertEqual(sequence.accept(127), .append)
        XCTAssertEqual(sequence.resumeFrom, 128)
        XCTAssertEqual(sequence.accept(UInt64.max), .gap)
        XCTAssertEqual(sequence.resumeFrom, UInt64.max)
        XCTAssertEqual(sequence.accept(UInt64.max), .duplicate)
    }
}
