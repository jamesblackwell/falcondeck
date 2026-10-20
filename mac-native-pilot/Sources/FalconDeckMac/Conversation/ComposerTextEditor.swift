import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// A plain native text editor preserves normal text editing, input methods,
/// undo and selection while accepting file/image paste and drop operations.
@MainActor struct ConversationTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Bindable private var preferences = NativePreferences.shared
    let placeholder: String
    let onSend: () -> Void
    let onAttachments: ([NativeMacAttachment]) -> Void
    let onError: (String) -> Void
    var onAlternateSend: (() -> Void)? = nil

    init(text: Binding<String>, placeholder: String, onSend: @escaping () -> Void,
         onAttachments: @escaping ([NativeMacAttachment]) -> Void, onError: @escaping (String) -> Void,
         onAlternateSend: (() -> Void)? = nil) {
        self._text = text
        self.placeholder = placeholder
        self.onSend = onSend
        self.onAttachments = onAttachments
        self.onError = onError
        self.onAlternateSend = onAlternateSend
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder

        let editor = ComposerNativeTextView(frame: .zero)
        editor.delegate = context.coordinator
        context.coordinator.editor = editor
        editor.isRichText = false
        editor.importsGraphics = false
        editor.allowsImageEditing = false
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.isAutomaticLinkDetectionEnabled = false
        editor.smartInsertDeleteEnabled = false
        editor.allowsUndo = true
        editor.drawsBackground = false
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.minSize = .zero
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.autoresizingMask = [.width]
        editor.textContainerInset = NSSize(width: 12, height: 10)
        editor.textContainer?.containerSize = NSSize(width: scrollView.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.lineFragmentPadding = 0
        editor.font = preferences.nativeFont(size: 15, surface: "chat")
        editor.setAccessibilityLabel("Message")
        editor.setAccessibilityIdentifier("conversation-composer")
        editor.registerForDraggedTypes([.fileURL, .png, .tiff, .string])
        scrollView.documentView = editor
        update(editor, coordinator: context.coordinator)
        return scrollView
    }

    func updateNSView(_ view: NSScrollView, context: Context) {
        guard let editor = view.documentView as? ComposerNativeTextView else { return }
        update(editor, coordinator: context.coordinator)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        return Self.fittingSize(width: width, scrollView: nsView)
    }

    static func fittingSize(width: CGFloat, scrollView: NSScrollView) -> CGSize? {
        guard let editor = scrollView.documentView as? ComposerNativeTextView else { return nil }
        // Legacy scrollers occupy layout space; overlay scrollers do not.
        // Measure and wrap against the clip area, not the outer scroll view.
        let contentSize = NSScrollView.contentSize(
            forFrameSize: NSSize(width: width, height: ComposerNativeTextView.maximumComposerHeight),
            horizontalScrollerClass: nil,
            verticalScrollerClass: scrollView.hasVerticalScroller ? NSScroller.self : nil,
            borderType: scrollView.borderType,
            controlSize: scrollView.verticalScroller?.controlSize ?? .regular,
            scrollerStyle: scrollView.scrollerStyle
        )
        return CGSize(width: width, height: editor.fittingComposerHeight(width: max(1, contentSize.width)))
    }

    private func update(_ editor: ComposerNativeTextView, coordinator: Coordinator) {
        coordinator.parent = self
        editor.placeholder = placeholder
        editor.onSend = onSend
        editor.onAlternateSend = onAlternateSend
        editor.onAttachments = onAttachments
        editor.onError = onError
        let sendKey = preferences.bindings(for: "sendMessage").first.map(NativeShortcutDefinition.display) ?? "Return"
        let newlineKey = preferences.bindings(for: "insertNewline").first.map(NativeShortcutDefinition.display) ?? "Shift + Return"
        editor.toolTip = "\(sendKey) to send · \(newlineKey) for a new line"
        editor.textColor = NSColor(FDTheme.foreground)
        editor.insertionPointColor = NSColor(FDTheme.foreground)
        editor.placeholderColor = NSColor(FDTheme.subtle)
        let font = preferences.nativeFont(size: 15, surface: "chat")
        if editor.font != font { editor.font = font }
        if editor.string != text {
            let selection = editor.selectedRange()
            editor.string = text
            let length = (text as NSString).length
            let location = min(selection.location, length)
            editor.setSelectedRange(NSRange(location: location, length: min(selection.length, length - location)))
        }
        var attributes = editor.typingAttributes
        attributes[.font] = font
        attributes[.foregroundColor] = NSColor(FDTheme.foreground)
        editor.typingAttributes = attributes
        editor.needsDisplay = true
    }

    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ConversationTextEditor
        weak var editor: ComposerNativeTextView?
        init(_ parent: ConversationTextEditor) {
            self.parent = parent
            super.init()
            NotificationCenter.default.addObserver(self, selector: #selector(commandReceived(_:)), name: Notification.Name("native.command"), object: nil)
        }
        deinit { NotificationCenter.default.removeObserver(self) }
        @objc private func commandReceived(_ notification: Notification) {
            guard notification.object as? String == "focusComposer", let editor,
                  let window = editor.window, window.isKeyWindow else { return }
            window.makeFirstResponder(editor)
            editor.scrollRangeToVisible(editor.selectedRange())
        }
        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            parent.text = editor.string
            editor.needsDisplay = true
        }
    }
}

@MainActor final class ComposerNativeTextView: NSTextView {
    static let maximumComposerHeight: CGFloat = 164
    var placeholder = ""
    var placeholderColor = NSColor.placeholderTextColor
    var onSend: () -> Void = {}
    var onAlternateSend: (() -> Void)?
    var onAttachments: ([NativeMacAttachment]) -> Void = { _ in }
    var onError: (String) -> Void = { _ in }

    /// Use TextKit's cached layout rather than writing SwiftUI state during
    /// layout. The editor grows with wrapped text, then scrolls at the cap.
    func fittingComposerHeight(width: CGFloat) -> CGFloat {
        guard let textContainer, let layoutManager else { return 44 }
        // widthTracksTextView makes the text view authoritative. Keep its
        // frame in sync with the proposed width before asking TextKit to wrap.
        if frame.width != width { setFrameSize(NSSize(width: width, height: frame.height)) }
        let availableWidth = max(1, width - textContainerInset.width * 2)
        if textContainer.containerSize.width != availableWidth {
            textContainer.containerSize = NSSize(width: availableWidth, height: .greatestFiniteMagnitude)
        }
        layoutManager.ensureLayout(for: textContainer)
        let textHeight = max(layoutManager.usedRect(for: textContainer).maxY,
                             layoutManager.extraLineFragmentRect.maxY)
        return min(Self.maximumComposerHeight, max(44, ceil(textHeight + textContainerInset.height * 2)))
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window else { return }
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window, self.window === window,
                  window.firstResponder == nil || window.firstResponder === window else { return }
            window.makeFirstResponder(self)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 16), .foregroundColor: placeholderColor
        ]
        (placeholder as NSString).draw(
            at: NSPoint(x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0), y: textContainerInset.height),
            withAttributes: attributes
        )
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if window?.firstResponder === self, handleComposerShortcut(event) { return true }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if handleComposerShortcut(event) { return }
        super.keyDown(with: event)
    }

    override func paste(_ sender: Any?) {
        if consumeAttachments(from: .general) { return }
        super.paste(sender)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        canAttach(sender.draggingPasteboard) ? .copy : super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        canAttach(sender.draggingPasteboard) ? .copy : super.draggingUpdated(sender)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        canAttach(sender.draggingPasteboard) || super.prepareForDragOperation(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        consumeAttachments(from: sender.draggingPasteboard) || super.performDragOperation(sender)
    }

    /// The app dispatcher consumes configured commands first. This responder
    /// path also supports the editor in auxiliary windows and standalone hosts.
    /// Returning true prevents AppKit from subsequently delivering keyDown for
    /// the same key equivalent.
    func handleComposerShortcut(_ event: NSEvent, preferences: NativePreferences? = nil) -> Bool {
        guard !hasMarkedText(), let binding = NativeShortcutDefinition.binding(from: event) else { return false }
        let preferences = preferences ?? NativePreferences.shared
        if preferences.bindings(for: "insertNewline").contains(binding) {
            insertNewline(nil)
            return true
        }
        if preferences.bindings(for: "invertFollowUp").contains(binding) {
            if !event.isARepeat { (onAlternateSend ?? onSend)() }
            return true
        }
        if preferences.bindings(for: "sendMessage").contains(binding) {
            if !event.isARepeat { onSend() }
            return true
        }
        return false
    }

    private func canAttach(_ pasteboard: NSPasteboard) -> Bool {
        pasteboard.availableType(from: [.fileURL, .png, .tiff, NSPasteboard.PasteboardType(UTType.jpeg.identifier)]) != nil
    }

    private func consumeAttachments(from pasteboard: NSPasteboard) -> Bool {
        if let files = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !files.isEmpty {
            let receive = onAttachments, report = onError
            Task {
                let result = await Task.detached(priority: .userInitiated) { ConversationAttachmentLoader.load(files) }.value
                if !result.attachments.isEmpty { receive(result.attachments) }
                if let error = result.error { report(error) }
            }
            return true
        }
        let imageTypes: [NSPasteboard.PasteboardType] = [.png, .tiff, .init(UTType.jpeg.identifier)]
        if let type = pasteboard.availableType(from: imageTypes), let data = pasteboard.data(forType: type) {
            let receive = onAttachments, report = onError
            Task {
                do {
                    let attachment = try await Task.detached(priority: .userInitiated) {
                        try NativeMacAttachment.prepare(data, name: "Clipboard image.png")
                    }.value
                    receive([attachment])
                } catch { report(error.localizedDescription) }
            }
            return true
        }
        return false
    }
}
