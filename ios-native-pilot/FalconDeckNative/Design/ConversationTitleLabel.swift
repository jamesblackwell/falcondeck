import SwiftUI

/// Navigation glass can change appearance independently of the app palette as
/// content passes underneath. Semantic foregrounds participate in its vibrancy;
/// a palette RGB color does not, and can disappear against the adapted material.
struct ConversationTitleLabel: View {
    let title: String
    var projectPicker = false
    /// A bot's mark, shown before its name.
    var icon: NativeBotIcon? = nil
    /// Bot titles open the bot's sheet, so they get the picker's touch target.
    var interactive = false
    var body: some View {
        HStack(spacing: 6) {
            if let icon { BotMark(icon: icon, size: 14) }
            Text(title).font(.subheadline.weight(.semibold)).lineLimit(1).truncationMode(.tail)
            if projectPicker || interactive {
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 14).frame(minHeight: projectPicker || interactive ? 44 : 36)
        .glassEffect(projectPicker || interactive ? .regular.interactive() : .regular, in: .capsule)
    }
}
