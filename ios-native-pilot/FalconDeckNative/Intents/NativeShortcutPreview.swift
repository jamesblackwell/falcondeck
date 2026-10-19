#if DEBUG
import Foundation

@MainActor enum NativeShortcutPreview {
    /// Calls the real perform() implementations against local fixtures. This
    /// never opens the real Keychain, sends a turn, or changes a paired session.
    static func start(in model: AppModel) async {
        guard let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--shortcut-preview=") }) else { return }
        let mode = String(argument.dropFirst("--shortcut-preview=".count))
        let context = NativeIntentContext(model: model)
        do {
            if mode == "activity" {
                let intent = OpenNativeActivityIntent(); intent.context = context
                _ = try await intent.perform()
            } else if let project = model.projects.first(where: { $0.id == "falcondeck" }) {
                let entity = NativeProjectEntity(project: project, pairing: NativeIntentContext.demoPairing)
                if mode == "project" {
                    let intent = OpenNativeProjectIntent(); intent.context = context; intent.project = entity
                    _ = try await intent.perform()
                } else {
                    model.chat(for: model.draftTask(project: project, folderID: nil)).draft = "Existing draft."
                    let intent = NewNativeTaskIntent(); intent.context = context; intent.project = entity
                    intent.prompt = "Review these changes from Shortcuts."
                    _ = try await intent.perform()
                }
            }
        } catch { model.error = error.localizedDescription }
    }
}
#endif
