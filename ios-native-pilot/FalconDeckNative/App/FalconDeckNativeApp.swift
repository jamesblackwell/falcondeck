import SwiftUI

@main
struct FalconDeckNativeApp: App {
    @State private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(FD.accent)
                .task { await model.start() }
                .onOpenURL { url in
                    model.pairingText = url.absoluteString
                    model.showConnection = true
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab = 0
    var body: some View {
        @Bindable var model = model
        TabView(selection: $tab) {
            Tab("Projects", systemImage: "square.grid.2x2", value: 0) {
                NavigationStack { ProjectsView() }
            }
            Tab("Activity", systemImage: "waveform.path", value: 1) {
                NavigationStack { ActivityView() }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .sensoryFeedback(.selection, trigger: tab)
        .sheet(isPresented: $model.showConnection) { ConnectionView() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && model.hasSession && !model.demo { Task { await model.reconnect() } }
        }
    }
}
