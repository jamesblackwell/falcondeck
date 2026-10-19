import ActivityKit
import SwiftUI
import WidgetKit

struct FalconTaskWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NativeTaskAttributes.self) { context in
            TaskActivityBanner(state: context.state, stale: context.isStale)
                .padding(16).activityBackgroundTint(.black).activitySystemActionForegroundColor(.white)
                .widgetURL(context.attributes.url)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { TaskActivitySymbol(state: context.state, stale: context.isStale).padding(.top, 6) }
                DynamicIslandExpandedRegion(.trailing) { TaskActivityElapsed(state: context.state, stale: context.isStale) }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.project).font(.caption.weight(.medium)).foregroundStyle(.secondary).lineLimit(1).privacySensitive()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(context.state.title).font(.headline).lineLimit(2).privacySensitive()
                        TaskActivityStatus(state: context.state, stale: context.isStale)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
                }
            } compactLeading: {
                TaskActivitySymbol(state: context.state, stale: context.isStale)
            } compactTrailing: {
                TaskActivityElapsed(state: context.state, stale: context.isStale).frame(maxWidth: 52)
            } minimal: {
                TaskActivitySymbol(state: context.state, stale: context.isStale)
            }
            .widgetURL(context.attributes.url)
            .keylineTint(context.state.phase == .needsInput || context.state.phase == .failed ? .orange : .mint)
        }
    }
}

private struct TaskActivityBanner: View {
    let state: NativeTaskAttributes.ContentState
    let stale: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            TaskActivitySymbol(state: state, stale: stale).font(.title3).frame(width: 24).padding(.top, 2)
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(state.project).font(.caption.weight(.medium)).foregroundStyle(.secondary).lineLimit(1).privacySensitive()
                    Spacer(minLength: 8)
                    TaskActivityElapsed(state: state, stale: stale)
                }
                Text(state.title).font(.headline).lineLimit(2).privacySensitive()
                TaskActivityStatus(state: state, stale: stale)
            }
        }.foregroundStyle(.white).accessibilityElement(children: .combine)
    }
}

private struct TaskActivitySymbol: View {
    let state: NativeTaskAttributes.ContentState
    let stale: Bool
    var body: some View {
        Image(systemName: stale || !state.connected ? "clock" : state.phase.symbol)
            .foregroundStyle(stale || !state.connected ? Color.secondary : state.phase == .needsInput || state.phase == .failed ? .orange : .mint)
            .accessibilityHidden(true)
    }
}

private struct TaskActivityStatus: View {
    let state: NativeTaskAttributes.ContentState
    let stale: Bool
    var body: some View {
        if (stale || !state.connected) && !state.phase.terminal {
            HStack(spacing: 4) {
                Text("Last seen: \(state.phase.label.lowercased())")
                Text("·"); Text(state.updatedAt, style: .relative)
            }.font(.caption).foregroundStyle(.secondary).lineLimit(1)
        } else {
            Text(state.phase == .needsInput ? "Needs you · Tap to open" : state.phase.label)
                .font(.caption).foregroundStyle(state.phase == .needsInput || state.phase == .failed ? .orange : .secondary)
        }
    }
}

private struct TaskActivityElapsed: View {
    let state: NativeTaskAttributes.ContentState
    let stale: Bool
    var body: some View {
        if state.phase.terminal || stale || !state.connected {
            Text(Duration.seconds(max(0, state.updatedAt.timeIntervalSince(state.startedAt))).formatted(.time(pattern: .minuteSecond)))
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        } else {
            Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing).lineLimit(1).minimumScaleFactor(0.75).frame(width: 52, alignment: .trailing)
        }
    }
}
