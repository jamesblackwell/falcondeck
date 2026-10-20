import Foundation
import AppKit
import NativeSpeechBridge
import XCTest
@testable import FalconDeckMac

final class NativeSpeechTests: XCTestCase {
    func testDictionaryUsesWholeWordsLongestMatchAndDoesNotCascade() {
        let rules = [
            NativeDictionaryEntry(find: "falcon", replacement: "bird"),
            NativeDictionaryEntry(find: "falcon deck", replacement: "FalconDeck"),
            NativeDictionaryEntry(find: "bird", replacement: "eagle")
        ]
        XCTAssertEqual(NativeCorrectionDictionary.apply(rules, to: "FALCON DECK and falcon, falconry and bird."),
                       "FalconDeck and bird, falconry and eagle.")
    }

    func testDictionaryRemovalPreservesParagraphsAndAllowsEntireRemoval() {
        let rules = [NativeDictionaryEntry(find: "um", replacement: "")]
        XCTAssertEqual(NativeCorrectionDictionary.apply(rules, to: "Write um this.\n\nThen um that."), "Write this.\n\nThen that.")
        XCTAssertEqual(NativeCorrectionDictionary.apply(rules, to: "um"), "")
        XCTAssertEqual(NativeCorrectionDictionary.apply(rules, to: "summer"), "summer")
        XCTAssertEqual(NativeCorrectionDictionary.apply(rules, to: "first um\n\tsecond um"), "first\n\tsecond")
        XCTAssertEqual(NativeCorrectionDictionary.apply(rules, to: "um um"), "")
    }

    func testVoicePreferencesDecodeOlderConfigurationsWithoutDiscardingSettings() throws {
        let config = try JSONDecoder().decode(NativeVoiceConfiguration.self, from: Data("{\"enabled\":true,\"provider\":\"parakeet\"}".utf8))
        XCTAssertTrue(config.enabled)
        XCTAssertEqual(config.provider, "parakeet")
        XCTAssertTrue(config.repasteShortcutEnabled)
        XCTAssertEqual(config.hotkey, "right_command")
        XCTAssertEqual(config.historyRetentionHours, 6)
    }

    func testComposerAnchorPreservesTypedSuffixAndRejectsChangedPrefixOrSelection() {
        let caret = NSRange(location: ("Hello 👋 " as NSString).length, length: 0)
        XCTAssertEqual(NativeSpeechTextAnchor.replacementRange(original: "Hello 👋 ", selection: caret, current: "Hello 👋 typed while listening"), caret)
        XCTAssertNil(NativeSpeechTextAnchor.replacementRange(original: "Hello 👋 ", selection: caret, current: "Changed 👋 typed while listening"))
        let selected = NSRange(location: 3, length: 4)
        XCTAssertEqual(NativeSpeechTextAnchor.replacementRange(original: "My text here", selection: selected, current: "My text here later"), selected)
        XCTAssertNil(NativeSpeechTextAnchor.replacementRange(original: "My text here", selection: selected, current: "My edit here"))
        XCTAssertNil(NativeSpeechTextAnchor.replacementRange(original: "Short", selection: NSRange(location: Int.max, length: 10), current: "Short"))
    }

    func testRecordingValidationRejectsUnrelatedFilesAndSymlinkEscapes() throws {
        let temporary = FileManager.default.temporaryDirectory
        let name = "falcondeck-native-dictation-\(UUID().uuidString).m4a"
        let audio = temporary.appendingPathComponent(name)
        try Data("test fixture".utf8).write(to: audio)
        defer { try? FileManager.default.removeItem(at: audio) }
        XCTAssertEqual(try NativeSpeechFiles.validatedURL(audio.path), audio.standardizedFileURL.resolvingSymlinksInPath())
        XCTAssertThrowsError(try NativeSpeechFiles.validatedURL("/etc/hosts"))
        let link = temporary.appendingPathComponent("falcondeck-native-dictation-\(UUID().uuidString).m4a")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: URL(fileURLWithPath: "/etc/hosts"))
        defer { try? FileManager.default.removeItem(at: link) }
        XCTAssertThrowsError(try NativeSpeechFiles.validatedURL(link.path))
    }

    func testNativeCaptureAndClipboardContractsWithoutMicrophoneOrPermissionPrompts() {
        XCTAssertTrue(fd_dictation_test_recovery_audio_contract())
        XCTAssertTrue(fd_dictation_test_recording_duration_is_usable(1))
        XCTAssertFalse(fd_dictation_test_recording_duration_is_usable(0.02))
        XCTAssertFalse(fd_dictation_test_recording_duration_is_usable(.nan))
        XCTAssertTrue(fd_dictation_test_rewrite_selection_contract())
        XCTAssertTrue(fd_dictation_test_transcript_replacement_ranges())
        XCTAssertTrue(fd_native_speech_test_paste_target_identity())
    }

    @MainActor func testSilentRewriteUsesCustomPromptOrPreservingTidyInstruction() {
        XCTAssertEqual(NativeSpeechController.rewriteInstruction("", custom: "Translate to French"), "Apply the system instructions to this passage.")
        XCTAssertTrue(NativeSpeechController.rewriteInstruction("", custom: "").contains("Keep the meaning"))
        XCTAssertTrue(NativeSpeechController.rewriteInstruction("...", custom: "").contains("Keep the meaning"))
        XCTAssertEqual(NativeSpeechController.rewriteInstruction("Make it shorter", custom: ""), "Make it shorter")
    }

    @MainActor func testSharedFieldEditorCannotRedirectSpeechIntoAnotherTextField() {
        let editor = NSTextView()
        editor.isFieldEditor = true
        let first = SpeechFieldDelegate()
        let second = SpeechFieldDelegate()
        editor.delegate = first
        let target = NativeSpeechTextTarget(editor: editor, text: "", range: NSRange(location: 0, length: 0),
                                            projectID: "project", taskID: "task")
        XCTAssertTrue(target.matchesFieldOwner(editor))
        editor.delegate = second
        XCTAssertFalse(target.matchesFieldOwner(editor))
        withExtendedLifetime((first, second)) {}
    }
}

private final class SpeechFieldDelegate: NSObject, NSTextViewDelegate {}
