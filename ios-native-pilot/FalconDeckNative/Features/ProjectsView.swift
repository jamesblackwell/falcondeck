import SwiftUI

struct ProjectsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var zoom
    @State private var search = ""
    @State private var appeared = false
    private var filtered: [Project] {
        model.sortedProjects.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if model.projects.isEmpty {
                    if model.hasSession && !model.demo { connectionState }
                    else { welcome }
                }
                else {
                    overview
                    if let error = model.error, !model.demo {
                        Label(error, systemImage: "wifi.exclamationmark")
                            .font(.subheadline).foregroundStyle(.orange)
                    }
                    HStack {
                        Text("YOUR WORKSPACES").font(.caption.weight(.semibold)).tracking(1.5)
                        Spacer()
                        Text("\(filtered.count)").font(.caption.monospacedDigit())
                    }.foregroundStyle(FD.muted)
                    LazyVStack(spacing: 12) {
                        ForEach(Array(filtered.enumerated()), id: \.element.id) { index, project in
                            NavigationLink(value: project) {
                                ProjectCard(project: project, tasks: model.tasks(in: project))
                                    .matchedTransitionSource(id: project.id, in: zoom)
                            }
                            .buttonStyle(.plain)
                            .offset(y: appeared || reduceMotion ? 0 : 20)
                            .opacity(appeared || reduceMotion ? 1 : 0)
                            .animation(reduceMotion ? nil : .spring(duration: 0.55).delay(Double(min(index, 6)) * 0.045), value: appeared)
                            .contextMenu {
                                ShareLink(item: project.path) { Label("Share project path", systemImage: "square.and.arrow.up") }
                            }
                        }
                    }
                    if filtered.isEmpty {
                        ContentUnavailableView.search(text: search)
                    }
                    if model.demo {
                        Text("Sample projects · Connect to see your own work")
                            .font(.footnote).foregroundStyle(FD.secondary).frame(maxWidth: .infinity)
                    }
                }
            }
            .padding(FD.inset).padding(.bottom, 24)
            .frame(maxWidth: 720).frame(maxWidth: .infinity)
        }
        .background(FD.background)
        .navigationTitle("Projects")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { ConnectionPill() }
        }
        .searchable(text: $search, prompt: "Find a project")
        .refreshable { await model.refresh() }
        .navigationDestination(for: Project.self) { project in
            ProjectDetailView(project: project).navigationTransition(.zoom(sourceID: project.id, in: zoom))
        }
        .onAppear { appeared = true }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 6) {
                Image(systemName: model.demo ? "sparkle" : "lock.shield")
                Text(model.demo ? "A LITTLE PREVIEW" : "YOUR COMPUTER, WITH YOU")
                    .tracking(1.2)
            }.font(.caption.weight(.medium)).foregroundStyle(FD.accent)
            Text("Your agents, in focus.")
                .font(.title2.weight(.semibold)).tracking(-0.4).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 24) {
                metric("\(model.projects.count)", "projects")
                metric("\(model.tasks.filter(\.running).count)", "working", accent: true)
                metric("\(model.tasks.filter(\.needsAttention).count)", "need you")
            }
        }.padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func metric(_ value: String, _ label: String, accent: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value).font(.title2.weight(.semibold).monospacedDigit())
                .foregroundStyle(accent ? FD.accent : FD.foreground).contentTransition(.numericText())
            Text(label).font(.caption).foregroundStyle(FD.secondary)
        }.accessibilityElement(children: .combine)
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 28) {
            Image("FalconMark").resizable().scaledToFit().frame(width: 56, height: 56)
                .foregroundStyle(FD.accent)
                .padding(28).background(FD.surface, in: .rect(cornerRadius: 32))
            VStack(alignment: .leading, spacing: 14) {
                Text("Your work.\nWithin reach.").font(.largeTitle.weight(.semibold)).tracking(-0.8)
                Text("A small, native window into your projects and the agents working on them.")
                    .font(.body).foregroundStyle(FD.secondary)
            }
            VStack(spacing: 12) {
                Button { model.showConnection = true } label: {
                    Label("Connect your computer", systemImage: "laptopcomputer")
                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                }.buttonStyle(.glassProminent).tint(FD.accent).foregroundStyle(FD.background)
                Button("Explore the demo") { Task { await model.useDemo() } }
                    .buttonStyle(.glass).frame(maxWidth: .infinity).accessibilityIdentifier("explore-demo")
            }
            Label("Private by design. End-to-end encrypted.", systemImage: "lock.shield")
                .font(.footnote).foregroundStyle(FD.secondary)
            if let error = model.error { Text(error).font(.footnote).foregroundStyle(.orange) }
        }.padding(.top, 32)
    }

    private var connectionState: some View {
        VStack(spacing: 20) {
            if !model.connected && model.error == nil { ActivityDiamond().padding(16) }
            else { Image(systemName: model.connected ? "folder" : "wifi.exclamationmark").font(.largeTitle).foregroundStyle(FD.accent) }
            Text(model.connected ? "No projects yet" : model.status).font(.title2.weight(.semibold))
            Text(model.error ?? (model.connected ? "Open a project on your computer and pull to refresh." : "Restoring your encrypted connection to your computer."))
                .font(.subheadline).foregroundStyle(FD.secondary).multilineTextAlignment(.center)
            if model.error != nil {
                Button("Reconnect") { Task { await model.reconnect() } }.buttonStyle(.glass).disabled(model.busy)
            }
        }.frame(maxWidth: .infinity).padding(.vertical, 64)
    }
}

struct ProjectCard: View {
    let project: Project
    let tasks: [AgentTask]
    private var working: Int { tasks.filter(\.running).count }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top) {
                ProjectIcon(name: project.name)
                    .font(.title2).foregroundStyle(FD.accent)
                    .frame(width: 48, height: 48)
                    .background(FD.accent.opacity(0.09), in: .rect(cornerRadius: 14))
                Spacer()
                if working > 0 {
                    HStack(spacing: 6) { ActivityDiamond(); Text("\(working) working") }
                        .font(.caption.weight(.medium)).foregroundStyle(FD.accent)
                } else { Image(systemName: "arrow.up.right").font(.subheadline).foregroundStyle(FD.muted) }
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(project.name).font(.title3.weight(.semibold)).foregroundStyle(FD.foreground)
                Text(project.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                    .font(.caption.monospaced()).foregroundStyle(FD.secondary).lineLimit(1).truncationMode(.middle)
            }
            HStack(spacing: 8) {
                Text("\(tasks.count) tasks").font(.subheadline).foregroundStyle(FD.secondary)
                Spacer()
                ForEach(Array(Set(tasks.map(\.provider))).sorted().prefix(3), id: \.self) { provider in
                    Text(provider.capitalized).font(.caption2.weight(.medium)).foregroundStyle(FD.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 5).background(FD.raised, in: Capsule())
                }
            }
        }
        .padding(20).background(FD.surface, in: .rect(cornerRadius: FD.radius))
        .overlay { RoundedRectangle(cornerRadius: FD.radius).strokeBorder(working > 0 ? FD.accent.opacity(0.25) : FD.line) }
        .accessibilityElement(children: .combine)
    }
}

struct ProjectDetailView: View {
    @Environment(AppModel.self) private var model
    let project: Project
    @State private var filter = "All"
    @State private var search = ""
    private var tasks: [AgentTask] {
        model.tasks(in: project).filter {
            (filter != "Working" || $0.running) && (filter != "Needs you" || $0.needsAttention) &&
            (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search))
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 12) {
                    ProjectIcon(name: project.name).font(.largeTitle).foregroundStyle(FD.accent)
                    Text(project.path).font(.caption.monospaced()).foregroundStyle(FD.secondary).textSelection(.enabled)
                    Text("\(model.tasks(in: project).count) tasks in this project").font(.subheadline).foregroundStyle(FD.secondary)
                }.padding(.vertical, 12)
                Picker("Task filter", selection: $filter) {
                    ForEach(["All", "Working", "Needs you"], id: \.self) { Text($0) }
                }.pickerStyle(.segmented)
                LazyVStack(spacing: 12) {
                    ForEach(tasks) { task in
                        NavigationLink { ConversationView(task: task) } label: { TaskRow(task: task) }
                            .buttonStyle(.plain)
                    }
                }
                if tasks.isEmpty {
                    ContentUnavailableView("No tasks here", systemImage: "tray", description: Text("Try another filter or refresh this project."))
                }
            }.padding(FD.inset).frame(maxWidth: 720).frame(maxWidth: .infinity)
        }
        .background(FD.background).navigationTitle(project.name).navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Find a task")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { ConnectionPill() } }
        .refreshable { await model.refresh() }
        .sensoryFeedback(.selection, trigger: filter)
    }
}
