import XCTest
import SwiftUI
import SpriteKit
@testable import FalconDeckNative

@MainActor final class NativeMotionTests: XCTestCase {
    func testMotionPolicyStopsContinuousWorkWithoutDisablingOrdinaryLowPowerInteractions() {
        XCTAssertTrue(NativeMotionPolicy().effectsEnabled)
        XCTAssertFalse(NativeMotionPolicy(active: false).effectsEnabled)
        XCTAssertFalse(NativeMotionPolicy(reduceMotion: true).effectsEnabled)
        XCTAssertFalse(NativeMotionPolicy(lowPower: true).effectsEnabled)
        XCTAssertNil(NativeMotionPolicy(active: false).interactionAnimation)
        XCTAssertNil(NativeMotionPolicy(reduceMotion: true).interactionAnimation)
        XCTAssertNotNil(NativeMotionPolicy(lowPower: true).interactionAnimation)
    }
    func testWaveformInterpolatesActualSamplesAndSettlesExactly() {
        let now = Date(timeIntervalSinceReferenceDate: 10)
        var transition = WaveformTransition()
        transition.update([0, 1], at: now)
        transition.update([1, 0], at: now.addingTimeInterval(1))
        let halfway = transition.samples(count: 2, at: now.addingTimeInterval(1.05))
        XCTAssertEqual(halfway[0], 0.5, accuracy: 0.001)
        XCTAssertEqual(halfway[1], 0.5, accuracy: 0.001)
        XCTAssertEqual(transition.samples(count: 2, at: now), [0, 1])
        XCTAssertEqual(transition.samples(count: 2, at: now.addingTimeInterval(2)), [1, 0])
        XCTAssertEqual(transition.samples(count: 2, at: now, animated: false), [1, 0])
    }
    func testNewAudioDuringInterpolationStartsAtTheVisibleLevel() {
        let now = Date(timeIntervalSinceReferenceDate: 10)
        var transition = WaveformTransition()
        transition.update([0], at: now)
        transition.update([1], at: now.addingTimeInterval(1))
        transition.update([0], at: now.addingTimeInterval(1.05))
        XCTAssertEqual(transition.samples(count: 1, at: now.addingTimeInterval(1.05))[0], 0.5, accuracy: 0.001)
    }
    func testWaveformBoundsUntrustedValuesAndRetainsOnlyItsTail() {
        var transition = WaveformTransition()
        let now = Date()
        transition.update(Array(repeating: 0.5, count: 200) + [-1, .infinity, .nan, 2], at: now)
        XCTAssertEqual(transition.current.count, 120)
        XCTAssertEqual(transition.samples(count: 4, at: now, animated: false), [0, 0, 0, 1])
        XCTAssertEqual(transition.samples(count: -10, at: now), [])
        XCTAssertEqual(transition.samples(count: 10000, at: now).count, 120)
        transition.update([], at: now)
        XCTAssertTrue(transition.samples(count: 10, at: now).isEmpty)
    }
    func testEachAudioSnapshotSchedulesOnlyThreeFramesAndThenStops() {
        let now = Date(timeIntervalSinceReferenceDate: 10)
        var transition = WaveformTransition()
        transition.update([0.5], at: now)
        XCTAssertEqual(transition.frameDates.count, 3)
        XCTAssertTrue(transition.frameDates.allSatisfy { $0 > now })
        XCTAssertEqual(transition.frameDates.last!.timeIntervalSince(now), WaveformTransition.interval, accuracy: 0.0001)
    }
    func testGoalEffectRequiresTheSameLiveGoalToActuallyFinish() {
        func observation(_ status: String, task: String = "a", objective: String = "Ship", live: Bool = true) -> GoalCompletionObservation {
            GoalCompletionObservation(taskID: task, objective: objective, status: status, live: live)
        }
        let complete = observation("complete")
        XCTAssertTrue(complete.completed(after: observation("active")))
        XCTAssertFalse(complete.completed(after: complete))
        XCTAssertFalse(complete.completed(after: observation("active", live: false)))
        XCTAssertFalse(observation("complete", live: false).completed(after: observation("active")))
        XCTAssertFalse(complete.completed(after: observation("active", task: "b")))
        XCTAssertFalse(complete.completed(after: observation("active", objective: "Another goal")))
        XCTAssertFalse(complete.completed(after: observation("paused")))
        XCTAssertFalse(observation("active").completed(after: complete))
    }
    func testCompletionEffectActuallyCreatesItsFiniteParticleScene() async throws {
        let windowScene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: windowScene)
        window.frame = CGRect(x: 0, y: 0, width: 240, height: 120)
        window.rootViewController = UIHostingController(rootView: GoalCompletionParticles(color: .green))
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        func spriteView(in view: UIView) -> SKView? {
            if let view = view as? SKView { return view }
            return view.subviews.lazy.compactMap { spriteView(in: $0) }.first
        }
        for _ in 0..<150 {
            if spriteView(in: window)?.scene != nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let scene = spriteView(in: window)?.scene
        XCTAssertNotNil(scene, "The effect must bootstrap from its initially empty state")
        XCTAssertEqual((scene?.children.first as? SKEmitterNode)?.numParticlesToEmit, 10)
    }
}
