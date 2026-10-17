import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    @State private var messages: [Message] = []
    @State private var loading = true
    @State private var error: String?
    @State private var hasOlder = false
    @State private var otherItems = 0
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 12) {
                    StatusBadge(task: model.tasks.first { $0.id == task.id } ?? task)
                    Text(task.title).font(.title2.weight(.semibold)).textSelection(.enabled)
                    Text("\(task.provider.capitalized) · \(model.demo ? "Sample conversation" : "Latest conversation")")
                        .font(.subheadline).foregroundStyle(FD.secondary)
                }.padding(.bottom, 8)
                if loading { HStack { Spacer(); ActivityDiamond(); Spacer() }.padding(40) }
                if let error {
                    ContentUnavailableView {
                        Label("Couldn’t load this task", systemImage: "wifi.exclamationmark")
                    } description: { Text(error) } actions: {
                        Button("Try again") { Task { await load() } }.buttonStyle(.glass)
                    }
                }
                if hasOlder || otherItems > 0 {
                    Label("Showing recent messages. Earlier history and tool activity are omitted in this pilot.", systemImage: "clock")
                        .font(.footnote).foregroundStyle(FD.secondary)
                }
                ForEach(messages) { message in
                    MessageCard(message: message)
                }
                if !loading && error == nil && messages.isEmpty {
                    ContentUnavailableView("No messages yet", systemImage: "text.bubble", description: Text("This task has no user or assistant messages in its latest page."))
                }
            }
            .padding(FD.inset).padding(.bottom, 32).frame(maxWidth: 720).frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
        .defaultScrollAnchor(.top, for: .alignment)
        .background(FD.background)
        .navigationTitle("Task").navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { ConnectionPill() } }
        .safeAreaInset(edge: .bottom) {
            Label(model.demo ? "Demo conversation · Read-only pilot" : "Read-only pilot · Pull to refresh", systemImage: "eye")
                .font(.footnote).foregroundStyle(FD.secondary)
                .padding(14).frame(maxWidth: .infinity).glassEffect(in: .rect(cornerRadius: 22))
                .padding(.horizontal, 20).padding(.bottom, 8)
        }
        .task(id: task.id) { await load() }
        .refreshable { await load() }
    }
    private func load() async {
        loading = messages.isEmpty; error = nil
        defer { loading = false }
        if model.demo { messages = Demo.messages; return }
        do {
            let detail = try await model.relay.detail(task: task)
            guard !Task.isCancelled else { return }
            let all = detail["items"].array.map(Message.init)
            messages = all.filter(\.isMessage)
            otherItems = all.count - messages.count; hasOlder = detail["has_older"].bool || detail["is_partial"].bool
        } catch { self.error = error.localizedDescription }
    }
}

struct MessageCard: View {
    let message: Message
    private var isUser: Bool { message.kind == "user_message" }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: isUser ? "person.crop.circle" : "sparkle")
                Text(isUser ? "You" : "Assistant").fontWeight(.semibold)
            }.font(.caption).foregroundStyle(isUser ? FD.secondary : FD.accent)
            Text(LocalizedStringKey(message.text))
                .font(.body).lineSpacing(5).foregroundStyle(FD.foreground)
                .textSelection(.enabled).tint(FD.accent)
        }
        .padding(isUser ? 18 : 4).frame(maxWidth: .infinity, alignment: .leading)
        .background(isUser ? FD.raised : .clear, in: .rect(cornerRadius: FD.radius))
        .contextMenu {
            ShareLink(item: message.text) { Label("Share message", systemImage: "square.and.arrow.up") }
        }
    }
}
