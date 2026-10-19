import SwiftUI
import Observation

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    @State private var chat: ChatSession?
    @State private var sessionTaskID: String?
    private var current: AgentTask { model.task(task.id) ?? task }
    var body: some View {
        Group {
            if let session = (sessionTaskID == task.id ? chat : nil) ?? model.chats[task.id] { ChatContent(task: current, chat: session) }
            else { ActivityDiamond().frame(maxWidth: .infinity, maxHeight: .infinity).background(FD.background) }
        }
        .task(id: task.id) {
            let session = model.chat(for: task); chat = session; sessionTaskID = task.id
            if task.isDraft { session.loaded = true }
            else if (!session.loaded || session.needsRefresh) && (model.connected || model.demo) { await model.loadChat(task) }
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
    @State private var listScrolling = NativeListScrolling()
    @State private var readingAnchor: NativeListScrolling.ReadingAnchor?
    @State private var showGoal = false
    @State private var visible = false
    private var expansion: TranscriptExpansion? { chat.transcriptExpansion }
    @State private var contextHeight: CGFloat = 0
    @State private var viewportHeight: CGFloat = 600
    @State private var bottomInsetHeight: CGFloat = 0
    private var project: Project? { model.projects.first { $0.id == task.projectID } }
    private var requests: [JSON] { model.requests.filter { $0["thread_id"].string == task.id } }
    private var acceptedDeliveryID: String? {
        guard let outgoing = chat.outgoingMessage, outgoing.phase != .sending else { return nil }
        return outgoing.id
    }

    private var preferences: ConversationPreferences { ConversationPreferences(raw: model.preferences["conversation"]) }
    var body: some View {
        let presentation = chat.presentation(preferences: preferences, running: task.running)
        let actions = presentation.actionIDs
        let blocks = presentation.blocks
        let submitting = chat.sending && chat.outgoingMessage?.phase != .accepted && chat.outgoingMessage?.phase != .queued
        let activity = submitting || (!chat.loading && chat.historyError == nil && (model.connected || model.demo)) ? ConversationActivity.label(blocks: blocks, running: task.running, submitting: submitting, accepted: chat.outgoingMessage?.awaitingAgent == true) : nil
        let rowOrder = (chat.hasOlder ? ["earlier"] : []) + blocks.map(\.id) + (activity == nil ? [] : ["activity"]) + ["latest"]
        Group {
            List {
                Group {
                    if chat.hasOlder {
                        Button {
                            scroll.followLatest = false
                            let anchor = listScrolling.readingAnchor()
                            Task { await model.loadChat(task, older: true); if let anchor { listScrolling.restore(anchor) } }
                        } label: { HStack { if chat.loading { ActivityDiamond() }; Text("Load earlier messages") }.frame(maxWidth: .infinity) }
                            .font(.footnote).foregroundStyle(FD.secondary).disabled(chat.loading)
                            .listRowBackground(NativeListScrollProbe(scrolling: listScrolling, rowOrder: rowOrder))
                    }
                    ForEach(blocks) { block in
                        Group {
                            if block.grouped { TranscriptGroup(block: block, task: task, expansion: expansion, onInteraction: stopFollowing).id(block.id) }
                            else if let item = block.items.first {
                                TranscriptRow(message: item, task: task, firstDiff: block.firstDiff, showsActions: actions.contains(item.id), expansion: expansion, onInteraction: stopFollowing)
                                    .modifier(OutgoingMessageArrival(delivery: chat.outgoingMessage.flatMap { $0.id == item.id ? $0 : nil })).id(item.id)
                            }
                        }.frame(maxWidth: 820).frame(maxWidth: .infinity)
                            .listRowBackground(NativeListScrollProbe(scrolling: listScrolling, rowID: block.id, rowOrder: rowOrder))
                    }
                    if let activity {
                        HStack(spacing: 8) { ActivityDiamond(); NativeActivityText(text: activity).font(.footnote).foregroundStyle(FD.secondary) }.frame(minHeight: 44).frame(maxWidth: 820, alignment: .leading).frame(maxWidth: .infinity)
                            .accessibilityElement(children: .combine).accessibilityIdentifier("conversation-delivery-status")
                            .listRowBackground(NativeListScrollProbe(scrolling: listScrolling, rowOrder: rowOrder))
                    }
                    Color.clear.frame(height: 1).id("latest").listRowBackground(NativeListScrollProbe(scrolling: listScrolling, rowOrder: rowOrder))
                }
                .listRowInsets(EdgeInsets(top: 6, leading: FD.inset, bottom: 6, trailing: FD.inset))
                .listRowSeparator(.hidden)
                .buttonStyle(.plain)
            }
            .listStyle(.plain).scrollContentBackground(.hidden)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .environment(\.defaultMinListRowHeight, 0)
            .contentMargins(.vertical, 10, for: .scrollContent)
            // History and token updates have no insertion animation. User
            // disclosure/press animations keep their own unchanged transaction.
            .transaction(value: chat.transcript.revision) { transaction in
                transaction.animation = nil; transaction.disablesAnimations = true
            }
            // Loaded messages stay visible and interactive even if UIKit has
            // not realized the final row or delivered a layout callback yet.
            .accessibilityIdentifier("conversation-transcript")
            .onScrollGeometryChange(for: TranscriptGeometry.self) { g in
                TranscriptGeometry(nearLatest: g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 120, contentHeight: g.contentSize.height)
            } action: { previous, value in
                // Content growth and keyboard dismissal also change geometry.
                // Only an actual reading gesture should turn following off.
                scroll.nearLatest = value.nearLatest
                if scroll.userScrolling { scroll.followLatest = value.nearLatest }
                if previous.contentHeight != value.contentHeight, scroll.followLatest, !scroll.userScrolling { scrollToLatest(animated: false) }
            }
            .onChange(of: viewportHeight) { _, _ in
                // Observe the outer layout, which cannot change as lazy rows are
                // measured. Keyboard and composer resizing must still follow.
                if scroll.followLatest && !scroll.userScrolling { scrollToLatest(animated: false) }
            }
            .onChange(of: bottomInsetHeight) { _, _ in
                if scroll.followLatest && !scroll.userScrolling { scrollToLatest(animated: false) }
            }
            .onScrollPhaseChange { previous, phase in
                scroll.userScrolling = phase == .tracking || phase == .interacting || phase == .decelerating
                // A drag expresses reading intent even if the near-end value did
                // not cross its threshold during that gesture.
                if phase == .interacting { scroll.followLatest = false; readingAnchor = nil; listScrolling.cancel() }
                else if phase == .idle && (previous == .interacting || previous == .decelerating) {
                    scroll.followLatest = scroll.nearLatest
                    if !scroll.followLatest { readingAnchor = listScrolling.readingAnchor() }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { if !task.isDraft { await model.loadChat(task) } }
            .onChange(of: chat.loading) { _, loading in
                guard !scroll.followLatest, !scroll.userScrolling else { return }
                if loading { readingAnchor = listScrolling.readingAnchor() }
                else if let anchor = readingAnchor { listScrolling.restore(anchor); readingAnchor = nil }
            }
            .onChange(of: chat.transcript.revision) { _, _ in
                // Token delivery must not restart a UIKit scrolling animation.
                // Geometry updates follow the growing row without animation too.
                if scroll.followLatest || chat.sending { scrollToLatest(animated: false) }
            }
            .onChange(of: chat.loaded, initial: true) { _, loaded in if loaded { scrollToLatest(animated: false) } }
            .onChange(of: chat.sending) { _, sending in if sending { jumpToLatest() } }
            // Pane states stay outside the bottom-anchored list so they cannot
            // scroll off screen, including during keyboard/composer resizing.
            .overlay {
                if blocks.isEmpty && activity == nil {
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
            .overlay(alignment: .top) {
                NativeLoadingPill(loading: chat.loading && !blocks.isEmpty, label: "Updating conversation…")
            }
            .overlay(alignment: .bottomTrailing) {
                LatestMessageShortcut(state: scroll, hasMessages: !chat.transcript.items.isEmpty) {
                    jumpToLatest()
                }
            }
        }
        .background(FD.background).navigationTitle(task.title.nonempty ?? "New task").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !task.isDraft {
                    Button { model.taskOptionsID = task.id } label: { Image(systemName: "ellipsis").frame(width: 28, height: 28) }
                        .accessibilityLabel("Task options").accessibilityIdentifier("task-menu")
                }
            }
        }
        .onChange(of: chat.transcriptExpansion) { _, _ in scroll.followLatest = false; listScrolling.cancel() }
        .sensoryFeedback(.impact(weight: .light, intensity: 0.45), trigger: acceptedDeliveryID) { old, next in
            next != nil && old != next && !reduceMotion && model.foreground
        }
        .sheet(isPresented: $showGoal) { GoalView(taskID: task.id) }
        // The editor outlives the queue row if that message dispatches meanwhile.
        .sheet(item: $chat.queuedEdit) { QueuedMessageEditor(task: task, edit: $0) }
        .onAppear { visible = true; listScrolling.setActive(true); if chat.loaded { scrollToLatest(animated: false) } }
        .onDisappear { visible = false; listScrolling.setActive(false) }
        .task(id: ConversationReadState(taskID: task.id, activitySeq: task.activitySeq, historyReady: chat.loaded && !chat.needsRefresh && !chat.loading && chat.historyError == nil, foreground: model.foreground, visible: visible)) {
            guard visible, chat.loaded, !chat.needsRefresh, !chat.loading, chat.historyError == nil, model.foreground else { return }
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
                    GoalStatusButton(task: task) { showGoal = true }
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
    private func scrollToLatest(animated: Bool) {
        guard visible, !scroll.userScrolling, scroll.followLatest || chat.sending else { return }
        listScrolling.bottom(animated: animated && !reduceMotion)
    }
    private func jumpToLatest() {
        guard visible else { return }
        scroll.userScrolling = false; scroll.followLatest = true
        listScrolling.jump(animated: !reduceMotion)
    }
    private func stopFollowing() { scroll.followLatest = false; readingAnchor = listScrolling.readingAnchor() }
}

private struct TranscriptGeometry: Equatable {
    let nearLatest: Bool
    let contentHeight: CGFloat
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
                .buttonStyle(NativePressStyle(feedback: .selection))
                .glassEffect().padding(16).accessibilityLabel("Jump to latest message")
        }
    }
}
