import AppKit
import SwiftUI

/// Buttons remain clickable while the destination editor keeps keyboard focus.
@MainActor final class NativeSpeechPanel: NSPanel {
    private let controller: NativeSpeechController

    init(controller: NativeSpeechController) {
        self.controller = controller
        super.init(contentRect: NSRect(x: 0, y: 0, width: 660, height: 260),
                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        isFloatingPanel = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        animationBehavior = .utilityWindow
        contentView = NSHostingView(rootView: NativeSpeechOverlay(controller: controller))
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func show() {
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(pointer) } ?? NSScreen.main
        if let screen {
            let visible = screen.visibleFrame
            let width = min(660, max(320, visible.width - 32))
            let height: CGFloat = controller.isRecording || controller.isBusy ? 104 : controller.hasPendingTranscript ? 260 : 170
            setFrame(NSRect(x: visible.midX - width / 2, y: visible.maxY - height - 14,
                            width: width, height: min(height, visible.height - 28)), display: true)
        }
        orderFrontRegardless()
    }
}

private struct NativeSpeechOverlay: View {
    let controller: NativeSpeechController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: controller.isRecording ? "waveform" : controller.isBusy ? "sparkles" : "text.bubble")
                    .foregroundStyle(FDTheme.accent)
                    .font(.system(size: 18))
                Text(controller.status)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(FDTheme.foreground)
                    .lineLimit(controller.isRecording || controller.isBusy ? 2 : 3)
                Spacer(minLength: 4)
                if controller.isBusy { ProgressView().controlSize(.small) }
                if !controller.isBusy && !controller.isRecording {
                    Button { controller.dismissOverlay() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain)
                        .help("Dismiss")
                }
            }
            if controller.isRecording {
                HStack(spacing: 10) {
                    ProgressView(value: controller.audioLevel)
                        .tint(FDTheme.accent)
                    Button("Finish") { controller.startOrStop() }
                    Button("Cancel") { controller.cancel() }
                }
                .controlSize(.small)
            } else if controller.isBusy {
                HStack {
                    Text("Your recording stays available if transcription fails.")
                        .font(.caption).foregroundStyle(FDTheme.muted)
                    Spacer()
                    Button("Cancel") { controller.cancel() }.controlSize(.small)
                }
            } else {
                if controller.hasPendingTranscript {
                    ScrollView {
                        Text(controller.lastTranscript)
                            .font(.system(size: 13))
                            .foregroundStyle(FDTheme.foreground)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 120)
                }
                HStack(spacing: 8) {
                    if controller.canUndo {
                        Button("Undo cancellation") { controller.undoCancellation() }
                    }
                    if controller.hasPendingTranscript {
                        Button("Retry paste") { controller.pastePending() }
                            .buttonStyle(.borderedProminent)
                        Button("Copy") { controller.copyTranscript() }
                        Button("Fix") { controller.fixTranscript() }
                            .disabled(!controller.keyConfigured)
                    }
                    if controller.hasPendingRecording && !controller.canUndo {
                        Button("Retry transcription") { controller.retryPending() }
                            .disabled(!controller.pendingIsReadable)
                    }
                    Spacer(minLength: 0)
                    if controller.hasPendingRecording || controller.canUndo {
                        Button("Discard", role: .destructive) { controller.discardPending() }
                    }
                }
                .controlSize(.small)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(FDTheme.raised.opacity(0.98), in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(FDTheme.line))
        .padding(3)
        .tint(FDTheme.accent)
        .preferredColorScheme(.dark)
    }
}
