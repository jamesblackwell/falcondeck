import AppKit
import SwiftUI

/// Let AppKit restore the user's column widths instead of imposing the ideal
/// SwiftUI widths again whenever a workspace is reopened.
struct NativeSplitViewPersistence: NSViewRepresentable {
    let name: String

    func makeNSView(context: Context) -> NSView { NSView(frame: .zero) }

    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async {
            var ancestor = view.superview
            while let current = ancestor {
                if let split = current as? NSSplitView {
                    if split.autosaveName != name { split.autosaveName = name }
                    return
                }
                ancestor = current.superview
            }
        }
    }
}
