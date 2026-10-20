import Darwin
import Foundation

/// Backups include connector credentials. Keep even the temporary file private.
enum NativeArchiveFile {
    static func write(_ data: Data, to destination: URL) throws {
        var template = destination.deletingLastPathComponent().appendingPathComponent(".falcondeck-backup-XXXXXX").path.utf8CString
        let descriptor = template.withUnsafeMutableBufferPointer { mkstemp($0.baseAddress!) }
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let temporaryPath = template.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
        defer { unlink(temporaryPath) }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try file.write(contentsOf: data)
        try file.synchronize()
        try file.close()
        guard rename(temporaryPath, destination.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }
}
