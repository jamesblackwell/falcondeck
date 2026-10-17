import SwiftUI
import Photos
import ImageIO

struct MediaImageView: View {
    @Environment(AppModel.self) private var model
    let reference: JSON
    var itemID: String? = nil
    var task: AgentTask? = nil
    var lifecycle = ""
    nonisolated init(reference: JSON, itemID: String? = nil, task: AgentTask? = nil, lifecycle: String = "") {
        self.reference = reference; self.itemID = itemID; self.task = task; self.lifecycle = lifecycle
    }
    @State private var bytes: Data?
    @State private var image: UIImage?
    @State private var error: String?
    @State private var loading = false
    @State private var preview = false
    @State private var loadID = UUID()
    @State private var activeSource: String?
    @State private var loadedSource: String?
    private var sourceKey: String { "\(lifecycle):\(reference["url"].string):\(reference["local_path"].string)" }
    private var label: String { reference["alt_text"].string.nonempty ?? reference["name"].string.nonempty ?? "Image" }
    var body: some View {
        Group {
            if let image {
                Button { preview = true } label: {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 320).clipShape(.rect(cornerRadius: 12))
                }.buttonStyle(.plain).accessibilityLabel("Preview \(label)")
            } else {
                Button { Task { await load() } } label: {
                    HStack(spacing: 8) {
                        if loading || ["pending", "streaming"].contains(lifecycle) { ActivityDiamond() } else { Image(systemName: "photo") }
                        Text(["pending", "streaming"].contains(lifecycle) ? "Generating image…" : error == nil ? "Load \(label)" : "Couldn't load image · Retry").font(.footnote)
                    }.padding(20).frame(maxWidth: .infinity).background(FD.raised, in: .rect(cornerRadius: 12))
                }.buttonStyle(.plain).disabled(loading)
            }
        }
        .task(id: sourceKey) { await load() }
        .sheet(isPresented: $preview) { if let bytes, let image { ImageDetailView(data: bytes, image: image, title: label) } }
    }
    private func load() async {
        let sourceIdentity = sourceKey
        guard loadedSource != sourceIdentity || image == nil else { return }
        guard activeSource != sourceIdentity || !loading else { return }
        let id = UUID(); loadID = id; activeSource = sourceIdentity
        image = nil; bytes = nil; error = nil
        if ["pending", "streaming"].contains(lifecycle), reference["url"].string.isEmpty { loading = false; activeSource = nil; return }
        loading = true
        defer { if loadID == id { loading = false; activeSource = nil } }
        do {
            var source = reference["url"].string
            if MediaURL.data(source) == nil, MediaURL.external(source) == nil, let task, let itemID {
                let item = try await model.fullItem(task, itemID: itemID)
                if item["kind"].string == "image" { source = item["image"]["url"].string }
                else {
                    source = item["attachments"].array.first(where: { $0["id"] == reference["id"] })?["url"].string ?? ""
                }
            }
            let data: Data
            if let decoded = MediaURL.data(source) { data = decoded }
            else if let url = MediaURL.external(source) {
                data = try await BoundedImageDownload.shared.download(url)
            } else { throw PilotError("This image is unavailable on this device.") }
            let thumbnail = try await Task.detached { try NativeAttachment.prepare(data).data }.value
            guard loadID == id, !Task.isCancelled, let decoded = UIImage(data: thumbnail) else { return }
            bytes = data; image = decoded; loadedSource = sourceIdentity
        } catch { if loadID == id, !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private struct ImageDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let data: Data
    let image: UIImage
    let title: String
    @State private var scale: CGFloat = 1
    @GestureState private var magnification: CGFloat = 1
    @State private var saving = false
    @State private var saved = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                let width = min(geometry.size.width - 32, image.size.width)
                let zoom = max(1, min(scale * magnification, 8))
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image).resizable().scaledToFit()
                        .frame(width: width * zoom, height: width * zoom * image.size.height / max(1, image.size.width))
                        .frame(minWidth: geometry.size.width, minHeight: geometry.size.height)
                        .gesture(MagnifyGesture().updating($magnification) { value, state, _ in state = value.magnification }.onEnded { value in scale = max(1, min(scale * value.magnification, 8)) })
                        .onTapGesture(count: 2) { withAnimation { scale = scale > 1 ? 1 : 2 } }
                }
            }.background(FD.background).navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .safeAreaInset(edge: .bottom) { if let error { Text(error).font(.footnote).foregroundStyle(.orange).padding() } }
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                    ToolbarItemGroup(placement: .bottomBar) {
                        ShareLink(item: Image(uiImage: image), preview: SharePreview(title, image: Image(uiImage: image))) { Label("Share", systemImage: "square.and.arrow.up") }
                        Spacer()
                        Button(saved ? "Saved" : "Save to Photos", systemImage: saved ? "checkmark" : "square.and.arrow.down") { Task { await save() } }.disabled(saving || saved)
                    }
                }
        }
    }
    private func save() async {
        saving = true; error = nil; defer { saving = false }
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { error = "Allow Photos access in Settings to save this image."; return }
        do {
            try await PHPhotoLibrary.shared().performChanges { PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil) }
            saved = true
        } catch { self.error = error.localizedDescription }
    }
}
