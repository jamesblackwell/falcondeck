import Foundation
import Observation

enum Destination: Hashable, Codable {
    case projects, activity, settings, automations, archived, task(String), draft(String, String?)
}

@MainActor @Observable
final class AppModel {
    let relay: any RelayServing
    let voice: VoiceRecorder
    let readAloud = ReadAloud()
    let realtimeAudio = RealtimeAudio()
    @ObservationIgnored let workspaceIcons = WorkspaceIconCache()
    var composerCatalogs: [String: ComposerCatalog] = [:]
    let extensions = NativeExtensions()
    let automations = AutomationStore()
    let notifications: LocalNotifications
    let push: NativePushNotifications
    let taskActivity: TaskLiveActivity
    @ObservationIgnored let backgroundExecution: BackgroundExecution
    @ObservationIgnored let sessionLoader: @Sendable () throws -> SavedSession?
    @ObservationIgnored let sessionCacheRoot: URL?
    @ObservationIgnored let inputDraftRoot: URL?
    var pendingNotification: NotificationDestination?
    private(set) var connectionID = UUID()
    // Local audio survives socket replacement, but never a pairing switch.
    private(set) var sessionScope = UUID()

    init(relay: any RelayServing = RelayClient(), voice: VoiceRecorder = VoiceRecorder(), push: NativePushNotifications = .shared, notifications: LocalNotifications = LocalNotifications(), taskActivity: TaskLiveActivity = TaskLiveActivity(), backgroundExecution: BackgroundExecution = BackgroundExecution(), sessionLoader: @escaping @Sendable () throws -> SavedSession? = { try SessionVault.load() }, sessionCacheRoot: URL? = nil, inputDraftRoot: URL? = nil) {
        self.voice = voice
        self.relay = relay
        self.push = push; self.notifications = notifications; self.sessionLoader = sessionLoader; self.sessionCacheRoot = sessionCacheRoot
        self.inputDraftRoot = inputDraftRoot
        self.taskActivity = taskActivity; self.backgroundExecution = backgroundExecution
        NativeSpeechBridge.handler = { [weak self] action in await self?.speechAction(action) }
        notifications.openDestination = { [weak self] destination in
            self?.pendingNotification = destination
            Task { await self?.openPendingNotification() }
        }
        notifications.shouldPresent = { [weak self] destination in
            guard let self, !self.demo, (try? sessionLoader())?.sessionID == destination.sessionID else { return false }
            return self.selection != .task(destination.threadID)
        }
    }
    var syncIndex: CompactSync?
    var taskPageLoads: Set<String> = []
    var projects: [Project] = [] { didSet { rememberModelCatalogs() } }
    var modelCatalogCache: [CachedModelCatalog] = []
    var composerPreferences: [String: WorkspaceComposerPreferences] = [:]
    var tasks: [AgentTask] = [] {
        didSet {
            taskGroups = Dictionary(grouping: tasks, by: \.projectID).mapValues { values in
                values.sorted { $0.pinned != $1.pinned ? $0.pinned : $0.updatedAt > $1.updatedAt }
            }
            for task in tasks {
                if !previewTaskIDs.contains(task.id) { chats[task.id]?.reconcileSettings(task) }
                if let chat = chats[task.id], !chat.pendingQueue.isEmpty {
                    chat.pendingQueue = QueuedDraft.reconcile(chat.pendingQueue, queued: task.queued, items: chat.transcript.items)
                }
            }
            synchronizeTaskActivity()
        }
    }
    private var taskGroups: [String: [AgentTask]] = [:]
    @ObservationIgnored var pendingSummaries: [String: JSON] = [:]
    @ObservationIgnored var summaryFlush: Task<Void, Never>?
    var connected = false
    var status = "Not connected"
    var error: String?
    var demo = false
    var hasSession = false
    var busy = false { didSet { if !busy { consumeQueuedPairingPayload() } } }
    var refreshedAt: Date?
    var hasLiveSnapshot = false
    var cachedAt: Date?
    @ObservationIgnored var previewTaskIDs: Set<String> = []
    var sessionCache: SessionCacheStore?
    @ObservationIgnored var previewSave: Task<Void, Never>?
    var showConnection = false
    var pairingText = ""
    var restoringSession = true
    var pairingPending = false
    var pairingRelayReview: PairingRelayReview?
    @ObservationIgnored var claimingPairing = false
    @ObservationIgnored var pairingNeedsReconnect = false
    @ObservationIgnored var queuedPairingPayload: (text: String, relayURL: String)?
    var selection: Destination? = .projects {
        didSet {
            if oldValue != selection { detailContentID = UUID() }
            let selected: String? = { if case .task(let id) = selection { return id }; return nil }()
            // Back on iPhone retains the selection. Tapping that same task
            // again is still an explicit reopen and should acknowledge it.
            if let selected { readSuppression.removeValue(forKey: selected); readSelectionID = UUID() }
            Task { await relay.selectThread(selected) }
            schedulePreviewSave()
            guard !demo, let store = draftStore else { return }
            switch selection { case .task, .draft, .projects: break; default: return }
            let value = selection, revision = InputWriteRevision.next()
            Task { try? await store.saveSelection(value, revision: revision) }
        }
    }
    var detailRequestID = UUID()
    var detailContentID = UUID()
    @ObservationIgnored var pendingShortcuts: [NativeShortcutNavigation] = []
    @ObservationIgnored var draftStore: DraftStore?
    @ObservationIgnored var savedDrafts: [String: SavedDraft] = [:]
    @ObservationIgnored var draftSaves: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var pendingSelection: Destination?
    var preferences = JSON.object([:]) { didSet { preferencesRevision += 1; synchronizePush(); schedulePreviewSave() } }
    @ObservationIgnored var preferencesRevision = 0
    @ObservationIgnored var pushSyncID = UUID()
    @ObservationIgnored var preferenceWrite: (id: UUID, task: Task<Void, Error>)?
    var requests: [JSON] = [] { didSet { synchronizeTaskActivity() } }
    var serviceNotices: [JSON] = []
    var operationalConditions: [JSON] = []
    /// Notices the user closed, by problem, until they may show again.
    var snoozedNotices: [String: Date] = NoticeSnooze.stored()
    var tokenUsage = JSON.object([:])
    var archivedTasks: [AgentTask] = [] { didSet { synchronizeTaskActivity() } }
    @ObservationIgnored var archivedLoadID: UUID?
    @ObservationIgnored var archivedTouched: Set<String> = []
    var readSuppression: [String: TaskReadSuppression] = [:]
    var readSelectionID = UUID()
    var taskOptionsID: String?
    var showSpeechSettings = false
    var connectionLog: [ConnectionLogEntry] = []
    @ObservationIgnored var mediaGate = MediaTransferGate()
    @ObservationIgnored var itemLoads: [String: (id: UUID, task: Task<JSON, Error>)] = [:]
    @ObservationIgnored var itemCache: [String: JSON] = [:]
    @ObservationIgnored var itemCacheOrder: [String] = []
    var chats: [String: ChatSession] = [:]
    @ObservationIgnored var receivedEventSequences = RecentEventSequences()
    @ObservationIgnored private var observation: Task<Void, Never>?
    @ObservationIgnored private var startupInFlight = false
    @ObservationIgnored var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var networkMonitor: NetworkMonitor?
    var reconnectAttempt = 0
    var networkAvailable = true
    var foreground = true
    @ObservationIgnored var foregroundRefresh: Task<Void, Never>?
    @ObservationIgnored var backgroundSave: Task<Void, Never>?
    @ObservationIgnored var backgroundSaveID = UUID()

    func start() async {
        guard observation == nil, !startupInFlight else { return }
        startupInFlight = true
        defer {
            startupInFlight = false
            restoringSession = false
            consumeQueuedPairingPayload()
            applyPendingShortcut()
        }
        SpeechLiveActivity.shared.voice(nil); SpeechLiveActivity.shared.readAloud(nil)
        let events = await relay.events()
        observation = Task { [weak self] in
            for await event in events {
                guard let self else { return }
                self.receive(event)
            }
        }
        networkMonitor = NetworkMonitor { [weak self] available in
            guard let self else { return }
            let recovered = available && !self.networkAvailable
            self.networkAvailable = available
            if recovered { self.reconnectAttempt = 0; self.scheduleReconnect() }
            if !available { self.reconnectTask?.cancel(); self.reconnectTask = nil }
        }
        if ProcessInfo.processInfo.arguments.contains("--demo") { await useDemo(); return }
        let current = connectionID
        let loader = sessionLoader
        let saved = await Task.detached(priority: .userInitiated) { try? loader() }.value
        guard current == connectionID else { return }
        hasSession = saved != nil
        taskActivity.restore(pairing: saved.map(TaskLiveActivity.pairingKey))
        await restoreInputs(session: saved)
        guard current == connectionID else { return }
        await restorePreview(session: saved)
        guard current == connectionID else { return }
        // Reveal local content before waiting on the relay handshake.
        restoringSession = false
        applyPendingShortcut()
        do {
            let restored = try await relay.restore(connectionID: current)
            guard current == connectionID else { return }
            hasSession = restored
            synchronizePush()
        } catch {
            guard current == connectionID else { return }
            self.error = error.localizedDescription; scheduleReconnect()
        }
    }

    // Every asynchronous result belongs to one connection. This also rejects
    // already-queued stream events after demo/forget/re-pair transitions.
    @discardableResult private func beginConnection(clearData: Bool) -> UUID {
        reconnectTask?.cancel(); reconnectTask = nil
        previewSave?.cancel(); previewSave = nil; hasLiveSnapshot = false
        if clearData {
            sessionScope = UUID()
            pendingShortcuts.removeAll()
            taskActivity.stop()
            workspaceIcons.reset()
            if voice.recording { voice.finishRecording() }
            voice.cancelTranscription(); readAloud.stop()
        }
        realtimeAudio.reset(); automations.reset(); extensions.reset(); composerCatalogs = [:]
        connectionID = UUID(); receivedEventSequences = RecentEventSequences(); connected = false; syncIndex = nil; taskPageLoads = []; pairingNeedsReconnect = false
        preferenceWrite = nil; archivedLoadID = nil; archivedTouched = []
        itemCache = [:]; itemCacheOrder = []; itemLoads = [:]; mediaGate = MediaTransferGate()
        summaryFlush?.cancel(); summaryFlush = nil; pendingSummaries = [:]
        for chat in chats.values {
            chat.loadID = UUID(); chat.loading = false; chat.bufferedEvents = []; chat.needsRefresh = true
        }
        if clearData {
            modelCatalogCache = []; composerPreferences = [:]
            projects = []; tasks = []; chats = [:]; requests = []; preferences = .object([:])
            archivedTasks = []; readSuppression = [:]; taskOptionsID = nil; serviceNotices = []; operationalConditions = []; tokenUsage = .object([:])
            selection = .projects; refreshedAt = nil; cachedAt = nil; previewTaskIDs = []
        }
        return connectionID
    }

    func pair(relayURL: String, approvedRelay: Bool = false) async {
        guard !busy, !pairingPending else { return }
        claimingPairing = true; pairingNeedsReconnect = false; busy = true; error = nil; queuedPairingPayload = nil
        defer {
            claimingPairing = false; busy = false
            if pairingNeedsReconnect { pairingNeedsReconnect = false; scheduleReconnect() }
        }
        let previousSession = try? sessionLoader()
        var current: UUID?
        do {
            let input = try PairingInput(text: pairingText, relay: relayURL)
            if !approvedRelay, input.relay.absoluteString != PairingInput.defaultRelay {
                pairingRelayReview = PairingRelayReview(text: pairingText, relay: input.relay)
                return
            }
            pairingRelayReview = nil
            await saveAllInputs(); await savePreview(); sessionCache = nil; draftStore = nil; savedDrafts = [:]; pendingSelection = nil
            let attempt = beginConnection(clearData: true); current = attempt; demo = false
            pairingPending = true; showConnection = true; status = "Connecting…"
            try await relay.pair(input, connectionID: attempt)
            guard attempt == connectionID else { return }
            await push.forget(session: previousSession)
            guard attempt == connectionID else { return }
            hasSession = true; pairingText = ""
            synchronizePush()
            await restoreInputs()
            guard attempt == connectionID else { return }
            await restorePreview()
        } catch {
            guard current == nil || current == connectionID else { return }
            self.error = error.localizedDescription
            let saved = try? sessionLoader()
            if let previousSession, let saved,
               previousSession.relay != saved.relay || previousSession.sessionID != saved.sessionID || previousSession.deviceID != saved.deviceID {
                // A claim can save its new identity before the first socket
                // connection fails. Retire the prior computer in that case too.
                await push.forget(session: previousSession)
            }
            hasSession = saved != nil
            // Once a claim has saved credentials, retry that connection instead
            // of submitting the single-use pairing code a second time.
            pairingPending = current != nil && saved != nil && (previousSession == nil || saved?.deviceID != previousSession?.deviceID || saved?.sessionID != previousSession?.sessionID || saved?.relay != previousSession?.relay)
            if pairingPending { scheduleReconnect() }
        }
    }

    func reconnect() async {
        guard hasSession, !busy else { return }
        busy = true; error = nil
        await savePreview()
        let current = beginConnection(clearData: demo); demo = false
        defer { busy = false }
        if draftStore == nil { await restoreInputs() }
        guard current == connectionID else { return }
        if sessionCache == nil { await restorePreview() }
        guard current == connectionID else { return }
        do { let restored = try await relay.restore(connectionID: current); if current == connectionID { hasSession = restored; synchronizePush() } }
        catch { if current == connectionID { self.error = error.localizedDescription; scheduleReconnect() } }
    }
    func refresh() async {
        if demo { return }
        if !connected { await reconnect() }
        else { await relay.refresh() }
        if case .task(let id) = selection, let task = tasks.first(where: { $0.id == id }) { await loadChat(task) }
    }
    func forget() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        await saveAllInputs()
        pendingNotification = nil
        let oldStore = draftStore
        let oldCache = sessionCache; sessionCache = nil
        draftStore = nil; savedDrafts = [:]; pendingSelection = nil
        hasSession = false; pairingPending = false; pairingRelayReview = nil
        beginConnection(clearData: true); demo = false
        try? await oldCache?.clear()
        await push.forget(session: try? sessionLoader())
        do {
            try await relay.disconnect(forget: true)
            try await oldStore?.clear()
            hasSession = false; error = nil; status = "Not connected"
        } catch { self.error = error.localizedDescription; hasSession = (try? sessionLoader()) != nil }
    }
    func useDemo() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        await saveAllInputs(); await savePreview(); sessionCache = nil; draftStore = nil; savedDrafts = [:]; pendingSelection = nil
        beginConnection(clearData: true); demo = true; pairingPending = false; pairingRelayReview = nil; showConnection = false
        try? await relay.disconnect(forget: false)
        error = nil; status = "Demo workspace"
        projects = Demo.projects; tasks = Demo.tasks; preferences = Demo.preferences; requests = Demo.requests
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--loading-preview=") }) {
            projects = LoadingPreviewRelay.projects; tasks = [LoadingPreviewRelay.task]; requests = []
            if ProcessInfo.processInfo.arguments.contains("--loading-preview=retry") {
                tasks[0] = AgentTask(tasks[0].raw.setting("status", .string("running")))
            }
            if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--loading-preview=harness-") }) {
                projects = [HarnessPreview.project]; tasks = [HarnessPreview.task]
            }
            syncIndex = CompactSync(token: LoadingPreviewRelay.token, counts: LoadingPreviewRelay.counts)
            if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--loading-preview=models") }) {
                projects = Demo.projects.map { project in
                    Project(project.raw.setting("models", .array([])).setting("agents", .array(project.raw["agents"].array.map { $0.setting("models", .array([])) })))
                }
                _ = try? await relay.restore(connectionID: connectionID)
            }
            demo = false; hasSession = true; connected = true; hasLiveSnapshot = true; status = "Preview computer"
            // Exercise durable transcript handoff without accessing a real pairing.
            let inputRoot = FileManager.default.temporaryDirectory.appending(path: "NativeLoadingInputPreview")
            try? FileManager.default.removeItem(at: inputRoot)
            let inputSession = SavedSession(relay: URL(string: "https://loading-preview.test")!, sessionID: "loading-preview", deviceID: "loading-preview", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
            draftStore = try? DraftStore(session: inputSession, root: inputRoot)
            if ProcessInfo.processInfo.arguments.contains("--loading-preview=rename") {
                projects = Demo.projects.map { $0.id == "falcondeck" ? Project($0.raw.setting("icon", .object(["kind": .string("image"), "etag": .string("local-brand-fixture")]))) : $0 }
                tasks = Demo.tasks.filter(\.pinned).map { AgentTask($0.raw.setting("status", .string("idle"))) }
                syncIndex = nil
                _ = try? await relay.restore(connectionID: connectionID)
            }
            if ProcessInfo.processInfo.arguments.contains("--loading-preview=cached") {
                let chat = chat(for: LoadingPreviewRelay.task)
                chat.transcript.items = Demo.messages; chat.loaded = true; chat.needsRefresh = true
                cachedAt = .now
            }
            if ProcessInfo.processInfo.arguments.contains("--loading-preview=settling"), let task = tasks.first {
                let chat = chat(for: task); chat.loaded = true; chat.needsRefresh = true; chat.hasOlder = true
                chat.transcript.items = Array(LoadingPreviewRelay.settlingHistory.suffix(16))
                cachedAt = .now; selection = .task(task.id)
            }
            if ProcessInfo.processInfo.arguments.contains("--loading-preview=connecting") || ProcessInfo.processInfo.arguments.contains("--loading-preview=empty") {
                connected = false; hasLiveSnapshot = false; syncIndex = nil; status = "Connecting…"
                if ProcessInfo.processInfo.arguments.contains("--loading-preview=empty") { projects = []; tasks = [] }
                else { cachedAt = .now }
            }
        }
        if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--goal-preview=") }), let task = tasks.first {
            let mode = String(argument.dropFirst("--goal-preview=".count))
            let provider = mode.hasPrefix("claude-") ? "claude" : "codex"
            let status = mode.hasSuffix("complete") ? "complete" : "active"
            let goal = JSON.object(["objective": .string(String(repeating: "Keep the native app polished and reliable. ", count: 80)), "status": .string(status), "tokens_used": .number(2000), "token_budget": .number(5000), "time_used_seconds": .number(3600)])
            tasks[0] = AgentTask(task.raw.setting("provider", .string(provider)).setting("goal", goal))
        }
        if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--review-preview=") }), let task = tasks.first {
            let mode = argument.split(separator: "=").last.map(String.init)
            let chat = chat(for: task)
            chat.loaded = true; chat.transcript.items = Demo.messages
            if mode == "offline" {
                demo = false; hasSession = true; connected = false; status = "Offline"
            } else if mode == "queue" || mode == "queue-error" || mode == "dispatched" {
                let text = "Keep the full queued message.\n\n" + Demo.longRequest
                if mode != "dispatched" {
                    tasks[0] = AgentTask(task.raw.setting("queued_turns", .array([.object(["id": .string("review-queue"), "text": .string(text), "preview": .string("Keep the full queued message."), "attachment_count": .number(0)])])))
                } else { chat.queuedEdit = QueuedMessageEdit(id: "review-queue", text: text) }
                if mode == "queue-error" { demo = false; hasSession = true; connected = true; hasLiveSnapshot = true; status = "Preview computer" }
            } else if mode == "output" {
                let full = JSON.object(["id": .string("review-output"), "kind": .string("tool_call"), "title": .string("Review output"), "status": .string("completed"), "output": .string("Native output search\nAll focused checks passed.\nSearch keeps the full output selectable.")])
                chat.transcript.items = [Message(full.setting("display", .object(["output_total_bytes": .number(200)])))]
                itemCache["\(connectionID):\(task.id):review-output"] = full
            } else if mode?.hasPrefix("plan") == true {
                let plan = mode == "plan-empty" ? "" : "## Implementation plan\n\n1. Add native plan review controls.\n2. Verify the existing daemon responses."
                requests = [.object(["request_id": .string("review-plan"), "workspace_id": .string(task.projectID), "thread_id": .string(task.id),
                    "kind": .string("plan_approval"), "title": .string("Review implementation plan"), "detail": .string(plan)])]
                tasks[0] = AgentTask(task.raw.setting("status", .string("waiting_for_input")))
                chat.draft = "Keep my separate follow-up."
                if mode == "plan-error" { demo = false; hasSession = true; connected = true; hasLiveSnapshot = true; status = "Preview computer" }
                if mode == "plan-offline" { demo = false; hasSession = true; connected = false; status = "Offline" }
            }
        }
        if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--voice-preview=") }),
           let phase = argument.split(separator: "=").last.map(String.init), ["starting", "recording", "transcribing", "failed", "ready", "other-task", "long", "limit"].contains(phase), let task = tasks.first {
            voice.preview(phase, ownerID: phase == "other-task" ? "another-task" : task.id)
            let chat = chat(for: task); chat.voiceInputOpen = true; chat.draft = "Keep my existing draft."
        }
        await PerformancePreview.start(in: self)
        StreamingPreview.start(in: self)
        MotionPreview.start(in: self)
        await ImagePreview.start(in: self)
        await NativeShortcutPreview.start(in: self)
        await SendPreview.start(in: self)
        BotPreview.start(in: self)
        if ProcessInfo.processInfo.arguments.contains("--task-activity-preview"), let task = tasks.first {
            // Explicit local QA fixture: no relay, turn, microphone or push.
            taskActivity.restore(pairing: nil)
            let active = AgentTask(task.raw.setting("status", .string("running")))
            tasks = [active]; selection = .task(active.id); connected = true; hasLiveSnapshot = true
            let chat = chat(for: active); chat.loaded = true; chat.needsRefresh = false; chat.transcript.items = Demo.messages
        }
        #endif
    }
    func tasks(in project: Project) -> [AgentTask] {
        taskGroups[project.id] ?? []
    }
    var sortedProjects: [Project] {
        let order = Dictionary(preferences["workspace_order"].array.map(\.string).enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { first, _ in first })
        let running = Set(tasks.filter(\.running).map(\.projectID))
        return projects.sorted { lhs, rhs in
            let leftOrder = order[lhs.id] ?? Int.max
            let rightOrder = order[rhs.id] ?? Int.max
            if leftOrder != rightOrder { return leftOrder < rightOrder }
            let left = running.contains(lhs.id)
            let right = running.contains(rhs.id)
            if left != right { return left }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    var folders: [ProjectFolder] { preferences["project_folders"].array.map { ProjectFolder(raw: $0) } }
    func chat(for task: AgentTask) -> ChatSession {
        if let value = chats[task.id] { return value }
        let value = ChatSession(); value.modelID = task.modelID; value.effort = task.effort; value.provider = task.provider
        if let saved = savedDrafts.removeValue(forKey: task.id) { value.restore(saved) }
        else if task.isDraft, let saved = composerPreferences[task.projectID]?.selections[task.provider] {
            value.applySelection(saved.validated(project: projects.first { $0.id == task.projectID }, provider: task.provider))
        }
        if task.isDraft, value.provider != task.provider {
            // A saved draft may target a harness removed from this workspace.
            // Preserve its input, but do not carry settings into a different agent.
            value.provider = task.provider
            let selection = composerPreferences[task.projectID]?.selections[task.provider]
                ?? ComposerSelection(modelID: "", effort: "", overrides: [:])
            value.applySelection(selection.validated(project: projects.first { $0.id == task.projectID }, provider: task.provider))
        }
        if !task.isDraft {
            value.provider = task.provider
            if !previewTaskIDs.contains(task.id) { value.reconcileSettings(task) }
        }
        chats[task.id] = value
        value.changed = { [weak self, weak value] in if let self, let value, !value.restoringSelection {
            if task.isDraft { self.rememberComposer(projectID: task.projectID, chat: value) }
            self.scheduleInputSave(task.id, chat: value)
        } }
        return value
    }

    func loadChat(_ task: AgentTask, older: Bool = false) async {
        let chat = chat(for: task)
        guard !chat.loading else { return }
        let current = connectionID
        chat.loading = true; chat.bufferedEvents = []; chat.bufferOverflowed = false
        if older { chat.olderHistoryError = nil } else { chat.historyError = nil; chat.olderHistoryError = nil }
        let loadID = UUID(); chat.loadID = loadID
        let delivery = chat.outgoingMessage, acceptedBeforeRead = delivery?.phase == .accepted
        defer {
            if chat.loadID == loadID {
                chat.loading = false
                if !older { recheckOutgoingHistory(task, chat: chat) }
            }
        }
        if demo {
            if !chat.loaded { chat.transcript.items = Demo.messages }
            chat.loaded = true; return
        }
        do {
            let before = older ? chat.oldestID : nil
            let page = try await Task { try await relay.detail(task: task, before: before) }.value
            // Harness prompts can include large instruction blocks. Project
            // them once off the UI actor before publishing the history page.
            let items = await Task.detached(priority: .userInitiated) { page["items"].array.map(Message.init) }.value
            // Cache valid reads even if their view disappeared during the
            // request. Reopening then shares the result instead of waiting on
            // an in-flight load whose response would otherwise be discarded.
            guard current == connectionID, chats[task.id] === chat, chat.loadID == loadID else { return }
            guard older || !chat.bufferOverflowed else { throw PilotError("Too many live updates arrived while loading history. Refresh this task to recover.") }
            if older { chat.transcript.prepend(items) }
            else {
                // Preserve unacknowledged local rows, then replay events that
                // arrived during this authoritative history request.
                let pending = chat.transcript.items.filter { pending in pending.raw["pending"].bool && !items.contains(where: { $0.id == pending.id }) }
                let revision = chat.transcript.revision
                chat.transcript = Transcript(items: items + pending, revision: revision + 1)
            }
            if !older { chat.transcript.needsRecovery = false }
            // Prepending preserves the live transcript, where these events have
            // already been applied. Only replacement history needs a replay.
            if !older { for event in chat.bufferedEvents { chat.transcript.apply(event) } }
            chat.bufferedEvents = []
            chat.hasOlder = page["has_older"].bool
            chat.oldestID = page["oldest_item_id"].string.nonempty ?? chat.transcript.items.first?.id
            chat.loaded = true; if !older { chat.needsRefresh = false }
            chat.settleSubmission(queued: page["thread"]["queued_turns"].array)
            if !older, let outgoing = chat.outgoingMessage {
                if outgoing === delivery {
                    outgoing.reconcile(history: chat.transcript.items, thread: page["thread"], acceptedBeforeRead: acceptedBeforeRead)
                } else {
                    outgoing.needsHistoryRecheck = true
                }
            }
            upsertTask(page["thread"])
            schedulePreviewSave()
        } catch {
            if current == connectionID, chats[task.id] === chat, chat.loadID == loadID {
                if older { chat.olderHistoryError = error.localizedDescription }
                else { chat.historyError = error.localizedDescription }
            }
        }
    }

    func stop(_ task: AgentTask) async {
        let current = connectionID
        let chat = chat(for: task)
        guard !chat.stopping else { return }
        chat.stopping = true; defer { chat.stopping = false }
        do {
            if demo { upsertTask(task.raw.setting("status", .string("idle"))) }
            else {
                // The RPC acknowledges an interrupt request, not completion.
                // The daemon's turn/thread events own the resulting state.
                _ = try await relay.call("turn.interrupt", params: .object(["workspace_id": .string(task.projectID), "thread_id": .string(task.id)]))
            }
        } catch { if current == connectionID { chat.error = error.localizedDescription } }
    }

    @discardableResult func createTask(project: Project, provider: String, modelID: String, folderID: String?, overrides: [String: JSON] = [:], initialInput: SavedDraft? = nil, outgoingMessage: OutgoingMessage? = nil, origin: ConversationOrigin? = nil) async throws -> AgentTask {
        let current = connectionID, origin = origin ?? conversationOrigin
        let raw: JSON
        if demo {
            raw = .object(["id": .string("demo-\(UUID())"), "workspace_id": .string(project.id), "title": .string("New task"), "provider": .string(provider), "status": .string("idle")])
        } else {
            var params = JSON.object(overrides).setting("workspace_id", .string(project.id)).setting("provider", .string(provider))
            params = params.setting("isolation", .string(project.raw["kind"].string != "casual" && overrides["isolation"] == .string("isolated") ? "isolated" : "project_folder"))
            if !modelID.isEmpty { params = params.setting("model_id", .string(modelID)) }
            raw = try await relay.call("thread.start", params: params)["thread"]
        }
        guard current == connectionID else { throw CancellationError() }
        let task = AgentTask(raw)
        let chat = chat(for: task); chat.loaded = true
        if let initialInput {
            chat.modelID = initialInput.modelID; chat.effort = initialInput.effort; chat.overrides = initialInput.overrides
            chat.sending = true
            chat.outgoingMessage = outgoingMessage
            if let outgoingMessage { chat.transcript.upsert(outgoingMessage.item) }
        }
        var ready = false
        defer {
            if initialInput != nil {
                chat.sending = false
                if !ready, let outgoingMessage {
                    chat.transcript.items.removeAll { $0.id == outgoingMessage.id && $0.raw["pending"].bool }
                    if chat.outgoingMessage === outgoingMessage { chat.outgoingMessage = nil }
                }
            }
        }
        upsertTask(raw)
        if let folderID {
            do { try await folderMutation(projectID: project.id, action: "move_thread", folderID: folderID, taskID: task.id) }
            catch { if current == connectionID { self.error = "Task created, but it could not be moved to the folder: \(error.localizedDescription)" } }
        }
        guard current == connectionID else { throw CancellationError() }
        guard chats[task.id] === chat, tasks.contains(where: { $0.id == task.id }) else { throw PilotError("The new task is no longer available.") }
        if selection == origin.selection && detailContentID == origin.contentID {
            if let initialInput { chat.composerFocused = chats[initialInput.id]?.composerFocused ?? false }
            let contentID = detailContentID
            selection = .task(task.id)
            // Continue the first send on the same list and keyboard surface.
            if outgoingMessage != nil { detailContentID = contentID }
        }
        ready = true
        return task
    }

    func updateTask(_ task: AgentTask, fields: [String: JSON]) async {
        let current = connectionID
        do { _ = try await taskRequest(task, method: "thread.update", fields: fields) }
        catch { if current == connectionID { self.error = error.localizedDescription } }
    }

    func archive(_ task: AgentTask) async {
        let current = connectionID
        do {
            if !demo { _ = try await relay.call("thread.archive", params: .object(["workspace_id": .string(task.projectID), "thread_id": .string(task.id)])) }
            guard current == connectionID else { return }
            pendingSummaries.removeValue(forKey: task.id)
            if archivedLoadID != nil { archivedTouched.insert(task.id) }
            let input = chats[task.id]?.saved(id: task.id)
            if let input { savedDrafts[task.id] = input }
            draftSaves.removeValue(forKey: task.id)?.cancel()
            archivedTasks.removeAll { $0.id == task.id }; archivedTasks.append(AgentTask(task.raw.setting("is_archived", .bool(true))))
            tasks.removeAll { $0.id == task.id }; chats.removeValue(forKey: task.id)
            schedulePreviewSave()
            if selection == .task(task.id) { selection = .projects }
            if let input, let store = draftStore {
                do { try await store.save(input) }
                catch { if current == connectionID { self.error = "Task archived, but its unsent input couldn't be saved: \(error.localizedDescription)" } }
            }
        } catch { if current == connectionID { self.error = error.localizedDescription } }
    }

    func folderMutation(projectID: String, action: String, folderID: String? = nil, name: String? = nil, taskID: String? = nil, collapsed: Bool? = nil) async throws {
        var mutation = JSON.object(["workspace_id": .string(projectID), "action": .string(action)])
        if let folderID { mutation = mutation.setting("folder_id", .string(folderID)) }
        else if action == "move_thread" { mutation = mutation.setting("folder_id", .null) }
        if let name { mutation = mutation.setting("name", .string(name)) }
        if let taskID { mutation = mutation.setting("thread_id", .string(taskID)) }
        if let collapsed { mutation = mutation.setting("collapsed", .bool(collapsed)) }
        if demo { applyDemoFolder(mutation); return }
        try await updatePreferences(.object(["project_folder": mutation]))
    }

    private func applyDemoFolder(_ mutation: JSON) {
        var values = preferences["project_folders"].array
        let id = mutation["folder_id"].string
        switch mutation["action"].string {
        case "create": values.append(mutation.setting("id", .string(UUID().uuidString)).setting("thread_ids", .array([])))
        case "delete": values.removeAll { $0["id"].string == id }
        case "rename", "set_collapsed":
            if let index = values.firstIndex(where: { $0["id"].string == id }) {
                let key = mutation["action"].string == "rename" ? "name" : "collapsed"
                values[index] = values[index].setting(key, mutation[key])
            }
        case "move_thread":
            for index in values.indices {
                var ids = values[index]["thread_ids"].array.filter { $0 != mutation["thread_id"] }
                if values[index]["id"].string == id { ids.append(mutation["thread_id"]) }
                values[index] = values[index].setting("thread_ids", .array(ids))
            }
        default: break
        }
        preferences = preferences.setting("project_folders", .array(values))
    }

    func respond(request: JSON, response: JSON) async throws {
        let current = connectionID
        if !demo {
            _ = try await relay.call("interactive.respond", params: .object(["workspace_id": request["workspace_id"], "request_id": request["request_id"], "response": response]))
        }
        guard current == connectionID else { throw CancellationError() }
        requests.removeAll { $0["request_id"] == request["request_id"] }
    }
}

enum Demo {
    static let preferences = JSON.object(["project_folders": .array([
        .object(["id": .string("native-folder"), "workspace_id": .string("falcondeck"), "name": .string("Native app"), "collapsed": .bool(false), "thread_ids": .array([.string("native"), .string("review")])]),
        .object(["id": .string("reliability-folder"), "workspace_id": .string("falcondeck"), "name": .string("Reliability"), "collapsed": .bool(true), "thread_ids": .array([.string("relay")])])
    ])])
    static let markdownReply = """
    ## A native place for your work

    This is a **local demo reply**. In live mode, this composer sends messages to your agent through the encrypted relay.

    - Native sidebar with projects and folders
    - Live replies, tool activity, and reasoning
    - Selectable Markdown with `inline code`

    ```swift
    struct FalconDeck: View {
        var body: some View {
            Text("Your agents, in focus.")
        }
    }
    ```

    | Experience | Native client |
    | --- | --- |
    | Chat | Streamed replies |
    | Navigation | Projects and folders |
    | Privacy | End-to-end encrypted |

    ```mermaid
    flowchart LR
        Phone[Native app] --> Relay[Encrypted relay]
        Relay --> Computer[Your computer]
    ```

    > Your computer remains the source of truth.

    [FalconDeck](https://falcondeck.com)
    """
    static let requests: [JSON] = [
        .object(["request_id": .string("demo-approval"), "workspace_id": .string("falcondeck"), "thread_id": .string("review"), "kind": .string("approval"), "title": .string("Run the focused UI checks?"), "command": .string("swift test --filter SidebarTests\n# Check small-screen layout\n# Check tablet navigation\n# Check text-size changes\n# Check keyboard focus\n# Check menu anchoring\n# Check pin density\n# Check project folders\nswift test --filter ComposerTests")]),
        .object(["request_id": .string("demo-question"), "workspace_id": .string("falcondeck"), "thread_id": .string("review"), "kind": .string("question"), "title": .string("Choose a sidebar layout"), "questions": .array([
            .object(["id": .string("layout"), "header": .string("Sidebar"), "question": .string("Which layout should we keep?"), "options": .array([
                .object(["label": .string("Compact"), "description": .string("Single-line tasks, with projects before chats.")]),
                .object(["label": .string("Comfortable"), "description": .string("More room between task rows.")])
            ])])
        ])])
    ]
    static let projects: [Project] = [
        project("falcondeck", "/Projects/falcondeck"), project("quizgecko", "/Projects/quizgecko"),
        project("lookset", "/Projects/lookset"), project("lucidpic", "/Projects/lucidpic"), project("casual", "/Chats", kind: "casual")
    ]
    static let tasks: [AgentTask] = [
        task("native", "falcondeck", "A more native way to work", "codex", "running", "Exploring the little details that make an app feel right at home on iPhone.", pinned: true),
        task("relay", "falcondeck", "Make reconnects feel instant", "claude", "idle", "The relay recovery path now restores a fresh snapshot when history has been pruned."),
        task("review", "falcondeck", "Review the new project sidebar", "codex", "waiting_for_input", "The implementation is ready. There’s one decision to make about the compact layout."),
        task("quiz", "quizgecko", "Bring the study flow to SwiftUI", "claude", "running", "The flashcard transition now follows your gesture with a spring animation."),
        task("voice", "quizgecko", "Polish the voice tutor", "codex", "idle", "The tutor keeps listening while you move between study materials.", pinned: true),
        task("samples", "lookset", "A fresh set of product scenes", "claude", "idle", "Four directions, with consistent lighting and a quieter background.", pinned: true),
        task("images", "lucidpic", "Simplify the image library", "codex", "idle", "The library now groups recent generations into a single collection.", pinned: true),
        task("polish", "falcondeck", "Polish the mobile experience", "codex", "idle", "A consistent hierarchy across phone, tablet and desktop.", pinned: true),
        task("chat", "casual", "Plan the next release", "claude", "idle", "A quick conversation, outside a project.")
    ]
    static let longRequest = """
    Please keep the following priorities in mind as you review the native client.

    - Follow the existing desktop and mobile hierarchy so moving between devices feels familiar.
    - Show globally pinned tasks first, then projects with their folders, followed by casual chats.
    - Keep task names on a single line while preserving comfortable touch targets.
    - Use the same light and dark palettes throughout navigation, conversations and settings.
    - Make secondary actions easy to find without filling every row with buttons.
    - Keep model selection and reasoning choices readable on a smaller phone.
    - Present activity details compactly, with complete output available when I open them.
    - Preserve my reading position when I expand a tool result or a longer message.
    - Keep the latest reply in view when a conversation first opens or new content arrives.
    - Let me scroll back through the history without being pulled away by a live reply.
    - Make keyboard transitions, sheet presentation and project expansion feel natural.
    - Check the layout on a phone and tablet, including landscape and larger text.
    - Keep unsent messages safe while switching tasks or reconnecting to the computer.
    - Leave the released app alone while the native development build is being tested.
    """
    static let messages: [Message] = [
        message("1", "user_message", "Let’s explore a truly native FalconDeck. Keep the core experience simple, but make it feel great on iPhone."),
        message("2", "assistant_message", "I’ve narrowed the pilot down to three things: your projects, the tasks inside them, and the conversations that matter.\n\nThe interface uses **native SwiftUI navigation**, SF Symbols, and glass controls. Projects stay in the sidebar, and the conversation layout adapts to your text size."),
        message("3", "user_message", "Can it talk to the real relay too?"),
        message("4", "assistant_message", markdownReply),
        Message(.object(["id": .string("tool-read"), "kind": .string("tool_call"), "title": .string("Read sidebar views"), "status": .string("completed"), "tool_kind": .string("read"), "output": .string("Reviewed navigation, project folders and pinned tasks.")])),
        message("5", "assistant_message", "I’m checking the layout at phone and tablet sizes, including menus and keyboard states."),
        Message(.object(["id": .string("tool-tests"), "kind": .string("tool_call"), "title": .string("Run UI checks"), "status": .string("completed"), "tool_kind": .string("command"), "output": .string("All focused checks passed.")])),
        message("long-request", "user_message", longRequest),
        message("6", "assistant_message", "The core layout is ready to test. Projects stay above chats, pins fit on one line, and model settings have a stable sheet.\n\n- Open a project to see its folders.\n- Long-press a task for secondary actions.\n- Use the composer to continue the conversation.")
    ]
    private static func project(_ id: String, _ path: String, kind: String = "project") -> Project {
        let efforts = ["low", "medium", "high"].map { JSON.object(["reasoning_effort": .string($0)]) }
        let agents = [("codex", "GPT-5.4"), ("claude", "Opus 4.5")].map { provider, name in
            JSON.object(["provider": .string(provider), "models": .array([
                .object(["id": .string("demo-model"), "label": .string(name), "is_default": .bool(true), "supported_reasoning_efforts": .array(efforts)])
            ]), "capabilities": .object([
                "permission_modes": .array([.string("default"), .string("never")]),
                "sandbox_modes": .array([.string("workspace-write"), .string("read-only")])
            ])])
        }
        return Project(.object(["id": .string(id), "path": .string(path), "kind": .string(kind), "agents": .array(agents), "status": .string("connected")]))
    }
    private static func task(_ id: String, _ project: String, _ title: String, _ provider: String, _ status: String, _ preview: String, pinned: Bool = false) -> AgentTask {
        AgentTask(.object(["id": .string(id), "workspace_id": .string(project), "title": .string(title), "provider": .string(provider),
                           "status": .string(status), "last_message_preview": .string(preview), "updated_at": .string("2026-10-17T07:00:00Z"), "is_pinned": .bool(pinned)]))
    }
    private static func message(_ id: String, _ kind: String, _ text: String) -> Message {
        Message(.object(["id": .string(id), "kind": .string(kind), "text": .string(text)]))
    }
}
