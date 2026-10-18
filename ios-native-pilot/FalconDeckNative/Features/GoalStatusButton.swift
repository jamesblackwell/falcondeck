import SwiftUI
import SpriteKit

struct GoalCompletionObservation: Equatable {
    let taskID: String
    let objective: String
    let status: String
    let live: Bool

    func completed(after previous: Self) -> Bool {
        live && previous.live && taskID == previous.taskID && objective == previous.objective &&
            previous.status == "active" && status == "complete"
    }
}

struct GoalStatusButton: View {
    @Environment(AppModel.self) private var model
    @Environment(\.nativeMotion) private var motion
    let task: AgentTask
    let action: () -> Void
    @State private var visible = false
    @State private var burst: UUID?
    private var observation: GoalCompletionObservation {
        GoalCompletionObservation(taskID: task.id, objective: task.goal["objective"].string,
            status: task.goal["status"].string, live: (model.demo || model.hasLiveSnapshot) && motion.active)
    }
    var body: some View {
        Button(action: action) {
            Label("Goal · \(task.goal["status"].string.capitalized)", systemImage: "target").font(.caption)
        }.buttonStyle(.glass).accessibilityIdentifier("goal-status-button")
            .overlay(alignment: .leading) {
                if burst != nil && motion.effectsEnabled {
                    GoalCompletionParticles(color: FD.accent).id(burst)
                        .frame(width: 120, height: 44).allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .onAppear { visible = true }
            .onDisappear { visible = false; burst = nil }
            .onScrollVisibilityChange(threshold: 0.01) { visible = $0; if !$0 { burst = nil } }
            .onChange(of: observation) { previous, next in
                // Cached completions, navigation and background sync do not celebrate.
                if visible && motion.effectsEnabled && next.completed(after: previous) { burst = UUID() }
            }
            .onChange(of: motion.effectsEnabled) { _, enabled in if !enabled { burst = nil } }
            .task(id: burst) {
                guard let current = burst else { return }
                do { try await Task.sleep(for: .milliseconds(900)) } catch { return }
                if burst == current { burst = nil }
            }
    }
}

/// A finite, local effect. The scene exists for less than a second per completion.
struct GoalCompletionParticles: View {
    let color: Color
    @State private var scene: SKScene?
    var body: some View {
        ZStack {
            Color.clear
            if let scene {
                SpriteView(scene: scene, preferredFramesPerSecond: 30, options: [.allowsTransparency, .shouldCullNonVisibleNodes])
            }
        }.task {
            guard scene == nil else { return }
            let scene = SKScene(size: CGSize(width: 120, height: 44))
            scene.backgroundColor = .clear; scene.scaleMode = .resizeFill
            let emitter = SKEmitterNode()
            let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
                UIColor.white.setFill(); context.cgContext.fillEllipse(in: CGRect(x: 0, y: 0, width: 4, height: 4))
            }
            emitter.particleTexture = SKTexture(image: image)
            emitter.particleColor = UIColor(color); emitter.particleColorBlendFactor = 1
            emitter.particleBirthRate = 40; emitter.numParticlesToEmit = 10
            emitter.particleLifetime = 0.45; emitter.particleLifetimeRange = 0.1
            emitter.particleSpeed = 25; emitter.particleSpeedRange = 12
            emitter.emissionAngle = .pi / 2; emitter.emissionAngleRange = .pi * 2
            emitter.particleAlpha = 0.8; emitter.particleAlphaSpeed = -1.6
            emitter.particleScale = 0.65; emitter.particleScaleSpeed = -0.3
            emitter.position = CGPoint(x: 18, y: 22)
            scene.addChild(emitter); self.scene = scene
        }
    }
}
