import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main struct FalconSpeechWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NativeSpeechAttributes.self) { context in
            SpeechActivityBanner(context: context).padding(16).activityBackgroundTint(Color(red: 0.08, green: 0.08, blue: 0.1)).activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "falcondeck-native://speech"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: symbol(context.state.phase)).foregroundStyle(.green).padding(.top, 8) }
                DynamicIslandExpandedRegion(.center) { VStack { Text("FalconDeck").font(.headline); Text(label(context.state.phase)).font(.caption).foregroundStyle(.secondary) } }
                DynamicIslandExpandedRegion(.trailing) { SpeechActivityTimer(context: context) }
                DynamicIslandExpandedRegion(.bottom) { SpeechActivityButtons(phase: context.state.phase).padding(.top, 8) }
            } compactLeading: { Image(systemName: symbol(context.state.phase)).foregroundStyle(.green) }
            compactTrailing: { SpeechActivityTimer(context: context).frame(maxWidth: 52) }
            minimal: { Image(systemName: symbol(context.state.phase)).foregroundStyle(.green) }
            .widgetURL(URL(string: "falcondeck-native://speech"))
        }
    }
}

private func symbol(_ phase: String) -> String { phase == "listening" ? "mic.fill" : phase == "paused" ? "pause.fill" : "waveform" }
private func label(_ phase: String) -> String { ["listening": "Listening…", "transcribing": "Transcribing…", "playing": "Reading response…", "paused": "Read Aloud paused"][phase] ?? "Preparing speech…" }

private struct SpeechActivityBanner: View {
    let context: ActivityViewContext<NativeSpeechAttributes>
    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: symbol(context.state.phase)).font(.title2).foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 3) { Text("FalconDeck").font(.headline); Text(label(context.state.phase)).font(.subheadline).foregroundStyle(.secondary) }
                Spacer(); SpeechActivityTimer(context: context)
            }
            SpeechActivityButtons(phase: context.state.phase)
        }.foregroundStyle(.white)
    }
}

private struct SpeechActivityTimer: View {
    let context: ActivityViewContext<NativeSpeechAttributes>
    var body: some View {
        if context.state.phase == "transcribing" { Image(systemName: "waveform.badge.magnifyingglass") }
        else if let paused = context.state.pausedAt { Text(Duration.seconds(max(0, paused.timeIntervalSince(context.state.startedAt))).formatted(.time(pattern: .minuteSecond))).monospacedDigit().font(.caption) }
        else { Text(context.state.startedAt, style: .timer).monospacedDigit().font(.caption) }
    }
}

private struct SpeechActivityButtons: View {
    let phase: String
    var body: some View {
        if phase == "listening" {
            HStack {
                Button(intent: NativeSpeechIntent(.finish)) { Label("Finish", systemImage: "stop.fill").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).tint(.green)
                Button(intent: NativeSpeechIntent(.cancel)) { Label("Cancel", systemImage: "xmark").frame(maxWidth: .infinity) }.buttonStyle(.bordered)
            }
        } else if phase == "playing" || phase == "paused" {
            HStack {
                Button(intent: NativeSpeechIntent(.toggle)) { Label(phase == "paused" ? "Resume" : "Pause", systemImage: phase == "paused" ? "play.fill" : "pause.fill").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).tint(.green)
                Button(intent: NativeSpeechIntent(.stop)) { Label("Stop", systemImage: "xmark").frame(maxWidth: .infinity) }.buttonStyle(.bordered)
            }
        }
    }
}
