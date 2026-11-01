import SwiftUI

/// Inline text that puts a bot's mark before links to its conversation, so a
/// mention in a reply or in STATUS.md reads the same as in the sidebar.
@MainActor enum BotLinkText {
    private static var cache: [String: UIImage] = [:]

    static func text(_ value: AttributedString, model: AppModel?, scheme: ColorScheme) -> Text {
        // Most text has no thread links; skip everything else for those.
        guard let model, value.runs.contains(where: { $0.link.flatMap { TranscriptThreadLink.parse($0.absoluteString) } != nil }) else { return Text(value) }
        var result = Text(""), marked = false
        for run in value.runs {
            let segment = Text(AttributedString(value[run.range]))
            if let link = run.link, let id = TranscriptThreadLink.parse(link.absoluteString),
               let icon = model.botIcon(forTask: id), let image = mark(icon, scheme: scheme) {
                result = result + Text(Image(uiImage: image)).baselineOffset(-2) + Text("\u{2009}") + segment
                marked = true
            } else { result = result + segment }
        }
        return marked ? result : Text(value)
    }

    private static func mark(_ icon: NativeBotIcon, scheme: ColorScheme) -> UIImage? {
        let appearance = NativeAppearance.shared
        let key = [icon.shape, icon.color, scheme == .dark ? "d" : "l", appearance.lightID, appearance.darkID].joined(separator: "|")
        if let image = cache[key] { return image }
        let renderer = ImageRenderer(content: BotMark(icon: icon, size: 13).environment(\.colorScheme, scheme))
        renderer.scale = 3
        guard let image = renderer.uiImage?.withRenderingMode(.alwaysOriginal) else { return nil }
        if cache.count > 64 { cache.removeAll() }
        cache[key] = image
        return image
    }
}
