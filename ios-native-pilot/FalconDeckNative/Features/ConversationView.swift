import SwiftUI

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
            await model.markRead(current, automatic: true)
        }
        .onChange(of: model.connected) { _, connected in if connected && !task.isDraft { Task { await model.loadChat(current) } } }
    }
}

private struct ChatContent: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let task: AgentTask
    @Bindable var chat: ChatSession
    @State private var followLatest = true
    @State private var userScrolling = false
    @State private var showGoal = false
    @State private var expansion: TranscriptExpansion?
    private var project: Project? { model.projects.first { $0.id == task.projectID } }
    private var requests: [JSON] { model.requests.filter { $0["thread_id"].string == task.id } }

    private var preferences: ConversationPreferences { ConversationPreferences(raw: model.preferences["conversation"]) }
    private var blocks: [TranscriptBlock] { TranscriptBlock.build(chat.transcript.items, preferences: preferences, running: task.running) }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if chat.hasOlder {
                        Button {
                            let anchor = chat.transcript.items.first?.id
                            Task { await model.loadChat(task, older: true); if let anchor { proxy.scrollTo(anchor, anchor: .top) } }
                        } label: { HStack { if chat.loading { ActivityDiamond() }; Text("Load earlier messages") }.frame(maxWidth: .infinity) }
                            .font(.footnote).foregroundStyle(FD.secondary).disabled(chat.loading)
                    }
                    if chat.loading && chat.transcript.items.isEmpty { ActivityDiamond().frame(maxWidth: .infinity).padding(.vertical, 64) }
                    if chat.loaded && chat.transcript.items.isEmpty {
                        ContentUnavailableView("What are we working on?", systemImage: "sparkle", description: Text("Send a message to \(task.provider.capitalized) to get started."))
                    }
                    ForEach(blocks) { block in
                        if block.grouped { TranscriptGroup(block: block, task: task, expansion: expansion).id(block.id) }
                        else if let item = block.items.first { TranscriptRow(message: item, task: task, firstDiff: block.firstDiff, expansion: expansion).id(item.id) }
                    }
                    if task.running {
                        HStack(spacing: 8) { ActivityDiamond(); Text("\(task.provider.capitalized) is working…").font(.footnote).foregroundStyle(FD.secondary) }.padding(.vertical, 8)
                    }
                    Color.clear.frame(height: 1).id("latest")
                }
                .padding(.horizontal, FD.inset).padding(.vertical, 20).frame(maxWidth: 820).frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onScrollGeometryChange(for: Bool.self) { g in g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 120 } action: { _, value in
                // Content growth and keyboard dismissal also change geometry.
                // Only an actual reading gesture should turn following off.
                if userScrolling { followLatest = value }
            }
            .onScrollPhaseChange { _, phase in userScrolling = phase == .tracking || phase == .interacting || phase == .decelerating }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { if !task.isDraft { await model.loadChat(task) } }
            .onChange(of: chat.transcript.revision) { _, _ in
                if followLatest || chat.sending { scrollToLatest(proxy, animated: true) }
            }
            .onChange(of: chat.loaded) { _, loaded in if loaded { scrollToLatest(proxy, animated: false) } }
            .onChange(of: chat.sending) { _, sending in if sending { followLatest = true; scrollToLatest(proxy, animated: true) } }
            .overlay(alignment: .bottomTrailing) {
                if !followLatest && !chat.transcript.items.isEmpty {
                    Button { followLatest = true; scrollToLatest(proxy, animated: true) } label: { Image(systemName: "arrow.down").padding(12) }
                        .glassEffect().padding(16).accessibilityLabel("Jump to latest message")
                }
            }
        }
        .background(FD.background).navigationTitle(task.title.nonempty ?? "New task").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if preferences.flag("show_expand_all_controls"), !chat.transcript.items.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu { Button("Expand all activity") { expansion = TranscriptExpansion(expanded: true) }; Button("Collapse all activity") { expansion = TranscriptExpansion(expanded: false) } } label: { Image(systemName: "line.3.horizontal.decrease") }.accessibilityLabel("Transcript display")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if !task.isDraft {
                    Button { model.taskOptionsID = task.id } label: { Image(systemName: "ellipsis") }.accessibilityLabel("Task options")
                }
            }
        }
        .sheet(isPresented: $showGoal) { GoalView(taskID: task.id) }
        .task(id: task.activitySeq) {
            do { try await Task.sleep(for: .milliseconds(600)) } catch { return }
            await model.markRead(task, automatic: true)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 10) {
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
                if let error = chat.error ?? model.error {
                    HStack(alignment: .top) {
                        Image(systemName: "exclamationmark.circle")
                        Text(error).frame(maxWidth: .infinity, alignment: .leading)
                        Button { chat.error = nil; model.error = nil } label: { Image(systemName: "xmark") }.accessibilityLabel("Dismiss error")
                    }.font(.footnote).foregroundStyle(.orange).padding(12).background(FD.surface, in: .rect(cornerRadius: 12))
                }
                if let notice = chat.notice { Text(notice).font(.footnote).foregroundStyle(FD.secondary).onTapGesture { chat.notice = nil } }
                if task.archived {
                    Button("Restore task to continue", systemImage: "arrow.uturn.backward") {
                        Task { do { try await model.unarchive(task) } catch { chat.error = error.localizedDescription } }
                    }.buttonStyle(.glassProminent).disabled(!model.demo && !model.connected)
                } else { ComposerView(task: task, project: project, chat: chat) }
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 8).frame(maxWidth: 844).frame(maxWidth: .infinity)
        }
    }
    private func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool) {
        Task { @MainActor in
            await Task.yield()
            withAnimation(animated && !reduceMotion ? .easeOut(duration: 0.15) : nil) { proxy.scrollTo("latest", anchor: .bottom) }
        }
    }
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
