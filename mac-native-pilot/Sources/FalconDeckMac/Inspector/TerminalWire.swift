import Foundation

/// The daemon uses binary frames for PTY bytes so split UTF-8 and escape
/// sequences reach the emulator unchanged. Control messages remain JSON.
struct NativeTerminalOutput: Equatable {
    let replay: Bool
    let sequence: UInt64
    let bytes: Data

    static func decode(_ data: Data) -> Self? {
        let bytes = [UInt8](data)
        guard bytes.count >= 9, bytes[0] == 1 || bytes[0] == 2 else { return nil }
        var sequence: UInt64 = 0
        for index in 0..<8 { sequence |= UInt64(bytes[index + 1]) << (index * 8) }
        return Self(replay: bytes[0] == 1, sequence: sequence, bytes: Data(bytes.dropFirst(9)))
    }

    static func input(_ data: Data) -> Data {
        var frame = Data([0x10])
        frame.append(data)
        return frame
    }
}

struct NativeTerminalSequence {
    enum Disposition { case append, duplicate, gap }
    private(set) var last: UInt64?
    var resumeFrom: UInt64 { last.map { $0 == .max ? .max : $0 + 1 } ?? 0 }

    mutating func accept(_ sequence: UInt64) -> Disposition {
        if let last {
            guard sequence > last else { return .duplicate }
            self.last = sequence
            return sequence - last > 1 ? .gap : .append
        }
        last = sequence
        return .append
    }
}
