import AppKit
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import FalconDeckMac

final class ConversationAttachmentTests: XCTestCase {
    func testTextFileBecomesTextInputWithFilenameAndExactContent() throws {
        let source = "struct Eagle { let emoji = \"🦅\" }\n"
        let attachment = try NativeMacAttachment.prepare(Data(source.utf8), name: "Eagle.swift")
        XCTAssertEqual(attachment.kind, .text)
        XCTAssertEqual(attachment.text, source)
        XCTAssertEqual(attachment.input["type"].string, "text")
        XCTAssertEqual(attachment.input["text"].string, "Attached text file: Eagle.swift\n\n\(source)")
        XCTAssertEqual(try JSONDecoder().decode(NativeMacAttachment.self, from: JSONEncoder().encode(attachment)), attachment)
    }

    func testUTF16TextNormalizesToUTF8() throws {
        let source = "A note with an eagle 🦅"
        let data = try XCTUnwrap(source.data(using: .utf16))
        let attachment = try NativeMacAttachment.prepare(data, name: "Note.txt")
        XCTAssertEqual(attachment.text, source)
        XCTAssertEqual(attachment.data, Data(source.utf8))
    }

    func testBinaryAndOversizedTextAreRejected() {
        XCTAssertThrowsError(try NativeMacAttachment.prepare(Data([0x50, 0x4b, 0x03, 0x04, 0x00]), name: "archive.zip"))
        XCTAssertThrowsError(try NativeMacAttachment.prepare(Data(repeating: 65, count: NativeMacAttachment.maximumTextBytes + 1), name: "large.txt"))
        XCTAssertThrowsError(try NativeMacAttachment.prepare(Data(), name: "empty.txt"))
    }

    func testImageIsDownsampledAndUsesDaemonImageInput() throws {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = try XCTUnwrap(CGContext(data: nil, width: 4096, height: 16, bitsPerComponent: 8,
                                            bytesPerRow: 0, space: colorSpace,
                                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.2, green: 0.8, blue: 0.4, alpha: 0.5))
        context.fill(CGRect(x: 0, y: 0, width: 4096, height: 16))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))

        let attachment = try NativeMacAttachment.prepare(data as Data, name: "Wide.png")
        XCTAssertEqual(attachment.kind, .image)
        XCTAssertEqual(attachment.mimeType, "image/png")
        XCTAssertTrue(attachment.input["url"].string.hasPrefix("data:image/png;base64,"))
        XCTAssertEqual(attachment.input["type"].string, "image")
        XCTAssertEqual(attachment.input["id"].string, attachment.id)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(attachment.data as CFData, nil))
        let resized = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertLessThanOrEqual(max(resized.width, resized.height), 2048)
    }

    func testAttachmentBudgetRejectsTooManyFilesAndCombinedPayload() throws {
        let text = try NativeMacAttachment.prepare(Data("Note".utf8), name: "Note.txt")
        XCTAssertNoThrow(try NativeMacAttachment.validate([text]))
        XCTAssertThrowsError(try NativeMacAttachment.validate(Array(repeating: text, count: 11)))
        let large = NativeMacAttachment(id: "large", name: "image.jpg", mimeType: "image/jpeg",
                                        data: Data(repeating: 1, count: 8_000_000), kind: .image)
        XCTAssertThrowsError(try NativeMacAttachment.validate([large, large]))
    }

    func testFileLoaderKeepsSuccessfulFilesAndReportsUnsupportedFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let text = directory.appendingPathComponent("valid.swift")
        let binary = directory.appendingPathComponent("invalid.bin")
        try Data("let answer = 42".utf8).write(to: text)
        try Data([0, 1, 2, 3]).write(to: binary)
        let result = ConversationAttachmentLoader.load([text, binary])
        XCTAssertEqual(result.attachments.map(\.name), ["valid.swift"])
        XCTAssertTrue(result.error?.contains("invalid.bin") == true)
    }
}

final class ComposerShortcutTests: XCTestCase {
    @MainActor func testConfiguredSendAndAlternateSendUseTheirOwnCallbacks() throws {
        let suite = "ComposerShortcutTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativePreferences(defaults: defaults)
        let editor = ComposerNativeTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
        var sends = 0, alternates = 0
        editor.onSend = { sends += 1 }
        editor.onAlternateSend = { alternates += 1 }

        XCTAssertTrue(editor.handleComposerShortcut(try key(36, characters: "\r"), preferences: preferences))
        XCTAssertTrue(editor.handleComposerShortcut(try key(36, characters: "\r", flags: .command), preferences: preferences))
        XCTAssertEqual(sends, 1)
        XCTAssertEqual(alternates, 1)

        preferences.setBindings(["Mod+Shift+S"], for: "sendMessage")
        XCTAssertFalse(editor.handleComposerShortcut(try key(36, characters: "\r"), preferences: preferences))
        XCTAssertTrue(editor.handleComposerShortcut(try key(1, characters: "S", flags: [.command, .shift]), preferences: preferences))
        XCTAssertEqual(sends, 2)
    }

    @MainActor func testNewlineBindingPreservesMultilineEditingAndHeldSendDoesNotRepeat() throws {
        let suite = "ComposerShortcutTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativePreferences(defaults: defaults)
        let editor = ComposerNativeTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
        editor.string = "First line"
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
        var sends = 0
        editor.onSend = { sends += 1 }
        XCTAssertTrue(editor.handleComposerShortcut(try key(36, characters: "\r", flags: .shift), preferences: preferences))
        XCTAssertEqual(editor.string, "First line\n")
        XCTAssertEqual(sends, 0)
        XCTAssertTrue(editor.handleComposerShortcut(try key(36, characters: "\r", repeatKey: true), preferences: preferences))
        XCTAssertEqual(sends, 0)
    }

    @MainActor private func key(_ code: UInt16, characters: String, flags: NSEvent.ModifierFlags = [], repeatKey: Bool = false) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 1,
                                      windowNumber: 0, context: nil, characters: characters,
                                      charactersIgnoringModifiers: characters, isARepeat: repeatKey, keyCode: code))
    }
}
