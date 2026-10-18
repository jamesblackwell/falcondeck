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
    @State private var display = ImageDisplay()
    @State private var preview = false
    private var resource: MediaImageResource { MediaImageResource(reference: reference, task: task, itemID: itemID, lifecycle: lifecycle) }
    private var trigger: ImageLoadTrigger { ImageLoadTrigger(resource: resource, scope: model.sessionScope, connection: model.connectionID, cache: model.sessionCache.map(ObjectIdentifier.init), connected: model.connected, foreground: model.foreground) }
    private var label: String { reference["alt_text"].string.nonempty ?? reference["name"].string.nonempty ?? "Image" }
    var body: some View {
        ZStack {
            if let image = display.image {
                Button { preview = true } label: {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 320).clipShape(.rect(cornerRadius: 12))
                }.buttonStyle(.plain).accessibilityLabel("Preview \(label)")
            } else {
                Button { Task { await display.load(resource, model: model) } } label: {
                    HStack(spacing: 8) {
                        if display.loading || resource.generating { ActivityDiamond() } else { Image(systemName: "photo") }
                        Text(resource.generating ? "Generating image…" : display.loading ? "Loading \(label)…" : display.error == nil ? "Load \(label)" : "Couldn't load image · Retry").font(.footnote)
                    }.padding(20).frame(maxWidth: .infinity).background(FD.raised, in: .rect(cornerRadius: 12))
                }.buttonStyle(.plain).disabled(display.loading)
            }
        }
        .task(id: trigger) { await display.load(resource, model: model, foreground: model.foreground) }
        .sheet(isPresented: $preview) { if let bytes = display.bytes, let image = display.image { ImageDetailView(data: bytes, image: image, title: label) } }
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
                        ShareLink(item: ExportedImage(data: data, title: title), preview: SharePreview(title, image: Image(uiImage: image))) { Label("Share", systemImage: "square.and.arrow.up") }
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
