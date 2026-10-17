import SwiftUI
import Observation

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    @State private var chat: ChatSession?
    private var current: AgentTask { model.task(task.id) ?? task }
    var body: some View {
        Group {
            if let chat { ChatContent(task: current, chat: chat) }
            else { ActivityDiamond().frame(maxWidth: .infinity, maxHeight: .infinity).background(FD.background) }
        }
        .task(id: task.id) {
            let session = model.chat(for: task); chat = session
            if task.isDraft { session.loaded = true }
            else if !session.loaded { await model.loadChat(task) }
        }
        .onChange(of: model.connected) { _, connected in if connected && !task.isDraft { Task { await model.loadChat(current) } } }
    }
}

private struct ChatContent: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let task: AgentTask
    @Bindable var chat: ChatSession
    @State private var scroll = TranscriptScrollState()
    @State private var showGoal = false
    @State private var visible = false
    private var expansion: TranscriptExpansion? { chat.transcriptExpansion }
    @State private var contextHeight: CGFloat = 0
    @State private var viewportHeight: CGFloat = 600
    @State private var bottomInsetHeight: CGFloat = 0
    private var project: Project? { model.projects.first { $0.id == task.projectID } }
    private var requests: [JSON] { model.requests.filter { $0["thread_id"].string == task.id } }

    private var preferences: ConversationPreferences { ConversationPreferences(raw: model.preferences["conversation"]) }
    private var actionIDs: Set<String> { TranscriptBlock.actionMessageIDs(chat.transcript.items) }
    private var blocks: [TranscriptBlock] { TranscriptBlock.build(chat.transcript.items, preferences: preferences, running: task.running) }
    var body: some View {
        let actions = actionIDs
        let blocks = blocks
        ScrollViewReader { proxy in
            List {
                Group {
                    if chat.hasOlder {
                        Button {
                            let anchor = chat.transcript.items.first?.id
                            Task { await model.loadChat(task, older: true); if let anchor { proxy.scrollTo(anchor, anchor: .top) } }
                        } label: { HStack { if chat.loading { ActivityDiamond() }; Text("Load earlier messages") }.frame(maxWidth: .infinity) }
                            .font(.footnote).foregroundStyle(FD.secondary).disabled(chat.loading)
                    }
                    ForEach(blocks) { block in
                        Group {
                            if block.grouped { TranscriptGroup(block: block, task: task, expansion: expansion, onInteraction: { scroll.followLatest = false }).id(block.id) }
                            else if let item = block.items.first { TranscriptRow(message: item, task: task, firstDiff: block.firstDiff, showsActions: actions.contains(item.id), expansion: expansion, onInteraction: { scroll.followLatest = false }).id(item.id) }
                        }.frame(maxWidth: 820).frame(maxWidth: .infinity)
                    }
                    if task.running && !chat.transcript.items.isEmpty {
                        HStack(spacing: 8) { ActivityDiamond(); Text("\(task.provider.capitalized) is working…").font(.footnote).foregroundStyle(FD.secondary) }.padding(.vertical, 8).frame(maxWidth: 820, alignment: .leading).frame(maxWidth: .infinity)
                    }
                    Color.clear.frame(height: 1).id("latest")
                }
                .listRowInsets(EdgeInsets(top: 6, leading: FD.inset, bottom: 6, trailing: FD.inset))
                .listRowSeparator(.hidden).listRowBackground(Color.clear)
                .buttonStyle(.plain)
            }
            .listStyle(.plain).scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
            .contentMargins(.vertical, 10, for: .scrollContent)
            .accessibilityIdentifier("conversation-transcript")
            // Keep initial positioning independent from subsequent reading/reflow.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onScrollGeometryChange(for: Bool.self) { g in g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 120 } action: { _, value in
                // Content growth and keyboard dismissal also change geometry.
                // Only an actual reading gesture should turn following off.
                scroll.nearLatest = value
                if scroll.userScrolling { scroll.followLatest = value }
            }
            .onChange(of: viewportHeight) { _, _ in
                // Observe the outer layout, which cannot change as lazy rows are
                // measured. Keyboard and composer resizing must still follow.
                if scroll.followLatest && !scroll.userScrolling { scrollToLatest(proxy, animated: false) }
            }
            .onChange(of: bottomInsetHeight) { _, _ in
                if scroll.followLatest && !scroll.userScrolling { scrollToLatest(proxy, animated: false) }
            }
            .onScrollPhaseChange { previous, phase in
                scroll.userScrolling = phase == .tracking || phase == .interacting || phase == .decelerating
                // A drag expresses reading intent even if the near-end value did
                // not cross its threshold during that gesture.
                if phase == .interacting { scroll.followLatest = false }
                else if phase == .idle && (previous == .interacting || previous == .decelerating) && scroll.nearLatest {
                    scroll.followLatest = true
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { if !task.isDraft { await model.loadChat(task) } }
            .onChange(of: chat.transcript.revision) { _, _ in
                if scroll.followLatest || chat.sending { scrollToLatest(proxy, animated: true) }
            }
            .onChange(of: chat.loaded, initial: true) { _, loaded in if loaded { scrollToLatest(proxy, animated: false) } }
            .onChange(of: chat.sending) { _, sending in if sending { scroll.followLatest = true; scrollToLatest(proxy, animated: true) } }
            // Pane states stay outside the bottom-anchored list so they cannot
            // scroll off screen, including during keyboard/composer resizing.
            .overlay {
                if blocks.isEmpty {
                    VStack(spacing: 12) {
                        if chat.loading {
                            ActivityDiamond()
                            Text("Loading conversation…").font(.subheadline).foregroundStyle(FD.secondary)
                        } else if let error = chat.historyError {
                            Image(systemName: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90").foregroundStyle(FD.secondary)
                            Text("Couldn’t load this conversation").font(.headline)
                            Text(error).font(.subheadline).foregroundStyle(FD.secondary).multilineTextAlignment(.center)
                            Button("Try again") { Task { await model.loadChat(task) } }
                                .buttonStyle(.glass).accessibilityIdentifier("conversation-retry")
                        } else if chat.loaded {
                            Text(chat.hasOlder ? "No recent messages" : "No messages yet").font(.headline)
                            Text(chat.hasOlder ? "Load earlier messages to see this conversation." : "Send a message to get started")
                                .font(.subheadline).foregroundStyle(FD.secondary)
                        } else if !model.connected && !model.demo {
                            Text("Waiting for your computer").font(.headline)
                            Text("This conversation will load when you reconnect.").font(.subheadline).foregroundStyle(FD.secondary)
                        }
                    }
                    .padding(24).frame(maxWidth: 420)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier(chat.loading ? "conversation-loading" : "conversation-empty")
                }
            }
            .overlay(alignment: .bottomTrailing) {
                LatestMessageShortcut(state: scroll, hasMessages: !chat.transcript.items.isEmpty) {
                    scroll.followLatest = true; scrollToLatest(proxy, animated: true)
                }
            }
        }
        .background(FD.background).navigationTitle(task.title.nonempty ?? "New task").navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(FD.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !task.isDraft {
                    Button { model.taskOptionsID = task.id } label: { Image(systemName: "ellipsis").frame(width: 28, height: 28) }
                        .accessibilityLabel("Task options").accessibilityIdentifier("task-menu")
                }
            }
        }
        .onChange(of: chat.transcriptExpansion) { _, _ in scroll.followLatest = false }
        .sheet(isPresented: $showGoal) { GoalView(taskID: task.id) }
        // The editor outlives the queue row if that message dispatches meanwhile.
        .sheet(item: $chat.queuedEdit) { QueuedMessageEditor(task: task, edit: $0) }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .task(id: ConversationReadState(taskID: task.id, activitySeq: task.activitySeq, historyReady: chat.loaded && !chat.loading && chat.historyError == nil, foreground: model.foreground, visible: visible)) {
            guard visible, chat.loaded, !chat.loading, chat.historyError == nil, model.foreground else { return }
            do { try await Task.sleep(for: .milliseconds(600)) } catch { return }
            await model.markRead(task, automatic: true)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                contextTray.padding(.bottom, contextHeight > 0 ? 8 : 0)
                if task.archived {
                    Button("Restore task to continue", systemImage: "arrow.uturn.backward") {
                        Task { do { try await model.unarchive(task) } catch { chat.error = error.localizedDescription } }
                    }.buttonStyle(.glassProminent).disabled(!model.demo && !model.connected)
                } else { ComposerView(task: task, project: project, chat: chat) }
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 8).frame(maxWidth: 844).frame(maxWidth: .infinity)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { bottomInsetHeight = $0 }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
    }
    private var contextTray: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                ConversationStatus(task: task)
                ComposerSuggestionsView(task: task)
                if task.interrupted {
                    HStack {
                        Text("FalconDeck closed during this turn.").font(.footnote)
                        Spacer()
                        Button("Continue") { Task { await model.resumeInterrupted(task) } }.disabled(chat.sending || (!model.demo && !model.connected))
                        Button { Task { await model.updateTask(task, fields: ["acknowledge_interruption": .bool(true)]) } } label: { Image(systemName: "xmark") }.accessibilityLabel("Dismiss interrupted turn")
                    }.padding(12).background(FD.surface, in: .rect(cornerRadius: 12))
                }
                if task.raw["handoff_from"]["context_pending"].bool { Text("The previous conversation is sent with your first message.").font(.footnote).foregroundStyle(FD.secondary) }
                if task.goal != .null {
                    Button { showGoal = true } label: { Label("Goal · \(task.goal["status"].string.capitalized)", systemImage: "target").font(.caption) }.buttonStyle(.glass)
                }
                if !task.queued.isEmpty || !chat.pendingQueue.isEmpty { QueuedMessagesView(task: task) }
                ForEach(requests, id: \.self) { request in InteractiveCard(request: request) }
                if let error = chat.error ?? (!chat.transcript.items.isEmpty ? chat.historyError : nil) ?? chat.olderHistoryError ?? model.error {
                    HStack(alignment: .top) {
                        Image(systemName: "exclamationmark.circle")
                        Text(error).frame(maxWidth: .infinity, alignment: .leading)
                        Button { chat.error = nil; chat.historyError = nil; chat.olderHistoryError = nil; model.error = nil } label: { Image(systemName: "xmark") }.accessibilityLabel("Dismiss error")
                    }.font(.footnote).foregroundStyle(.orange).padding(12).background(FD.surface, in: .rect(cornerRadius: 12))
                }
                if let notice = chat.notice { Text(notice).font(.footnote).foregroundStyle(FD.secondary).onTapGesture { chat.notice = nil } }
            }.frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contextHeight = $0 }
        }.defaultScrollAnchor(.bottom)
            .accessibilityIdentifier("conversation-context").frame(height: min(contextHeight, max(0, min(200, min(viewportHeight * 0.28, viewportHeight - 180)))))
    }
    private func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool) {
        Task { @MainActor in
            await Task.yield()
            guard scroll.followLatest || chat.sending else { return }
            withAnimation(animated && !reduceMotion ? .easeOut(duration: 0.15) : nil) { proxy.scrollTo("latest", anchor: .bottom) }
        }
    }
}

private struct ConversationReadState: Hashable {
    let taskID: String
    let activitySeq: Int
    let historyReady: Bool
    let foreground: Bool
    let visible: Bool
}

struct DraftConversationView: View {
    @Environment(AppModel.self) private var model
    let projectID: String
    let folderID: String?
    var body: some View {
        if let project = model.projects.first(where: { $0.id == projectID }) {
            ConversationView(task: model.draftTask(project: project, folderID: folderID))
                .navigationTitle(project.raw["kind"].string == "casual" ? "New chat" : project.name)
        } else { ContentUnavailableView("Select a project", systemImage: "folder") }
    }
}

// Geometry updates should invalidate the shortcut, not rebuild rich transcript rows.
@MainActor @Observable private final class TranscriptScrollState {
    var followLatest = true
    var nearLatest = true
    var userScrolling = false
}

private struct LatestMessageShortcut: View {
    let state: TranscriptScrollState
    let hasMessages: Bool
    let jump: () -> Void
    var body: some View {
        if !state.followLatest && !state.nearLatest && hasMessages {
            Button(action: jump) { Image(systemName: "arrow.down").padding(12) }
                .glassEffect().padding(16).accessibilityLabel("Jump to latest message")
        }
    }
}
