import SwiftUI

/// Both navigation columns share the same bottom edge and control baseline.
struct NativeSidebarFooter<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        HStack(spacing: 8) { content }
            .font(NativePreferences.shared.font(size: 13, surface: "sidebar"))
            .foregroundStyle(FDTheme.secondary)
            .padding(.horizontal, 12)
            .frame(height: 44)
            .overlay(alignment: .top) { FDTheme.hairline.frame(height: 1) }
    }
}
