import SwiftUI

struct NativeSyncStatus: Equatable {
    let title: String
    let detail: String
    let offline: Bool

    @MainActor static func resolve(_ model: AppModel) -> Self? {
        guard !model.demo, model.hasSession, !model.connected || !model.hasLiveSnapshot else { return nil }
        let saved = model.cachedAt != nil || !model.projects.isEmpty
        if !model.networkAvailable {
            return Self(title: "You’re offline", detail: saved ? "Showing saved projects and conversations. We’ll reconnect automatically." : "We’ll reconnect when your connection returns.", offline: true)
        }
        if model.status == "Computer offline" {
            return Self(title: "Your computer is offline", detail: saved ? "You can browse saved conversations while you wait." : "Projects will load when your computer reconnects.", offline: true)
        }
        let title: String
        switch model.status {
        case "Preparing computer…": title = "Preparing your computer…"
        case "Securing connection…": title = "Securing your connection…"
        case "Connected": title = "Loading your projects…"
        default: title = "Reconnecting…"
        }
        return Self(title: title, detail: saved ? "Showing saved projects and conversations while we sync." : "Your projects and tasks will appear here.", offline: false)
    }
}

/// Connection waits use the same quiet banner as Expo. It is informational,
/// never another connection button competing with sidebar navigation.
struct NativeSyncBanner: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if let status = NativeSyncStatus.resolve(model) {
            HStack(spacing: 10) {
                if status.offline { Image(systemName: "wifi.slash").font(.footnote).foregroundStyle(FD.secondary) }
                else { ActivityDiamond() }
                VStack(alignment: .leading, spacing: 3) {
                    Text(status.title).font(.caption.weight(.medium)).foregroundStyle(FD.foreground)
                    Text(status.detail).font(.caption).foregroundStyle(FD.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(FD.surface).overlay(alignment: .bottom) { FD.line.frame(height: 0.5) }
            .accessibilityElement(children: .combine).accessibilityIdentifier("session-sync-banner")
        }
    }
}

struct NativeLoadingState: View {
    let label: String
    var body: some View {
        VStack(spacing: 12) {
            ActivityDiamond()
            Text(label).font(.subheadline).foregroundStyle(FD.secondary)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .combine)
    }
}

/// A delayed overlay preserves the position of content already on screen.
struct NativeLoadingPill: View {
    let loading: Bool
    let label: String
    @State private var shown = false
    var body: some View {
        Group {
            if loading && shown {
                HStack(spacing: 7) { ActivityDiamond(); Text(label).font(.caption.weight(.medium)).foregroundStyle(FD.secondary) }
                    .padding(.horizontal, 14).padding(.vertical, 9).glassEffect(in: .capsule)
                    .padding(.top, 8).accessibilityElement(children: .combine).accessibilityIdentifier("loading-pill")
            }
        }
        .allowsHitTesting(false)
        .task(id: loading) {
            shown = false
            guard loading else { return }
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            shown = true
        }
    }
}
