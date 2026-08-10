// SPDX-License-Identifier: MPL-2.0
import ActivityKit
import SwiftUI
import WidgetKit

@main
struct BellwireWidgetBundle: WidgetBundle {
    var body: some Widget {
        BellwireSurfaceWidget()
        BellwireProjectOverviewWidget()
        BellwireSurfaceLiveActivity()
    }
}

private struct BellwireSurfaceLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BellwireActivityAttributes.self) { context in
            BellwireLiveActivityLockScreen(context: context)
                .activityBackgroundTint(Color(red: 0.055, green: 0.052, blue: 0.046))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: context.attributes.projectIcon)
                        .foregroundStyle(accent)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.type == "status" {
                        Image(systemName: nativeStatusSymbol(context.state.statusState))
                            .foregroundStyle(nativeStatusColor(context.state.statusState))
                    } else if context.state.type == "checklist" {
                        Text(checklistSummary(context.state.checklistItems ?? []))
                            .font(.headline)
                            .monospacedDigit()
                            .foregroundStyle(accent)
                    } else if let value = context.state.value {
                        Text(value)
                            .font(.headline)
                            .monospacedDigit()
                            .foregroundStyle(accent)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    NativeActivityDetail(state: context.state, accent: accent)
                }
            } compactLeading: {
                Image(systemName: context.attributes.projectIcon)
                    .foregroundStyle(accent)
            } compactTrailing: {
                if context.state.type == "status" {
                    Image(systemName: nativeStatusSymbol(context.state.statusState))
                        .foregroundStyle(nativeStatusColor(context.state.statusState))
                } else if context.state.type == "checklist" {
                    Text(checklistSummary(context.state.checklistItems ?? []))
                        .font(.caption2)
                        .monospacedDigit()
                } else if context.state.type == "trend" {
                    Image(systemName: trendSymbol(context.state.trendPoints ?? []))
                        .foregroundStyle(trendColor(context.state.trendPoints ?? [], goal: context.state.trendGoal))
                } else if let progress = context.state.progress {
                    Text(progress, format: .percent.precision(.fractionLength(0)))
                        .font(.caption2)
                        .monospacedDigit()
                } else {
                    Image(systemName: "bolt.fill").foregroundStyle(accent)
                }
            } minimal: {
                Image(systemName: minimalSymbol(context.state))
                    .foregroundStyle(minimalColor(context.state, accent: accent))
            }
        }
    }

    private var accent: Color {
        Color(red: 1.0, green: 0.58, blue: 0.08)
    }
}

private struct BellwireLiveActivityLockScreen: View {
    let context: ActivityViewContext<BellwireActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(context.attributes.projectName, systemImage: context.attributes.projectIcon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let value = context.state.value {
                    Text(value)
                        .font(.title3.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(accent)
                }
            }
            Text(context.state.title)
                .font(.headline)
                .lineLimit(1)
            NativeActivityDetail(state: context.state, accent: accent, showsTitle: false)
        }
        .padding(.horizontal, 4)
        .widgetURL(widgetURL)
    }

    private var accent: Color {
        Color(red: 1.0, green: 0.58, blue: 0.08)
    }

    private var widgetURL: URL? {
        let scheme = Bundle.main.object(forInfoDictionaryKey: "BellwireURLScheme") as? String
            ?? "bellwire"
        return URL(string: "\(scheme)://home")
    }
}

private struct NativeActivityDetail: View {
    let state: BellwireActivityAttributes.ContentState
    let accent: Color
    var showsTitle = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsTitle {
                Text(state.title).font(.headline).lineLimit(1)
            }
            switch state.type {
            case "status":
                Label(
                    state.statusLabel ?? nativeStatusLabel(state.statusState),
                    systemImage: nativeStatusSymbol(state.statusState)
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(nativeStatusColor(state.statusState))
            case "checklist":
                let items = state.checklistItems ?? []
                ProgressView(value: checklistProgress(items)).tint(accent)
                if let current = items.first(where: { $0.state == "running" })
                    ?? items.first(where: { $0.state == "pending" }) {
                    Text(current.title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            case "trend":
                let points = state.trendPoints ?? []
                HStack(spacing: 10) {
                    NativeSparkline(values: points.map(\.value))
                        .stroke(trendColor(points, goal: state.trendGoal), lineWidth: 2)
                        .frame(height: 24)
                    Text(trendDelta(points, unit: state.trendUnit))
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(trendColor(points, goal: state.trendGoal))
                }
            default:
                if let progress = state.progress {
                    ProgressView(value: progress).tint(accent)
                } else if let subtitle = state.subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
    }
}

struct NativeSparkline: Shape {
    let values: [Double]

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard values.count > 1, let low = values.min(), let high = values.max() else { return path }
        let range = high - low
        for (index, value) in values.enumerated() {
            let x = rect.minX + CGFloat(index) / CGFloat(values.count - 1) * rect.width
            let normalized = range == 0 ? 0.5 : (value - low) / range
            let y = rect.maxY - CGFloat(normalized) * rect.height
            if index == 0 { path.move(to: CGPoint(x: x, y: y)) }
            else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        return path
    }
}

func nativeStatusLabel(_ state: String?) -> String {
    switch state {
    case "running": "Running"
    case "success": "Healthy"
    case "warning": "Attention"
    case "critical": "Critical"
    case "paused": "Paused"
    default: "Neutral"
    }
}

func nativeStatusSymbol(_ state: String?) -> String {
    switch state {
    case "running": "arrow.triangle.2.circlepath"
    case "success": "checkmark.circle.fill"
    case "warning": "exclamationmark.triangle.fill"
    case "critical": "xmark.octagon.fill"
    case "paused": "pause.circle.fill"
    default: "circle.dotted"
    }
}

func nativeStatusColor(_ state: String?) -> Color {
    switch state {
    case "success": .green
    case "warning": .yellow
    case "critical": .red
    case "paused": .secondary
    default: Color(red: 1.0, green: 0.58, blue: 0.08)
    }
}

func checklistSummary(_ items: [BellwireNativeSurface.ChecklistItem]) -> String {
    "\(items.count { $0.state == "completed" || $0.state == "skipped" })/\(items.count)"
}

func checklistProgress(_ items: [BellwireNativeSurface.ChecklistItem]) -> Double {
    guard !items.isEmpty else { return 0 }
    return Double(items.count { $0.state == "completed" || $0.state == "skipped" })
        / Double(items.count)
}

func trendDelta(_ points: [BellwireNativeSurface.TrendPoint], unit: String?) -> String {
    guard let first = points.first?.value, let last = points.last?.value else { return "—" }
    let delta = last - first
    return "\(delta >= 0 ? "+" : "")\(delta.formatted(.number.precision(.fractionLength(0...2))))\(unit ?? "")"
}

private func trendSymbol(_ points: [BellwireNativeSurface.TrendPoint]) -> String {
    guard let first = points.first?.value, let last = points.last?.value else { return "minus" }
    return last > first ? "arrow.up.right" : last < first ? "arrow.down.right" : "arrow.right"
}

func trendColor(_ points: [BellwireNativeSurface.TrendPoint], goal: String?) -> Color {
    guard let first = points.first?.value, let last = points.last?.value else { return .secondary }
    if goal == "neutral" || first == last { return .secondary }
    let improved = goal == "down" ? last < first : last > first
    return improved ? .green : .red
}

private func minimalSymbol(_ state: BellwireActivityAttributes.ContentState) -> String {
    switch state.type {
    case "status": nativeStatusSymbol(state.statusState)
    case "checklist": "checklist"
    case "trend": trendSymbol(state.trendPoints ?? [])
    default: "bolt.fill"
    }
}

private func minimalColor(
    _ state: BellwireActivityAttributes.ContentState,
    accent: Color
) -> Color {
    switch state.type {
    case "status": nativeStatusColor(state.statusState)
    case "trend": trendColor(state.trendPoints ?? [], goal: state.trendGoal)
    default: accent
    }
}
