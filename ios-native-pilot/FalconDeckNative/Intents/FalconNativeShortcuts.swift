import AppIntents

struct NewNativeTaskIntent: AppIntent {
    static var title: LocalizedStringResource { "New task" }
    static var description: IntentDescription { "Open a new-task draft, optionally adding a prompt. Review and send it in Falcon Native." }
    static var supportedModes: IntentModes { .foreground(.immediate) }
    static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }
    @Parameter(title: "Project") var project: NativeProjectEntity?
    @Parameter(title: "Prompt", inputOptions: .init(multiline: true)) var prompt: String?
    @Dependency var context: NativeIntentContext
    static var parameterSummary: some ParameterSummary { Summary("New task in \(\.$project) with \(\.$prompt)") }
    func perform() async throws -> some IntentResult {
        try await context.open(.newTask(projectID: project?.projectID, prompt: prompt ?? ""), project: project)
        return .result()
    }
}

struct OpenNativeProjectIntent: AppIntent {
    static var title: LocalizedStringResource { "Open project" }
    static var description: IntentDescription { "Open a project's saved new-task draft in Falcon Native." }
    static var supportedModes: IntentModes { .foreground(.immediate) }
    static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }
    @Parameter(title: "Project") var project: NativeProjectEntity
    @Dependency var context: NativeIntentContext
    static var parameterSummary: some ParameterSummary { Summary("Open \(\.$project)") }
    func perform() async throws -> some IntentResult {
        try await context.open(.newTask(projectID: project.projectID, prompt: ""), project: project)
        return .result()
    }
}

struct OpenNativeActivityIntent: AppIntent {
    static var title: LocalizedStringResource { "View activity" }
    static var description: IntentDescription { "Open your agents' activity in Falcon Native." }
    static var supportedModes: IntentModes { .foreground(.immediate) }
    static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }
    @Dependency var context: NativeIntentContext
    func perform() async throws -> some IntentResult {
        try await context.open(.activity)
        return .result()
    }
}

struct FalconNativeShortcuts: AppShortcutsProvider {
    static var shortcutTileColor: ShortcutTileColor { .teal }
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: NewNativeTaskIntent(), phrases: ["New task in \(.applicationName)", "Start a task in \(.applicationName)"], shortTitle: "New task", systemImageName: "square.and.pencil")
        AppShortcut(intent: OpenNativeProjectIntent(), phrases: ["Open \(\.$project) in \(.applicationName)"], shortTitle: "Open project", systemImageName: "folder")
        AppShortcut(intent: OpenNativeActivityIntent(), phrases: ["Show activity in \(.applicationName)"], shortTitle: "View activity", systemImageName: "tray.full")
    }
}
