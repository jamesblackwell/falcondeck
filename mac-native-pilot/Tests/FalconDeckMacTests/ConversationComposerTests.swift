import AppKit
import SwiftUI
import XCTest
@testable import FalconDeckMac

final class ConversationComposerTests: XCTestCase {
    @MainActor func testHostedDisabledEditorRejectsPasteDropsAndSendThenBecomesEditable() throws {
        var sends = 0
        var attachmentsReceived = 0
        func content(disabled: Bool) -> some View {
            ConversationTextEditor(text: .constant("Restoring draft"), placeholder: "Message",
                onSend: { sends += 1 }, onAttachments: { attachmentsReceived += $0.count }, onError: { XCTFail($0) })
                .disabled(disabled)
        }
        let host = NSHostingView(rootView: content(disabled: true))
        host.frame = NSRect(x: 0, y: 0, width: 600, height: 164)
        host.layoutSubtreeIfNeeded()
        let editor = try XCTUnwrap(firstSubview(of: ComposerNativeTextView.self, in: host))
        XCTAssertFalse(editor.isEditable)
        XCTAssertTrue(editor.registeredDraggedTypes.contains(.init("public.jpeg")), "JPEG drops must be registered alongside PNG and TIFF.")
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        let drag = ComposerTestDraggingInfo(pasteboard: pasteboard)
        for type in [NSPasteboard.PasteboardType.string, .png] {
            pasteboard.clearContents()
            if type == .string {
                XCTAssertTrue(pasteboard.setString("Do not replace recovery data", forType: type))
            } else {
                XCTAssertTrue(pasteboard.setData(try clipboardImage(using: .png), forType: type))
            }
            XCTAssertFalse(editor.readSelection(from: pasteboard, type: type))
            XCTAssertEqual(editor.draggingEntered(drag), [])
            XCTAssertEqual(editor.draggingUpdated(drag), [])
            XCTAssertFalse(editor.prepareForDragOperation(drag))
            XCTAssertFalse(editor.performDragOperation(drag))
        }
        // This returns before touching the general clipboard when disabled.
        editor.paste(nil)
        let enter = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 1,
            windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        XCTAssertFalse(editor.handleComposerShortcut(enter))
        XCTAssertEqual(editor.string, "Restoring draft")
        XCTAssertEqual(attachmentsReceived, 0)
        XCTAssertEqual(sends, 0)

        host.rootView = content(disabled: false)
        host.layoutSubtreeIfNeeded()
        let enabledEditor = try XCTUnwrap(firstSubview(of: ComposerNativeTextView.self, in: host))
        XCTAssertTrue(enabledEditor === editor)
        XCTAssertTrue(enabledEditor.isEditable)
        pasteboard.clearContents()
        XCTAssertTrue(pasteboard.setString(" recovered", forType: .string))
        enabledEditor.setSelectedRange(NSRange(location: enabledEditor.string.utf16.count, length: 0))
        XCTAssertTrue(enabledEditor.readSelection(from: pasteboard, type: .string))
        XCTAssertEqual(enabledEditor.string, "Restoring draft recovered")
    }

    @MainActor func testSpeculativeMeasurementDoesNotChangeTheDisplayedTextWidth() throws {
        let draft = String(repeating: "The editor should fill all of the available space. ", count: 20)
        let host = NSHostingView(rootView: ConversationTextEditor(
            text: .constant(draft), placeholder: "Message", onSend: {}, onAttachments: { _ in }, onError: { _ in }
        ).frame(maxWidth: .infinity))
        host.frame = NSRect(x: 0, y: 0, width: 720, height: 164)
        host.layoutSubtreeIfNeeded()
        let scrollView = try XCTUnwrap(firstSubview(of: NSScrollView.self, in: host))
        let editor = try XCTUnwrap(scrollView.documentView as? ComposerNativeTextView)
        scrollView.tile()
        let displayedFrame = editor.frame
        let displayedContainerWidth = try XCTUnwrap(editor.textContainer).containerSize.width

        // SwiftUI can ask about widths that it ultimately does not place.
        _ = ConversationTextEditor.fittingSize(width: 220, scrollView: scrollView)
        XCTAssertEqual(editor.frame, displayedFrame)
        XCTAssertEqual(editor.textContainer?.containerSize.width, displayedContainerWidth)

        host.setFrameSize(NSSize(width: 900, height: 164))
        host.layoutSubtreeIfNeeded()
        scrollView.tile()
        XCTAssertEqual(editor.frame.width, scrollView.contentSize.width, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(editor.textContainer).containerSize.width,
                       scrollView.contentSize.width - editor.textContainerInset.width * 2, accuracy: 0.5)
    }

    @MainActor func testPlainEditorNegotiatesAndReadsImageOnlyPasteboards() async throws {
        let editor = ComposerNativeTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 100))
        editor.isRichText = false
        editor.importsGraphics = false
        editor.string = "Keep this draft"
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        for (pasteboardType, imageType) in [(NSPasteboard.PasteboardType.png, NSBitmapImageRep.FileType.png),
                                           (.tiff, .tiff), (.init("public.jpeg"), .jpeg)] {
            pasteboard.clearContents()
            XCTAssertTrue(pasteboard.setData(try clipboardImage(using: imageType), forType: pasteboardType))
            // AppKit may negotiate a synthesized TIFF representation for JPEG.
            // Verify that its chosen representation becomes an attachment.
            let type = try XCTUnwrap(editor.preferredPasteboardType(from: pasteboard.types ?? [], restrictedToTypesFrom: nil))

            let received = expectation(description: "Image attachment prepared")
            editor.onAttachments = { attachments in
                XCTAssertEqual(attachments.count, 1)
                XCTAssertEqual(attachments.first?.kind, .image)
                received.fulfill()
            }
            editor.onError = { error in XCTFail(error) }
            XCTAssertTrue(editor.readSelection(from: pasteboard, type: type))
            await fulfillment(of: [received], timeout: 5)
            XCTAssertEqual(editor.string, "Keep this draft", "Images should be attachments rather than rich text inside the editor.")
        }
    }

    @MainActor func testPlainTextPasteStillInsertsTextAtTheSelection() throws {
        let editor = ComposerNativeTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 100))
        editor.isRichText = false
        editor.string = "Before after"
        editor.setSelectedRange(NSRange(location: 7, length: 0))
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        XCTAssertTrue(pasteboard.setString("pasted ", forType: .string))
        XCTAssertTrue(editor.readSelection(from: pasteboard, type: .string))
        XCTAssertEqual(editor.string, "Before pasted after")
    }

    @MainActor func testJPEGDragBecomesAnAttachmentAndPreservesTheDraft() async throws {
        let editor = ComposerNativeTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 100))
        editor.isRichText = false
        editor.importsGraphics = false
        editor.string = "Review this image with my draft"
        let selection = NSRange(location: 7, length: 4)
        editor.setSelectedRange(selection)
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        XCTAssertTrue(pasteboard.setData(try clipboardImage(using: .jpeg), forType: .init("public.jpeg")))
        let drag = ComposerTestDraggingInfo(pasteboard: pasteboard)
        let received = expectation(description: "JPEG drag prepared as an image attachment")
        editor.onAttachments = { attachments in
            XCTAssertEqual(attachments.count, 1)
            XCTAssertEqual(attachments.first?.kind, .image)
            XCTAssertEqual(attachments.first?.input["type"].string, "image")
            XCTAssertTrue(attachments.first?.input["url"].string.hasPrefix("data:image/") == true)
            received.fulfill()
        }
        editor.onError = { error in XCTFail(error); received.fulfill() }

        XCTAssertEqual(editor.draggingEntered(drag), .copy)
        XCTAssertEqual(editor.draggingUpdated(drag), .copy)
        XCTAssertTrue(editor.prepareForDragOperation(drag))
        XCTAssertTrue(editor.performDragOperation(drag))
        await fulfillment(of: [received], timeout: 5)
        XCTAssertEqual(editor.string, "Review this image with my draft")
        XCTAssertEqual(editor.selectedRange(), selection)
    }

    @MainActor func testTextFileDragBecomesTextContextAndPreservesTheDraft() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("Review.swift")
        let source = "struct Eagle { let emoji = \"🦅\" }\n"
        try Data(source.utf8).write(to: file)
        let editor = ComposerNativeTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 100))
        editor.isRichText = false
        editor.importsGraphics = false
        editor.string = "Review this source file"
        let selection = NSRange(location: 4, length: 0)
        editor.setSelectedRange(selection)
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        XCTAssertTrue(pasteboard.writeObjects([file as NSURL]))
        let drag = ComposerTestDraggingInfo(pasteboard: pasteboard)
        let received = expectation(description: "File URL drag prepared as text context")
        editor.onAttachments = { attachments in
            XCTAssertEqual(attachments.count, 1)
            XCTAssertEqual(attachments.first?.kind, .text)
            XCTAssertEqual(attachments.first?.name, "Review.swift")
            XCTAssertEqual(attachments.first?.text, source)
            XCTAssertEqual(attachments.first?.input["type"].string, "text")
            XCTAssertEqual(attachments.first?.input["text"].string, "Attached text file: Review.swift\n\n\(source)")
            received.fulfill()
        }
        editor.onError = { error in XCTFail(error); received.fulfill() }

        XCTAssertEqual(editor.draggingEntered(drag), .copy)
        XCTAssertEqual(editor.draggingUpdated(drag), .copy)
        XCTAssertTrue(editor.prepareForDragOperation(drag))
        XCTAssertTrue(editor.performDragOperation(drag))
        await fulfillment(of: [received], timeout: 5)
        XCTAssertEqual(editor.string, "Review this source file")
        XCTAssertEqual(editor.selectedRange(), selection)
    }

    @MainActor private func firstSubview<T: NSView>(of type: T.Type, in view: NSView) -> T? {
        if let result = view as? T { return result }
        return view.subviews.lazy.compactMap { self.firstSubview(of: type, in: $0) }.first
    }

    @MainActor private func clipboardImage(using type: NSBitmapImageRep.FileType) throws -> Data {
        let image = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2,
            bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0))
        return try XCTUnwrap(image.representation(using: type, properties: [:]))
    }

    @MainActor func testEditorGrowsForWrappingAndTrailingNewlinesAndShrinksAfterDeletion() {
        let editor = ComposerNativeTextView(frame: NSRect(x: 0, y: 0, width: 600, height: 44))
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.widthTracksTextView = true
        editor.font = .systemFont(ofSize: 15)
        editor.textContainerInset = NSSize(width: 12, height: 10)
        editor.textContainer?.lineFragmentPadding = 0
        let empty = editor.fittingComposerHeight(width: 600)
        XCTAssertLessThan(empty, 60, "An empty composer should be a compact input.")
        editor.string = "A short draft\n\n"
        XCTAssertGreaterThan(editor.fittingComposerHeight(width: 600), empty)
        editor.string = String(repeating: "A draft with wrapped words. ", count: 8)
        let wide = editor.fittingComposerHeight(width: 800)
        XCTAssertGreaterThan(editor.fittingComposerHeight(width: 220), wide)
        editor.string = ""
        XCTAssertEqual(editor.fittingComposerHeight(width: 600), empty)
    }

    @MainActor func testEditorHonorsLargerFontsAndCapsLongDraftHeight() {
        let editor = ComposerNativeTextView(frame: NSRect(x: 0, y: 0, width: 600, height: 44))
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.widthTracksTextView = true
        editor.textContainerInset = NSSize(width: 12, height: 10)
        editor.font = .systemFont(ofSize: 15)
        editor.string = "One line\nAnother line"
        let regular = editor.fittingComposerHeight(width: 600)
        editor.font = .systemFont(ofSize: 28)
        XCTAssertGreaterThan(editor.fittingComposerHeight(width: 600), regular)
        editor.string = String(repeating: "A long draft\n", count: 100)
        XCTAssertEqual(editor.fittingComposerHeight(width: 600), ComposerNativeTextView.maximumComposerHeight)
    }

    @MainActor func testCappedDraftFitsInsideBothLegacyAndOverlayScrollbars() throws {
        for style in [NSScroller.Style.legacy, .overlay] {
            let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 360, height: 164))
            scrollView.borderType = .noBorder
            scrollView.hasVerticalScroller = true
            scrollView.autohidesScrollers = false
            scrollView.scrollerStyle = style
            let editor = ComposerNativeTextView(frame: .zero)
            editor.isVerticallyResizable = true
            editor.isHorizontallyResizable = false
            editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
            editor.autoresizingMask = [.width]
            editor.textContainer?.widthTracksTextView = true
            editor.textContainerInset = NSSize(width: 12, height: 10)
            editor.textContainer?.lineFragmentPadding = 0
            editor.font = .systemFont(ofSize: 15)
            scrollView.documentView = editor
            scrollView.tile()
            editor.string = String(repeating: "A long draft must wrap inside its viewport. ", count: 100)
            let size = try XCTUnwrap(ConversationTextEditor.fittingSize(width: 360, scrollView: scrollView))
            XCTAssertEqual(size.width, 360)
            XCTAssertEqual(editor.frame.width, scrollView.contentSize.width, accuracy: 0.5)
            let layoutManager = try XCTUnwrap(editor.layoutManager)
            let textContainer = try XCTUnwrap(editor.textContainer)
            layoutManager.ensureLayout(for: textContainer)
            let usedWidth = layoutManager.usedRect(for: textContainer).maxX
            XCTAssertLessThanOrEqual(usedWidth + 24, scrollView.contentSize.width + 0.5)
        }
    }

    func testSkillAliasMatchesWholeSlashTokenOnce() {
        let skill = JSON.object(["id": .string("review-id"), "alias": .string("review" )])
        XCTAssertEqual(ConversationCatalog.selectedSkills("/review check /review", skills: [skill]).count, 1)
        XCTAssertTrue(ConversationCatalog.selectedSkills("/review/docs /reviewer /tmp/review", skills: [skill]).isEmpty)
    }

    func testRestoredPermissionsRequireLiveProviderCapability() {
        let project = Project(.object(["id": .string("p"), "default_provider": .string("a"), "agents": .array([
            .object(["provider": .string("a"), "capabilities": .object(["permission_modes": .array([.string("default")]), "sandbox_modes": .array([.string("read-only")])])])
        ])]))
        let selection = NativeComposerSelection(fields: ["permission_mode": .string("bypassPermissions"), "approval_policy": .string("never"), "sandbox_mode": .string("danger-full-access")])
        let validated = selection.validated(project: project, provider: "a")
        XCTAssertNil(validated.fields["permission_mode"])
        XCTAssertNil(validated.fields["approval_policy"])
        XCTAssertNil(validated.fields["sandbox_mode"])
    }

    func testChangingModelResetsEffortAndSpeed() {
        var selection = NativeComposerSelection(fields: ["reasoning_effort": .string("high"), "service_tier": .string("fast")])
        selection.select("model_id", value: "different", provider: "agent")
        XCTAssertEqual(selection.fields["model_id"], .string("different"))
        XCTAssertEqual(selection.fields["reasoning_effort"], .null)
        // Omitting the field leaves an existing task's speed unchanged.
        XCTAssertEqual(selection.fields["service_tier"], .null)
    }

    func testExistingTaskDoesNotInheritNewTaskPermissionAndModelPicks() {
        let project = Project(.object(["id": .string("p")]))
        let task = AgentTask(.object(["id": .string("existing"), "agent": .object([
            "model_id": .string("task-model"), "permission_mode": .string("default"), "sandbox_mode": .string("read-only")
        ])]))
        let stored = NativeComposerSelection(fields: ["model_id": .string("preferred-model"), "permission_mode": .string("never"), "sandbox_mode": .string("danger-full-access")])
        let restored = NativeComposerSelection.restored(stored, task: task, project: project, provider: "codex")
        XCTAssertTrue(restored.fields.isEmpty)
        XCTAssertEqual(restored.value("model_id", task: task), "task-model")
        XCTAssertEqual(restored.value("permission_mode", task: task), "default")
        XCTAssertEqual(restored.value("sandbox_mode", task: task), "read-only")
        XCTAssertEqual(NativeComposerSelection.restored(NativeComposerSelection(fields: ["model_id": .string("preferred-model")]), task: nil, project: project, provider: "codex").fields["model_id"], .string("preferred-model"))
    }

    func testEffortValidationUsesExistingTaskModelInsteadOfProviderDefault() {
        func model(_ id: String, effort: String, isDefault: Bool) -> JSON {
            .object(["id": .string(id), "is_default": .bool(isDefault), "supported_reasoning_efforts": .array([
                .object(["reasoning_effort": .string(effort)])
            ])])
        }
        let project = Project(.object(["id": .string("p"), "default_provider": .string("codex"), "models": .array([
            model("default-model", effort: "low", isDefault: true), model("task-model", effort: "high", isDefault: false)
        ])]))
        let task = AgentTask(.object(["id": .string("t"), "agent": .object(["model_id": .string("task-model")])]))
        let selection = NativeComposerSelection(fields: ["reasoning_effort": .string("high")])
        XCTAssertEqual(selection.validated(project: project, provider: "codex", task: task).fields["reasoning_effort"], .string("high"))
        XCTAssertNil(selection.validated(project: project, provider: "codex").fields["reasoning_effort"])
    }

    func testSavedPromptInsertionKeepsArgumentsAndEarlierLines() {
        let prompt = ConversationSlashItem(raw: .object(["id": .string("test"), "alias": .string("/test"), "body": .string("Run tests for $ARGUMENTS")]), isPrompt: true)
        XCTAssertEqual(ConversationSlash.insert(prompt, into: "Earlier text\n/test networking"), "Earlier text\nRun tests for networking")
        XCTAssertEqual(ConversationSlash.expandPrompt("Review this code", arguments: "networking"), "Review this code\n\nnetworking")
        XCTAssertNil(ConversationSlash.query("/Users/James/project"))
    }

    func testExportPreservesEmbeddedFencesAndMarksPartialHistory() {
        let message = Message(.object(["id": .string("tool"), "kind": .string("tool_call"), "output": .string("```nested```"), "title": .string("Run test")]))
        let export = ConversationExport.markdown([message], title: "Example", partial: true)
        XCTAssertTrue(export.contains("Partial export"))
        XCTAssertTrue(export.contains("````text\n```nested```\n````"))
    }
}

@MainActor private final class ComposerTestDraggingInfo: NSObject, NSDraggingInfo {
    let draggingPasteboard: NSPasteboard
    var draggingDestinationWindow: NSWindow? { nil }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggingLocation: NSPoint { .zero }
    var draggedImageLocation: NSPoint { .zero }
    nonisolated var draggedImage: NSImage? { nil }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 1 }
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }

    init(pasteboard: NSPasteboard) { draggingPasteboard = pasteboard }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    nonisolated override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
    func resetSpringLoading() {}
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions, for view: NSView?,
        classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any],
        using block: @escaping (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
}
