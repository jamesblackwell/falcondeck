import SwiftUI

/// Navigation glass can change appearance independently of the app palette as
/// content passes underneath. Semantic foregrounds participate in its vibrancy;
/// a palette RGB color does not, and can disappear against the adapted material.
struct ConversationTitleLabel: View {
    let title: String
    var projectPicker = false
    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold)).lineLimit(1).truncationMode(.tail)
            if projectPicker {
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 14).frame(minHeight: projectPicker ? 44 : 36)
        .glassEffect(projectPicker ? .regular.interactive() : .regular, in: .capsule)
    }
}
