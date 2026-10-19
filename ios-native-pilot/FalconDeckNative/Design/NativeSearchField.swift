import SwiftUI

/// UIKit's search field keeps native editing, clear-button and accessibility
/// behavior. Own its placeholder ink: searchable's prompt drops custom Text
/// colors, leaving the system's very faint hint on a palette-colored sheet.
struct NativeSearchField: UIViewRepresentable {
    @Binding var text: String
    let prompt: String
    private let ink = FD.foreground
    private let hint = FD.secondary
    private let fill = FD.raised

    func makeUIView(context: Context) -> UISearchTextField {
        let field = UISearchTextField()
        field.delegate = context.coordinator
        field.accessibilityTraits.insert(.searchField)
        field.accessibilityLabel = prompt
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed), for: .editingChanged)
        field.clearButtonMode = .whileEditing
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.returnKeyType = .search
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }
    func updateUIView(_ field: UISearchTextField, context: Context) {
        context.coordinator.owner = self
        if field.text != text { field.text = text }
        field.textColor = UIColor(ink)
        field.backgroundColor = UIColor(fill)
        field.attributedPlaceholder = NSAttributedString(string: prompt, attributes: [.foregroundColor: UIColor(hint)])
        field.leftView?.tintColor = UIColor(hint)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UISearchTextField, context: Context) -> CGSize? {
        // A safe-area inset offers all remaining height. UIKit search fields
        // need their intrinsic height here, or the field consumes the results.
        CGSize(width: proposal.width ?? max(0, uiView.intrinsicContentSize.width),
               height: max(44, uiView.intrinsicContentSize.height))
    }
    func makeCoordinator() -> Coordinator { Coordinator(owner: self) }
    final class Coordinator: NSObject, UITextFieldDelegate {
        var owner: NativeSearchField
        init(owner: NativeSearchField) { self.owner = owner }
        @objc func changed(_ field: UISearchTextField) { owner.text = field.text ?? "" }
        func textFieldShouldReturn(_ textField: UITextField) -> Bool { textField.resignFirstResponder(); return true }
    }
}
