import AppKit
import SwiftUI
import XCTest
@testable import FalconDeckMac

final class ConversationComposerTests: XCTestCase {
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

    @MainActor func testPlainEditorNegotiatesAndReadsAnImageOnlyPasteboard() async throws {
        let editor = ComposerNativeTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 100))
        editor.isRichText = false
        editor.importsGraphics = false
        editor.string = "Keep this draft"
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        let image = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0))
        let png = try XCTUnwrap(image.representation(using: .png, properties: [:]))
        XCTAssertTrue(pasteboard.setData(png, forType: .png))
        let type = try XCTUnwrap(editor.preferredPasteboardType(from: pasteboard.types ?? [], restrictedToTypesFrom: nil))
        XCTAssertEqual(type, .png, "The normal AppKit Paste action must consider image-only clipboard data readable.")

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

    @MainActor private func firstSubview<T: NSView>(of type: T.Type, in view: NSView) -> T? {
        if let result = view as? T { return result }
        return view.subviews.lazy.compactMap { self.firstSubview(of: type, in: $0) }.first
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
        XCTAssertLessThanOrEqual(editor.fittingComposerHeight(width: 600), 180)
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
