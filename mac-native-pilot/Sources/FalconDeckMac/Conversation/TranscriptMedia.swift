import SwiftUI
import AppKit
import AVFoundation
import ImageIO

/// Media is decoded to a bounded thumbnail. Remote downloads require an explicit
/// click so opening an old conversation does not contact arbitrary image hosts.
struct TranscriptMediaView: View {
    let reference: JSON
    var resolvedURL: URL? = nil
    var loadReference: (() async throws -> JSON)? = nil
    @State private var image: NSImage?
    @State private var bytes: Data?
    @State private var loading = false
    @State private var error: String?
    @State private var preview = false
    @State private var loadedReference: JSON?
    @State private var audio = TranscriptAudioPlayback()
    @State private var generation = 0

    private var source: JSON { loadedReference ?? reference }
    private var label: String { TranscriptPresentation.nonempty(source["alt_text"].string, source["name"].string, source["url"].string.hasPrefix("data:") ? "" : URL(string: source["url"].string)?.lastPathComponent ?? "", "Attachment") }
    private var mime: String { TranscriptPresentation.nonempty(source["mime_type"].string, source["mimeType"].string) }
    private var isAudio: Bool { mime.hasPrefix("audio/") || source["url"].string.hasPrefix("data:audio/") }
    private var isImage: Bool {
        mime.hasPrefix("image/") || source["url"].string.hasPrefix("data:image/") ||
        ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp", "avif"].contains(URL(string: source["url"].string)?.pathExtension.lowercased() ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let image {
                Button { preview = true } label: {
                    Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 340)
                        .clipShape(.rect(cornerRadius: 10))
                }.buttonStyle(.plain).accessibilityLabel("Preview \(label)")
                HStack {
                    Text(label).lineLimit(1)
                    Spacer()
                    Button("Save…") { save() }.buttonStyle(.plain).foregroundStyle(FDTheme.accent)
                }.font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
            } else if isAudio, bytes != nil {
                HStack(spacing: 10) {
                    Button {
                        do { if let bytes { try audio.toggle(data: bytes) } }
                        catch { self.error = error.localizedDescription }
                    } label: { Image(systemName: audio.playing ? "pause.fill" : "play.fill").frame(width: 30, height: 30) }
                        .buttonStyle(.plain).foregroundStyle(FDTheme.accent).accessibilityLabel(audio.playing ? "Pause audio" : "Play audio")
                    Image(systemName: "waveform").foregroundStyle(FDTheme.muted)
                    Text(label).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.secondary).lineLimit(1)
                    Spacer()
                    Button("Save…") { save() }.font(NativePreferences.shared.font(size: 12, surface: "chat")).buttonStyle(.plain).foregroundStyle(FDTheme.muted)
                }.padding(10).background(FDTheme.raised, in: .rect(cornerRadius: 8))
            } else {
                Button { Task { await load() } } label: {
                    HStack(spacing: 10) {
                        if loading { ProgressView().controlSize(.small) }
                        else { Image(systemName: isAudio ? "waveform" : isImage ? "photo" : "doc") }
                        VStack(alignment: .leading, spacing: 4) {
                            Text(loading ? "Loading \(label)…" : error == nil ? label : "Couldn't load \(label)")
                                .font(NativePreferences.shared.font(size: 12, surface: "chat", weight: .medium)).lineLimit(2)
                            Text(error == nil ? (isAudio ? "Play audio" : isImage ? "Load image" : bytes != nil ? "Save attachment…" : "Load attachment") : "Retry")
                                .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "arrow.down.circle").foregroundStyle(FDTheme.subtle)
                    }.foregroundStyle(FDTheme.secondary).padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(FDTheme.raised, in: .rect(cornerRadius: 10))
                }.buttonStyle(.plain).disabled(loading)
            }
            if let error { Text(error).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.danger).textSelection(.enabled) }
        }
        .task(id: reference) {
            generation += 1
            audio.stop()
            loading = false
            image = nil; bytes = nil; loadedReference = nil; error = nil
            // Inline images and daemon-owned local references are already trusted
            // conversation content; external images wait for the reader to click.
            if reference["url"].string.hasPrefix("data:") || !reference["local_path"].string.isEmpty || reference["url"].string.isEmpty {
                await load(openDocument: false)
            }
        }
        .onDisappear { audio.stop() }
        .sheet(isPresented: $preview) {
            if let image { TranscriptImagePreview(image: image, title: label, onSave: save) }
        }
    }

    @MainActor private func load(openDocument: Bool = true) async {
        if bytes != nil, !isImage, !isAudio { save(); return }
        guard !loading else { return }
        loading = true; error = nil
        let currentGeneration = generation
        defer { if currentGeneration == generation { loading = false } }
        do {
            var candidate = source
            if candidate["url"].string.isEmpty && candidate["local_path"].string.isEmpty, let loadReference {
                candidate = try await loadReference()
                guard currentGeneration == generation else { return }
                loadedReference = candidate
            }
            let data = try await TranscriptMediaData.load(candidate, override: resolvedURL)
            try Task.checkCancellation()
            guard currentGeneration == generation else { return }
            bytes = data
            let raster = await Task.detached(priority: .userInitiated) { TranscriptMediaData.thumbnail(data) }.value
            guard currentGeneration == generation else { return }
            if let raster { image = NSImage(cgImage: raster, size: .zero) }
            else if !isAudio, isImage { throw PilotError("This image format couldn't be displayed. Save the attachment to open it in another app.") }
            else if !isAudio, openDocument { save() }
        } catch is CancellationError { }
        catch { if currentGeneration == generation { self.error = error.localizedDescription } }
    }

    @MainActor private func save() {
        guard let bytes else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = label == "Attachment" ? "Attachment" : label
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do { try bytes.write(to: url, options: .atomic) }
            catch { self.error = error.localizedDescription }
        }
    }
}

private struct TranscriptImagePreview: View {
    @Environment(\.dismiss) private var dismiss
    let image: NSImage
    let title: String
    let onSave: () -> Void
    @State private var scale: CGFloat = 1

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(NativePreferences.shared.font(size: 13, surface: "chat", weight: .medium)).lineLimit(1)
                Spacer()
                Button { scale = max(0.5, scale - 0.25) } label: { Image(systemName: "minus.magnifyingglass") }.help("Zoom out")
                Text("\(Int(scale * 100))%")
                    .font(NativePreferences.shared.font(size: 13, surface: "code"))
                    .fixedSize().frame(minWidth: 52)
                Button { scale = min(5, scale + 0.25) } label: { Image(systemName: "plus.magnifyingglass") }.help("Zoom in")
                Button("Save…", action: onSave)
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }.font(NativePreferences.shared.font(size: 13, surface: "chat")).padding(14)
            Divider()
            GeometryReader { geometry in
                ScrollView([.horizontal, .vertical]) {
                    Image(nsImage: image).resizable().scaledToFit()
                        .frame(width: max(1, geometry.size.width - 32) * scale, height: max(1, geometry.size.height - 32) * scale)
                        .padding(16)
                }
            }
        }.frame(minWidth: 600, minHeight: 450).background(FDTheme.background).foregroundStyle(FDTheme.foreground)
    }
}

enum TranscriptMediaData {
    static let maximumBytes = 32 * 1024 * 1024

    static func inlineData(_ value: String) throws -> Data? {
        guard value.hasPrefix("data:") else { return nil }
        guard value.utf8.count <= maximumBytes * 4 / 3 + 1024,
              let comma = value.firstIndex(of: ",") else { throw PilotError("This attachment is too large to display.") }
        let header = value[..<comma]
        let payload = String(value[value.index(after: comma)...])
        let data: Data?
        if header.hasSuffix(";base64") { data = Data(base64Encoded: payload, options: [.ignoreUnknownCharacters]) }
        else { data = payload.removingPercentEncoding?.data(using: .utf8) }
        guard let data, data.count <= maximumBytes else { throw PilotError("This attachment data couldn't be read.") }
        return data
    }

    static func load(_ reference: JSON, override: URL? = nil) async throws -> Data {
        let source = reference["url"].string
        if let data = try inlineData(source) { return data }
        let local = reference["local_path"].string
        if !local.isEmpty {
            return try await Task.detached {
                let url = URL(fileURLWithPath: local)
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
                guard size <= maximumBytes else { throw PilotError("This attachment is larger than 32 MB. Open it from Files instead.") }
                return try Data(contentsOf: url, options: .mappedIfSafe)
            }.value
        }
        guard let url = override ?? TranscriptPresentation.externalURL(source), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            throw PilotError("This attachment isn't available yet. Retry after the task has synced.")
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        let (stream, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw PilotError("The attachment server returned an error.") }
        guard response.expectedContentLength <= maximumBytes else { throw PilotError("This attachment is larger than 32 MB.") }
        var data = Data(), chunk = Data()
        chunk.reserveCapacity(8192)
        for try await byte in stream {
            chunk.append(byte)
            if chunk.count >= 8192 {
                guard data.count + chunk.count <= maximumBytes else { throw PilotError("This attachment is larger than 32 MB.") }
                data.append(chunk); chunk.removeAll(keepingCapacity: true)
                try Task.checkCancellation()
            }
        }
        guard data.count + chunk.count <= maximumBytes else { throw PilotError("This attachment is larger than 32 MB.") }
        data.append(chunk)
        return data
    }

    nonisolated static func thumbnail(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2400,
            kCGImageSourceShouldCacheImmediately: true
        ] as CFDictionary)
    }
}

@MainActor @Observable private final class TranscriptAudioPlayback: NSObject, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    var playing = false

    func toggle(data: Data) throws {
        if let player {
            if player.isPlaying { player.pause(); playing = false }
            else { player.play(); playing = true }
        } else {
            let player = try AVAudioPlayer(data: data)
            player.delegate = self; player.prepareToPlay(); player.play()
            self.player = player; playing = true
        }
    }
    func stop() { player?.stop(); player = nil; playing = false }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in self?.playing = false; self?.player = nil }
    }
}
