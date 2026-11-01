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
    @State private var saving = false
    @State private var saved = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            ZoomableImage(image: image)
                .ignoresSafeArea(edges: .bottom)
                .background(FD.background).navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .safeAreaInset(edge: .bottom) { if let error { Text(error).font(.footnote).foregroundStyle(FD.danger).padding() } }
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

/// UIKit zooming anchors the pinch under the fingers, bounces at the limits and
/// supports double-tap to zoom, which a SwiftUI magnify gesture does not.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    /// Fit the image's width to the screen and scroll the rest, as wide desktop
    /// screenshots need; otherwise the whole image fits on screen.
    var fitWidth = false
    func makeUIView(context: Context) -> ZoomView { ZoomView(image: image, fitWidth: fitWidth) }
    func updateUIView(_ view: ZoomView, context: Context) { view.setImage(image) }

    final class ZoomView: UIScrollView, UIScrollViewDelegate {
        private let imageView = UIImageView()
        private let fitWidth: Bool
        init(image: UIImage, fitWidth: Bool = false) {
            self.fitWidth = fitWidth
            super.init(frame: .zero)
            delegate = self
            showsHorizontalScrollIndicator = false; showsVerticalScrollIndicator = false
            decelerationRate = .fast; contentInsetAdjustmentBehavior = .never
            imageView.contentMode = .scaleAspectFit; imageView.isUserInteractionEnabled = true
            imageView.accessibilityIgnoresInvertColors = true
            addSubview(imageView)
            let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
            doubleTap.numberOfTapsRequired = 2
            addGestureRecognizer(doubleTap)
            setImage(image)
        }
        @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
        func setImage(_ image: UIImage) {
            guard imageView.image !== image else { return }
            imageView.image = image
            setNeedsLayout()
        }
        private var fittedSize: CGSize = .zero
        private var pixelZoom: CGFloat = 1
        override func layoutSubviews() {
            super.layoutSubviews()
            guard let image = imageView.image, bounds.width > 0, bounds.height > 0, image.size.width > 0, image.size.height > 0 else { return }
            let fit = fitWidth ? min(bounds.width / image.size.width, 1) : min(bounds.width / image.size.width, bounds.height / image.size.height, 1)
            let size = CGSize(width: image.size.width * fit, height: image.size.height * fit)
            if size != fittedSize {
                fittedSize = size
                zoomScale = 1
                imageView.frame = CGRect(origin: .zero, size: size)
                contentSize = size
                minimumZoomScale = 1
                // One image pixel per screen pixel, and twice that on top.
                pixelZoom = image.size.width / max(1, size.width * UIScreen.main.scale)
                maximumZoomScale = max(4, 1 / fit * 2, pixelZoom * 2)
            }
            centre()
        }
        private func centre() {
            let x = max(0, (bounds.width - contentSize.width) / 2), y = max(0, (bounds.height - contentSize.height) / 2)
            contentInset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
        }
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { centre() }
        @objc private func toggleZoom(_ recognizer: UITapGestureRecognizer) {
            if zoomScale > minimumZoomScale * 1.05 { setZoomScale(minimumZoomScale, animated: true); return }
            let point = recognizer.location(in: imageView), scale = min(maximumZoomScale, fitWidth ? max(2.5, pixelZoom) : 2.5)
            let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
            zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }
}
