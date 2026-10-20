import SwiftUI
import AppKit

struct ConversationView: View {
    @Bindable var store: AppStore
    @State var followsLatest = true
    @State var selection = NativeComposerSelection()
    @State var attachments: [NativeMacAttachment] = []
    @State var quote = ""
    @State var skills: [JSON] = []
    @State var prompts: [JSON] = []
    @State var loadingCatalog = false
    @State var actionPending = false
    @State var activeSheet: ConversationSheet?
    @State var findVisible = false
    @State var findText = ""
    @State var findIndex = 0
    @State var expansionDirective = 0

    var provider: String { store.selectedTask?.provider ?? store.provider }
    var agent: JSON { ConversationCatalog.agent(store.selectedProject, provider: provider) }
    var capabilities: JSON { agent["capabilities"] }
    var catalogKey: String { (store.selectedProjectID ?? "") + ":" + provider }
    var selectionKey: String { "selection:" + catalogKey }
    var steersCurrentTurn: Bool { selection.followUp == "steer" && capabilities["supports_steering"].bool }
    var canSend: Bool {
        store.isInputReady && store.isSelectedHostConnected && store.selectedProject != nil && !store.isSending && !actionPending && store.pendingSubmission == nil &&
        (!store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }
    var sendHelp: String {
        let label = store.isRunning ? (steersCurrentTurn ? "Steer current turn" : "Queue follow-up") : "Send message"
        guard let binding = NativePreferences.shared.bindings(for: "sendMessage").first else { return label }
        return label + " (" + NativeShortcutDefinition.display(binding) + ")"
    }
    var matches: [String] {
        findText.isEmpty ? [] : store.messages.filter { TranscriptPresentation.matchesSearch($0, query: findText) }.map(\.id)
    }
    var workingDirectory: String {
        let isolated = store.selectedTask?.raw["variant"]["path"].string ?? ""
        return isolated.isEmpty ? store.selectedProject?.path ?? "" : isolated
    }
    var transcriptGroups: [ConversationMessageGroup] {
        ConversationTranscriptGroups.groups(messages: store.messages, preferences: store.preferences, thinkingDisplay: NativePreferences.shared.thinkingDisplay, isStreaming: store.isRunning).map { ConversationMessageGroup(items: $0) }
    }

    var body: some View {
        VStack(spacing: 0) {
            conversationHeader
            if let error = store.errorMessage { errorBanner(error) }
            if let pending = store.pendingSubmission { ConversationDeliveryRecovery(store: store, pending: pending).id(pending.id) }
            Group {
                if store.isLoading && store.messages.isEmpty && store.selectedTaskID != nil {
                    VStack(spacing: 12) { MacActivityDiamond(size: 11); Text("Loading conversation…").font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted) }
                        .frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityIdentifier("conversation-loading")
                } else if store.messages.isEmpty { emptyConversation }
                else { transcript }
            }
            VStack(spacing: 10) {
                if let task = store.selectedTask { ConversationTaskPanels(store: store, task: task, capabilities: capabilities).id(task.id) }
                InteractiveRequestsView(store: store)
            }.frame(maxWidth: 900).padding(.horizontal, 28)
            NativeComposerSuggestionsView(store: store, settings: selection.validated(project: store.selectedProject, provider: provider, task: store.selectedTask).fields)
            composer
        }
        .background(FDTheme.background)
        .task(id: catalogKey) { restoreSelection(); await loadCatalog() }
        .onAppear { restorePayload() }
        .onChange(of: store.composerKey) { _, _ in restorePayload(); restoreSelection(); followsLatest = true; findIndex = 0; expansionDirective = 0 }
        .onChange(of: store.composerPayload(key: store.composerKey)) { _, _ in restorePayload() }
        .onChange(of: selection) { _, value in if store.selectedTask == nil { ConversationLocalStorage.save(value, key: selectionKey) } }
        .onChange(of: store.isSelectedHostConnected) { _, connected in if connected { Task { await loadCatalog() } } }
        .onChange(of: NativePreferences.shared.followUpBehavior) { _, behavior in selection.followUp = behavior }
        .onChange(of: selection.followUp) { _, behavior in NativePreferences.shared.followUpBehavior = behavior }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("native.command"))) { note in
            switch note.object as? String {
            case "findInThread" where note.userInfo?["context"] as? String != "terminal": findVisible = true
            case "sendMessage": send()
            case "invertFollowUp": sendAlternate()
            default: break
            }
        }
        .sheet(item: $activeSheet) { sheet in
            if let task = store.selectedTask {
                switch sheet {
                case .goal: ConversationGoalEditor(store: store, task: task)
                case .compact: ConversationActionEditor(title: "Compact conversation", description: "Summarize the agent's context while keeping this conversation's history.", fieldLabel: "Optional instructions", value: "", allowsEmpty: true, acceptsInput: capabilities["supports_compaction_instructions"].bool) { text in
                    _ = try await ConversationActions.request(store, task: task, suffix: "/compact", body: ConversationActionSemantics.compactionBody(instructions: text, capabilities: capabilities))
                }
                case .rename: ConversationActionEditor(title: "Rename conversation", description: "", fieldLabel: "Title", value: task.title, allowsEmpty: false) { text in
                    _ = try await ConversationActions.request(store, task: task, method: "PATCH", body: .object(["title": .string(text)]))
                }
            }
        }
        }
    }

    var conversationHeader: some View {
        HStack(spacing: 10) {
            if let project = store.selectedProject {
                ProjectNavigatorGlyph(store: store, project: project,
                    preference: store.navigationPreferences["workspace_icons"][project.id], color: FDTheme.accent)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(store.selectedTask?.title ?? "New task").font(NativePreferences.shared.font(size: 15, weight: .medium)).foregroundStyle(FDTheme.foreground)
                    .lineLimit(1).accessibilityIdentifier("conversation-title")
                HStack(spacing: 5) {
                    Text(store.selectedProject?.name ?? "Select a project to get started")
                    if let task = store.selectedTask, !task.raw["variant"]["path"].string.isEmpty {
                        Image(systemName: "arrow.triangle.branch")
                        Text(URL(fileURLWithPath: workingDirectory).lastPathComponent)
                    }
                }.font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
                    .lineLimit(1).truncationMode(.middle).help(workingDirectory)
            }
            Spacer(minLength: 12)
            if actionPending { ProgressView().controlSize(.small) }
            if let task = store.selectedTask {
                HStack(spacing: 6) {
                    TaskStatusMark(status: task.status)
                    Text(FDTheme.statusLabel(task.status)).font(NativePreferences.shared.font(size: 12)).foregroundStyle(task.running ? FDTheme.accent : FDTheme.muted)
                }.padding(.horizontal, 10).padding(.vertical, 6).background(FDTheme.surface, in: .capsule)
                Button { findVisible.toggle() } label: { Image(systemName: "magnifyingglass") }.buttonStyle(.plain).help("Find in conversation (⌘F)")
                if ConversationTranscriptGroups.showsExpansionControls(preferences: store.preferences) {
                    Menu {
                        Button("Expand all activity") { expansionDirective = abs(expansionDirective) + 1 }
                        Button("Collapse all activity") { expansionDirective = -(abs(expansionDirective) + 1) }
                    } label: { Image(systemName: "rectangle.expand.vertical") }.menuStyle(.borderlessButton).fixedSize().help("Expand or collapse activity")
                }
                taskMenu(task)
            }
        }.padding(.horizontal, 20).padding(.vertical, 8).frame(minHeight: 52)
            .overlay(alignment: .bottom) { FDTheme.hairline.frame(height: 1) }
    }

    var emptyConversation: some View {
        VStack {
            Spacer()
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "square.and.pencil").font(.system(size: 23, weight: .light)).foregroundStyle(FDTheme.accent)
                    .frame(width: 52, height: 52).background(FDTheme.accentDim, in: .rect(cornerRadius: 14))
                Text(store.selectedTaskID == nil ? "What are we working on?" : "The conversation starts here.")
                    .font(NativePreferences.shared.font(size: 27, surface: "chat", weight: .semibold)).tracking(-0.7).foregroundStyle(FDTheme.foreground)
                Text(store.selectedProject.map { "Your agent is ready in \($0.name). Describe a change, ask a question, or explore the project." } ?? "Choose a project or create a chat from the sidebar.")
                    .font(NativePreferences.shared.font(size: 16, surface: "chat")).lineSpacing(6).foregroundStyle(FDTheme.muted).fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: 480, alignment: .leading).padding(.horizontal, 36)
            Spacer(); Spacer().frame(height: 32)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    var transcript: some View {
        let retrySources = ConversationActionSemantics.retrySources(messages: store.messages)
        let firstDiffID = ConversationTranscriptGroups.firstDiffItemID(messages: store.messages)
        let groups = transcriptGroups
        let liveGroupID = store.isRunning ? groups.last?.id : nil
        let hasLiveActivityGroup = groups.last.map {
            store.isRunning && ConversationTranscriptGroups.isActivityGroup($0.items, preferences: store.preferences)
        } ?? false
        return GeometryReader { viewport in
            ScrollViewReader { proxy in
                VStack(spacing: 0) {
                    if findVisible { findBar(proxy: proxy) }
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            if store.hasOlder {
                                Button {
                                    let firstID = store.messages.first?.id; followsLatest = false
                                    Task { await store.loadOlder(); if let firstID { proxy.scrollTo(firstID, anchor: .top) } }
                                } label: {
                                    HStack(spacing: 8) { if store.isLoadingOlder { ProgressView().controlSize(.small) }; Text(store.isLoadingOlder ? "Loading earlier messages…" : "Load earlier messages") }
                                        .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted).frame(maxWidth: .infinity).padding(10)
                                }.buttonStyle(.plain).disabled(store.isLoadingOlder).accessibilityIdentifier("load-earlier-messages")
                            }
                            ForEach(groups) { group in
                                // Give the lazy stack one child per group so it
                                // need not traverse conditional row trees on every delta.
                                VStack(alignment: .leading, spacing: 0) {
                                    if !ConversationTranscriptGroups.isActivityGroup(group.items, preferences: store.preferences), let message = group.items.first {
                                        transcriptRow(message, firstDiffID: firstDiffID, retryable: retrySources[message.id] != nil).padding(findText.isEmpty ? 0 : 8)
                                            .background(matches.contains(message.id) ? FDTheme.accentDim : .clear, in: .rect(cornerRadius: 8)).id(message.id)
                                    } else {
                                        ConversationTranscriptBurst(group: group, running: ConversationTranscriptGroups.isRunning(group.items, keepAlive: group.id == liveGroupID), expansionDirective: expansionDirective, findText: findText) { message in
                                            AnyView(transcriptRow(message, firstDiffID: firstDiffID, retryable: retrySources[message.id] != nil, activityInset: 0).id(message.id))
                                        }.id(group.id)
                                    }
                                }
                            }
                            NativeExtensionToolResults(store: store, messages: store.messages)
                            if store.isRunning && !hasLiveActivityGroup && groups.last?.items.last.map(TranscriptPresentation.hasActivityIndicator) != true {
                                HStack(spacing: 8) { MacActivityDiamond(size: 7); Text("\(FDTheme.providerName(provider)) is working").font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted) }
                                    .padding(.leading, 35).accessibilityIdentifier("agent-working")
                            }
                            Color.clear.frame(height: 1).id("transcript-bottom").background {
                                GeometryReader { geometry in Color.clear.preference(key: TranscriptBottomPosition.self, value: geometry.frame(in: .named("transcript-scroll")).maxY) }
                            }
                        }.frame(maxWidth: 900, alignment: .leading).padding(.horizontal, 32).padding(.top, 26).padding(.bottom, 20).frame(maxWidth: .infinity)
                    }
                    .coordinateSpace(name: "transcript-scroll")
                    .onPreferenceChange(TranscriptBottomPosition.self) { followsLatest = $0 <= viewport.size.height + 100 }
                    .onAppear { proxy.scrollTo("transcript-bottom", anchor: .bottom) }
                    .onChange(of: store.messages.last?.text) { _, _ in if followsLatest { proxy.scrollTo("transcript-bottom", anchor: .bottom) } }
                    .onChange(of: store.messages.count) { _, _ in if followsLatest { proxy.scrollTo("transcript-bottom", anchor: .bottom) } }
                    .overlay(alignment: .bottom) {
                        if !followsLatest {
                            Button { followsLatest = true; proxy.scrollTo("transcript-bottom", anchor: .bottom) } label: {
                                Label("Jump to latest", systemImage: "arrow.down").font(NativePreferences.shared.font(size: 12, weight: .medium)).padding(.horizontal, 12).padding(.vertical, 8)
                            }.buttonStyle(.plain).foregroundStyle(FDTheme.secondary).background(FDTheme.raised, in: .capsule).overlay { Capsule().strokeBorder(FDTheme.line) }.padding(.bottom, 10)
                        }
                    }.accessibilityIdentifier("conversation-transcript")
                }
            }
        }
    }

    func transcriptRow(_ message: Message, firstDiffID: String?, retryable: Bool, activityInset: CGFloat = 35) -> some View {
        ConversationTranscriptRow(message: message, provider: provider, preferences: store.preferences,
            firstDiff: message.id == firstDiffID, activityInset: activityInset, expansionDirective: expansionDirective,
            onQuote: { text in quote = text; persistPayload() },
            onEdit: canBranch && message.kind == "user_message" && !message.raw["turn_id"].string.isEmpty ? { action { try await edit(message, retry: false) } } : nil,
            onRetry: canBranch && retryable ? { action { try await retry(message) } } : nil,
            onReadAloud: { text in NativeAudioPlayback.shared.speak(messageID: message.id, text: text, store: store) },
            onLoadFullOutput: {
                guard let task = store.selectedTask else { throw PilotError("Select a task first.") }
                return try await store.request(path: conversationPath(task) + "/items/" + conversationPathComponent(message.id))
            }, onOpenFile: { path, line in NativeInspectorNavigation.open(store: store, path: path, line: line) })
    }

    func findBar(proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 10) {
            TextField("Find in loaded messages", text: $findText).textFieldStyle(.roundedBorder).onSubmit { navigateFind(1, proxy: proxy) }
            Text(matches.isEmpty ? "0 matches" : "\(min(findIndex + 1, matches.count)) of \(matches.count)").font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted).fixedSize()
            Button { navigateFind(-1, proxy: proxy) } label: { Image(systemName: "chevron.up") }.disabled(matches.isEmpty)
            Button { navigateFind(1, proxy: proxy) } label: { Image(systemName: "chevron.down") }.disabled(matches.isEmpty)
            Button { findVisible = false; findText = "" } label: { Image(systemName: "xmark") }
        }.buttonStyle(.plain).padding(.horizontal, 28).padding(.vertical, 9).background(FDTheme.surface)
            .onChange(of: findText) { _, _ in findIndex = 0; if let id = matches.first { followsLatest = false; proxy.scrollTo(id, anchor: .top) } }
    }
    func navigateFind(_ offset: Int, proxy: ScrollViewProxy) {
        guard !matches.isEmpty else { return }; findIndex = (findIndex + offset + matches.count) % matches.count
        followsLatest = false; proxy.scrollTo(matches[findIndex], anchor: .top)
    }

    var composer: some View {
        let composerKey = store.composerKey
        return VStack(spacing: 8) {
            if !store.isInputReady {
                HStack(spacing: 8) {
                    Image(systemName: "lock")
                    Text(store.inputRecoveryError ?? "Waiting for Keychain to restore saved input…")
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !store.isRestoringInput {
                        Button("Retry") { Task { await store.reconnect() } }
                            .buttonStyle(.plain)
                    }
                }
                .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            }
            let slashItems = ConversationSlash.suggestions(store.draft, skills: skills, prompts: prompts)
            if !slashItems.isEmpty {
                ConversationSlashSuggestions(items: slashItems) { item in store.draft = ConversationSlash.insert(item, into: store.draft) }
            }
            VStack(alignment: .leading, spacing: 0) {
                if !quote.isEmpty {
                    HStack(alignment: .top) {
                        Image(systemName: "text.quote").foregroundStyle(FDTheme.accent)
                        Text(quote).font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                        Button { quote = ""; persistPayload() } label: { Image(systemName: "xmark") }.buttonStyle(.plain).help("Remove quote")
                    }.padding(12).background(FDTheme.surface, in: .rect(cornerRadius: 7)).padding(8)
                }
                if !attachments.isEmpty {
                    ConversationAttachmentStrip(attachments: attachments) { id in attachments.removeAll { $0.id == id }; persistPayload() }.padding(10)
                }
                ConversationTextEditor(text: $store.draft, placeholder: !store.isInputReady ? "Restoring saved input…" : store.isRunning ? "Send a follow-up…" : "Message your agent…", onSend: send,
                                       onAttachments: { appendAttachments($0, expectedKey: composerKey) }, onError: { store.errorMessage = $0 }, onAlternateSend: sendAlternate)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("message-composer")
                HStack(spacing: 10) {
                    ConversationComposerControls(store: store, selection: $selection,
                                                 attach: pickAttachments, refreshCatalog: { Task { await loadCatalog() } }, chooseAgent: { destination in
                        if let task = store.selectedTask { action { try await handoff(task, provider: destination) } }
                        else { store.provider = destination }
                    })
                    Spacer(minLength: 4)
                    if NativeSpeechController.shared.config.enabled {
                        Button { NativeSpeechController.shared.startOrStop() } label: {
                            Image(systemName: NativeSpeechController.shared.isRecording ? "stop.circle.fill" : "mic")
                                .font(.system(size: 13)).frame(width: 28, height: 28)
                                .foregroundStyle(NativeSpeechController.shared.isRecording ? FDTheme.warning : FDTheme.muted)
                        }.buttonStyle(.plain).disabled(NativeSpeechController.shared.isBusy)
                            .help("Dictate a message").accessibilityLabel("Dictate message")
                    }
                    if store.isRunning {
                        Button { Task { await store.interrupt() } } label: { Image(systemName: "stop.fill").font(.system(size: 10)).frame(width: 28, height: 28).background(FDTheme.hover, in: .rect(cornerRadius: 7)) }
                            .buttonStyle(.plain).help("Stop the current turn").accessibilityLabel("Stop agent").accessibilityIdentifier("stop-agent")
                    }
                    Button(action: send) {
                        Group { if store.isSending { ProgressView().controlSize(.small) } else { Image(systemName: store.isRunning && !steersCurrentTurn ? "text.badge.plus" : "arrow.up").font(.system(size: 14, weight: .semibold)) } }
                            .frame(width: 30, height: 28).foregroundStyle(canSend ? FDTheme.background : FDTheme.subtle)
                            .background(canSend ? FDTheme.accent : FDTheme.hover, in: .rect(cornerRadius: 7))
                    }.buttonStyle(.plain).disabled(!canSend)
                        .help(sendHelp)
                        .accessibilityLabel("Send message").accessibilityIdentifier("send-message")
                }.padding(.horizontal, 12).padding(.bottom, 10).padding(.top, 2)
            }.disabled(!store.isInputReady)
                .background(FDTheme.raised, in: .rect(cornerRadius: 12)).overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(FDTheme.line) }
            if !store.isSelectedHostConnected {
                Label("Reconnect to send a message", systemImage: "wifi.slash")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            }
        }.frame(maxWidth: 900).padding(.horizontal, 28).padding(.top, 12).padding(.bottom, 14).frame(maxWidth: .infinity)
    }

    func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(FDTheme.warning)
            Text(message).font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            Button("Reconnect") { Task { await store.reconnect() } }.buttonStyle(.borderless).font(NativePreferences.shared.font(size: 12, weight: .medium))
            Button { store.errorMessage = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(FDTheme.muted).accessibilityLabel("Dismiss error")
        }.padding(.horizontal, 28).padding(.vertical, 12).background(FDTheme.warning.opacity(0.07))
    }
}

private struct TranscriptBottomPosition: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
enum ConversationSheet: String, Identifiable { case goal, compact, rename; var id: String { rawValue } }

struct ConversationMessageGroup: Identifiable {
    let items: [Message]
    var id: String { items.first?.id ?? "empty" }
}

private struct ConversationTranscriptBurst: View {
    let group: ConversationMessageGroup
    let running: Bool
    let expansionDirective: Int
    let findText: String
    let row: (Message) -> AnyView
    @State private var expanded = false
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) { ForEach(group.items) { row($0) } }.padding(.top, 6)
        } label: {
            HStack(spacing: 7) {
                if running { MacActivityDiamond(size: 7) }
                Text(ConversationTranscriptGroups.title(for: group.items, running: running))
            }.font(NativePreferences.shared.font(size: 13, surface: "chat")).foregroundStyle(FDTheme.muted)
        }.padding(.leading, 35)
            .onChange(of: expansionDirective, initial: true) { _, directive in if directive != 0 { expanded = directive > 0 } }
            .onChange(of: findText, initial: true) { _, query in
                if group.items.contains(where: { TranscriptPresentation.matchesSearch($0, query: query) }) { expanded = true }
            }
    }
}
