import SwiftUI

/// An item's evidence: images in a swipeable gallery, everything else as rows.
/// Tapping opens the file viewer (or Safari for a link); nothing here reads the
/// computer except the thumbnails.
struct ReviewEvidenceGallery: View {
    let review: Review
    let item: ReviewItem
    @State private var page: String?

    private var images: [ReviewEvidence] { item.evidence.filter { $0.kind == .image && $0.reference(workspaceID: nil, threadID: nil) != nil } }
    private var others: [ReviewEvidence] { item.evidence.filter { evidence in !images.contains { $0.id == evidence.id } } }
    private var current: ReviewEvidence? { images.first { $0.id == page } ?? images.first }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !images.isEmpty { gallery }
            ForEach(others) { ReviewEvidenceRow(review: review, evidence: $0) }
        }
    }

    private var gallery: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal) {
                LazyHStack(spacing: 10) {
                    ForEach(images) { evidence in
                        ReviewEvidenceImage(review: review, evidence: evidence, index: (images.firstIndex { $0.id == evidence.id } ?? 0) + 1, count: images.count)
                            .containerRelativeFrame(.horizontal) { length, _ in images.count > 1 ? length * 0.9 : length }
                            .id(evidence.id)
                    }
                }.scrollTargetLayout()
            }
            .scrollIndicators(.hidden).scrollTargetBehavior(.viewAligned).scrollPosition(id: $page).frame(height: 252)
            .accessibilityIdentifier("review-gallery-\(item.id)")
            if let current {
                HStack(spacing: 6) {
                    Text(current.displayName).font(.footnote.weight(.medium)).foregroundStyle(FD.body)
                    if let caption = current.caption?.nonempty { Text("· \(caption)").font(.footnote).foregroundStyle(FD.secondary) }
                    Spacer(minLength: 4)
                    if images.count > 1 {
                        Text("\((images.firstIndex { $0.id == current.id } ?? 0) + 1) of \(images.count)").font(.caption.monospacedDigit()).foregroundStyle(FD.muted)
                    }
                }.lineLimit(1)
            }
        }
    }
}

/// One thumbnail: the top of a tall screenshot, the whole of a wide one.
private struct ReviewEvidenceImage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openFile) private var openFile
    let review: Review
    let evidence: ReviewEvidence
    let index: Int
    let count: Int
    @State private var image: UIImage?
    @State private var loading = false
    @State private var failed = false
    private var reference: FileReference? { evidence.reference(workspaceID: review.sourceWorkspaceID, threadID: review.sourceThreadID) }

    var body: some View {
        Button {
            if failed { if !loading { Task { await load() } } } else if let reference { openFile(reference) }
        } label: {
            ZStack {
                FD.background
                if let image {
                    let tall = image.size.height > 0 && image.size.width / image.size.height < 0.9
                    Color.clear.overlay(alignment: tall ? .top : .center) {
                        Image(uiImage: image).resizable().aspectRatio(contentMode: tall ? .fill : .fit)
                    }.clipped()
                    Image(systemName: "arrow.up.left.and.arrow.down.right").font(.caption.weight(.semibold)).foregroundStyle(FD.foreground)
                        .frame(width: 28, height: 28).background(.ultraThinMaterial, in: .circle)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing).padding(8).accessibilityHidden(true)
                } else if failed {
                    Label("Couldn't load · Tap to retry", systemImage: "photo.badge.exclamationmark").font(.footnote).foregroundStyle(FD.secondary)
                } else {
                    HStack(spacing: 8) { ActivityDiamond(); Text("Loading…").font(.footnote).foregroundStyle(FD.secondary) }
                }
            }
            .frame(maxWidth: .infinity).frame(height: 252).clipShape(.rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(FD.hairline))
            .contentShape(.rect(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(evidence.displayName), image \(index) of \(count)").accessibilityHint("Opens full size")
        .accessibilityIdentifier("review-evidence-\(evidence.id)")
        .task(id: reference) { if image == nil, model.connected || model.demo { await load() } }
        .onChange(of: model.connected) { _, connected in if connected, image == nil, !loading { Task { await load() } } }
    }

    private func load() async {
        guard let reference else { return }
        loading = true; failed = false
        defer { loading = false }
        do {
            let file = try await model.files.open(reference, probe: .firstRange)
            let decoded = await Task.detached(priority: .userInitiated) { FileImage.decode(file.url, maxPixel: 1400) }.value
            image = decoded; failed = decoded == nil
        } catch is CancellationError {
        } catch { failed = true }
    }
}

/// A document, file or link: a one-line row that opens it.
private struct ReviewEvidenceRow: View {
    @Environment(\.openFile) private var openFile
    @Environment(\.openURL) private var openURL
    let review: Review
    let evidence: ReviewEvidence
    private var reference: FileReference? { evidence.reference(workspaceID: review.sourceWorkspaceID, threadID: review.sourceThreadID) }
    private var onThisMac: Bool { evidence.linkURL.map(FileLink.isLoopback) ?? false }
    private var symbol: String {
        if evidence.kind == .url { return "link" }
        if evidence.kind == .image { return "photo" }
        return FileIcon.symbol(forName: evidence.openPath ?? evidence.displayName)
    }
    private var openable: Bool { evidence.kind == .url ? (evidence.linkURL != nil && !onThisMac) : reference != nil }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.body).foregroundStyle(FD.accent).frame(width: 34, height: 34)
                    .background(FD.accent.opacity(0.12), in: .rect(cornerRadius: 9)).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(evidence.displayName).font(.subheadline.weight(.medium)).foregroundStyle(FD.foreground).lineLimit(1)
                    Text(subtitle).font(.caption).foregroundStyle(FD.secondary).lineLimit(2).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 4)
                Image(systemName: evidence.kind == .url ? "arrow.up.right" : "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(FD.muted).accessibilityHidden(true)
            }
            .padding(.horizontal, 10).frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(FD.raised, in: .rect(cornerRadius: 12)).contentShape(.rect(cornerRadius: 12))
        }
        .buttonStyle(.plain).disabled(!openable).opacity(openable ? 1 : 0.6)
        .accessibilityIdentifier("review-evidence-\(evidence.id)")
    }
    private var subtitle: String {
        if onThisMac { return "Runs on your Mac, so it can't open here" }
        if let caption = evidence.caption?.nonempty { return caption }
        if evidence.kind == .url { return evidence.linkURL?.host ?? "Link" }
        if let size = evidence.sizeBytes { return size.formatted(.byteCount(style: .file)) }
        return evidence.kind == .image ? "Image" : "Document"
    }
    private func open() {
        if evidence.kind == .url { if let url = evidence.linkURL { openURL(url) } }
        else if let reference { openFile(reference) }
    }
}
