// SPDX-License-Identifier: MPL-2.0
import SwiftUI

struct LiveSurfacesSection: View {
    let surfaces: [LiveSurfaceRecord]
    var showsHeader = true

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            if showsHeader {
                SectionHeaderView(title: "Live surfaces", hint: "Updated by Agents")
            }
            ForEach(surfaces) { surface in
                LiveSurfaceCard(surface: surface)
            }
        }
    }
}

struct LiveSurfaceCard: View {
    let surface: LiveSurfaceRecord

    @ViewBuilder
    var body: some View {
        switch surface.type {
        case "stats":
            StatsSurfaceCard(surface: surface)
        case "metrics":
            MetricsSurfaceCard(surface: surface)
        case "progress":
            ProgressSurfaceCard(surface: surface)
        case "segmented_progress":
            SegmentedProgressSurfaceCard(surface: surface)
        case "alert":
            AlertSurfaceCard(surface: surface)
        case "timer":
            TimerSurfaceCard(surface: surface)
        case "status":
            StatusSurfaceCard(surface: surface)
        case "checklist":
            ChecklistSurfaceCard(surface: surface)
        case "trend":
            TrendSurfaceCard(surface: surface)
        default:
            GenericSurfaceCard(surface: surface)
        }
    }
}

private struct StatsSurfaceCard: View {
    let surface: LiveSurfaceRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 12) {
                SurfaceIdentity(surface: surface, size: 36)
                Spacer(minLength: 6)
                SurfaceTypeBadge(title: "Stats", color: BellwireTheme.accent)
            }
            StatsSurfaceContent(metrics: surface.metrics)
            SurfaceFooter(surface: surface)
        }
        .surfaceCard()
    }
}

private struct ProgressSurfaceCard: View {
    let surface: LiveSurfaceRecord

    private var fraction: Double {
        surfaceProgress(surface)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .center, spacing: 12) {
                SurfaceIdentity(
                    surface: surface,
                    size: 36,
                    fallbackSubtitle: runningSubtitle
                )
                Spacer(minLength: 6)
                Text(fraction, format: .percent.precision(.fractionLength(0)))
                    .font(.system(.title, design: .serif, weight: .regular))
                    .monospacedDigit()
                    .foregroundStyle(BellwireTheme.ink)
                    .contentTransition(.numericText())
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(BellwireTheme.tertiarySurface)
                    Capsule()
                        .fill(BellwireTheme.live)
                        .frame(width: proxy.size.width * min(max(fraction, 0), 1))
                }
            }
            .frame(height: 6)
            SurfaceFooter(surface: surface, showsProject: false)
        }
        .surfaceCard()
    }

    private var runningSubtitle: String {
        if let project = surface.project?.name { return "\(project) · running" }
        return "Running"
    }
}

private struct AlertSurfaceCard: View {
    let surface: LiveSurfaceRecord

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(BellwireTheme.danger.opacity(0.17))
                Image(systemName: alertSymbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(BellwireTheme.danger)
            }
            .frame(width: 36, height: 36)

            VStack(alignment: .leading, spacing: 4) {
                Text(surface.title)
                    .font(BellwireTypography.cardTitle)
                    .foregroundStyle(BellwireTheme.ink)
                    .lineLimit(2)
                Text(alertMessage)
                    .font(BellwireTypography.metadata)
                    .foregroundStyle(BellwireTheme.mutedInk)
                    .lineLimit(2)
            }
            Spacer(minLength: 6)
            if let action = validAction {
                Link(destination: action.url) {
                    Text(action.title)
                        .font(BellwireTypography.metadata.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 13)
                        .frame(height: 30)
                        .background(BellwireTheme.danger, in: Capsule())
                }
                .buttonStyle(PressableButtonStyle())
            } else if let badge = surface.content["badge"]?.objectValue,
                      let title = badge["title"]?.stringValue {
                SurfaceTypeBadge(title: title, color: surfaceColor(badge["color"]?.stringValue))
            }
        }
        .surfaceCard(isAlert: true)
    }

    private var alertMessage: String {
        surface.subtitle ?? surface.content["message"]?.stringValue ?? ""
    }

    private var alertSymbol: String {
        surface.content["icon"]?.objectValue?["symbol"]?.stringValue ?? "exclamationmark.triangle"
    }

    private var validAction: (title: String, url: URL)? {
        guard let action = surface.action,
              action.type == "open_url",
              let url = URL(string: action.url)
        else { return nil }
        return (action.title, url)
    }
}

private struct MetricsSurfaceCard: View {
    let surface: LiveSurfaceRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SurfaceIdentity(surface: surface, size: 36)
            MetricsSurfaceContent(metrics: surface.metrics)
            SurfaceFooter(surface: surface)
        }
        .surfaceCard()
    }
}

private struct SegmentedProgressSurfaceCard: View {
    let surface: LiveSurfaceRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SurfaceIdentity(surface: surface, size: 36)
            SegmentedProgressSurfaceContent(surface: surface)
            SurfaceFooter(surface: surface)
        }
        .surfaceCard()
    }
}

private struct TimerSurfaceCard: View {
    let surface: LiveSurfaceRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                SurfaceIdentity(surface: surface, size: 36)
                Spacer(minLength: 6)
                TimerSurfaceContent(surface: surface)
            }
            SurfaceFooter(surface: surface)
        }
        .surfaceCard()
    }
}

private struct GenericSurfaceCard: View {
    let surface: LiveSurfaceRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SurfaceIdentity(surface: surface, size: 36)
            Text("Unsupported surface")
                .font(.subheadline)
                .foregroundStyle(BellwireTheme.secondaryInk)
            SurfaceFooter(surface: surface)
        }
        .surfaceCard()
    }
}

struct SurfaceIdentity: View {
    let surface: LiveSurfaceRecord
    var size: CGFloat
    var fallbackSubtitle: String? = nil
    @Environment(\.locale) private var locale

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ProjectAvatarView(
                name: surface.project?.name ?? surface.title,
                icon: surface.project?.icon ?? "rectangle.3.group",
                size: size,
                logoURL: surface.project?.logoUrl.flatMap(URL.init(string:))
            )
            VStack(alignment: .leading, spacing: 4) {
                Text(surface.title)
                    .font(BellwireTypography.cardTitle)
                    .foregroundStyle(BellwireTheme.ink)
                    .lineLimit(2)
                Text(subtitle)
                    .font(BellwireTypography.metadata)
                    .foregroundStyle(BellwireTheme.mutedInk)
                    .lineLimit(1)
            }
        }
    }

    private var subtitle: String {
        if let subtitle = surface.subtitle, !subtitle.isEmpty { return subtitle }
        if let fallbackSubtitle { return fallbackSubtitle }
        if let updatedDate = surface.updatedDate {
            return "updated \(BellwireDateFormatting.relative(updatedDate, locale: locale))"
        }
        return surface.project?.name ?? "Live surface"
    }
}

struct SurfaceTypeBadge: View {
    let title: String
    let color: Color

    var body: some View {
        Text(LocalizedStringKey(title))
            .font(BellwireTypography.microLabel)
            .textCase(.uppercase)
            .tracking(1.3)
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct SurfaceFooter: View {
    let surface: LiveSurfaceRecord
    var showsProject = true
    @Environment(\.locale) private var locale

    var body: some View {
        HStack(spacing: 6) {
            if showsProject, let project = surface.project {
                Text(project.name).lineLimit(1)
            }
            if showsProject, surface.project != nil, surface.updatedDate != nil { Text("·") }
            if let date = surface.updatedDate {
                Text(BellwireDateFormatting.relative(date, locale: locale))
                    .monospacedDigit()
            }
            Spacer(minLength: 8)
            if let action = surface.action,
               action.type == "open_url",
               let url = URL(string: action.url) {
                Link(destination: url) {
                    HStack(spacing: 4) {
                        Text(action.title)
                        Image(systemName: "arrow.up.right")
                            .font(.caption.bold())
                    }
                    .font(BellwireTypography.metadata.weight(.semibold))
                    .foregroundStyle(BellwireTheme.accent)
                    .frame(minHeight: 30)
                }
                .buttonStyle(PressableButtonStyle())
            }
        }
        .font(BellwireTypography.metadata)
        .foregroundStyle(BellwireTheme.mutedInk)
    }
}

private struct StatsSurfaceContent: View {
    let metrics: [LiveSurfaceMetric]
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 14) {
            ForEach(Array(metrics.enumerated()), id: \.offset) { index, metric in
                VStack(alignment: .leading, spacing: 5) {
                    Text(metric.label)
                        .font(BellwireTypography.microLabel)
                        .textCase(.uppercase)
                        .tracking(1.05)
                        .foregroundStyle(BellwireTheme.mutedInk)
                        .lineLimit(1)
                    Text(metric.value.displayValue + (metric.unit ?? ""))
                        .font(BellwireTypography.microMetric)
                        .monospacedDigit()
                        .foregroundStyle(index == 0 ? surfaceColor(metric.color, fallback: BellwireTheme.accent) : BellwireTheme.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.55)
                }
            }
        }
    }

    private var columns: [GridItem] {
        let count = dynamicTypeSize.isAccessibilitySize ? min(max(metrics.count, 1), 2) : min(max(metrics.count, 1), 4)
        return Array(repeating: GridItem(.flexible(minimum: 42), spacing: 10, alignment: .leading), count: count)
    }
}

private struct MetricsSurfaceContent: View {
    let metrics: [LiveSurfaceMetric]

    var body: some View {
        VStack(spacing: 13) {
            ForEach(Array(metrics.enumerated()), id: \.offset) { _, metric in
                VStack(spacing: 7) {
                    HStack {
                        Text(metric.label)
                        Spacer()
                        Text(metric.value.displayValue + (metric.unit ?? ""))
                            .font(BellwireTypography.technicalStrong)
                            .monospacedDigit()
                            .foregroundStyle(BellwireTheme.ink)
                    }
                    .font(.subheadline)
                    .foregroundStyle(BellwireTheme.secondaryInk)
                    GeometryReader { proxy in
                        let fraction = min(max((metric.value.numberValue ?? 0) / 100, 0), 1)
                        ZStack(alignment: .leading) {
                            Capsule().fill(BellwireTheme.tertiarySurface)
                            Capsule()
                                .fill(surfaceColor(metric.color))
                                .frame(width: proxy.size.width * fraction)
                        }
                    }
                    .frame(height: 6)
                }
            }
        }
    }
}

private struct SegmentedProgressSurfaceContent: View {
    let surface: LiveSurfaceRecord

    var body: some View {
        let steps = Int(surface.content["numberOfSteps"]?.numberValue ?? 1)
        let current = Int(surface.content["currentStep"]?.numberValue ?? 0)
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 5) {
                ForEach(0..<max(steps, 1), id: \.self) { index in
                    Capsule()
                        .fill(index < current ? BellwireTheme.live : BellwireTheme.tertiarySurface)
                        .frame(height: 7)
                }
            }
            HStack {
                if let label = surface.content["stepLabel"]?.stringValue {
                    Text(label).lineLimit(1)
                }
                Spacer()
                Text("Step \(current) of \(steps)")
                    .monospacedDigit()
            }
            .font(BellwireTypography.metadata)
            .foregroundStyle(BellwireTheme.mutedInk)
        }
    }
}

private struct TimerSurfaceContent: View {
    let surface: LiveSurfaceRecord

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let duration = surface.content["durationSeconds"]?.numberValue ?? 0
            let updated = surface.updatedDate ?? .now
            let elapsed = max(context.date.timeIntervalSince(updated), 0)
            let countsDown = surface.content["countsDown"]?.boolValue != false
            let seconds = countsDown ? max(duration - elapsed, 0) : elapsed
            Text(formattedDuration(seconds))
                .font(.system(.title, design: .serif, weight: .regular))
                .monospacedDigit()
                .foregroundStyle(BellwireTheme.ink)
                .contentTransition(.numericText())
        }
    }

    private func formattedDuration(_ interval: TimeInterval) -> String {
        let seconds = max(Int(interval.rounded(.down)), 0)
        let hours = seconds / 3_600
        let minutes = (seconds % 3_600) / 60
        let remainder = seconds % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, remainder)
            : String(format: "%02d:%02d", minutes, remainder)
    }
}

private struct SurfaceCardModifier: ViewModifier {
    let isAlert: Bool

    func body(content: Content) -> some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                isAlert ? BellwireTheme.danger.opacity(0.075) : BellwireTheme.surface,
                in: RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)
            )
            .overlay {
                if isAlert {
                    RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)
                        .stroke(BellwireTheme.danger.opacity(0.36), lineWidth: 1)
                }
            }
            .accessibilityElement(children: .contain)
    }
}

extension View {
    func surfaceCard(isAlert: Bool = false) -> some View {
        modifier(SurfaceCardModifier(isAlert: isAlert))
    }
}

private func surfaceProgress(_ surface: LiveSurfaceRecord) -> Double {
    if let percentage = surface.content["percentage"]?.numberValue { return percentage / 100 }
    let value = surface.content["value"]?.numberValue ?? 0
    let upper = surface.content["upperLimit"]?.numberValue ?? 1
    return upper > 0 ? value / upper : 0
}

func surfaceColor(_ name: String?, fallback: Color = BellwireTheme.secondaryInk) -> Color {
    switch name {
    case "lime": Color(red: 0.54, green: 0.73, blue: 0.24)
    case "green": BellwireTheme.live
    case "cyan": Color(red: 0.24, green: 0.68, blue: 0.72)
    case "blue": Color(red: 0.35, green: 0.57, blue: 0.82)
    case "purple": Color(red: 0.57, green: 0.47, blue: 0.76)
    case "magenta": Color(red: 0.72, green: 0.40, blue: 0.58)
    case "red": BellwireTheme.danger
    case "orange", "yellow": BellwireTheme.accent
    default: fallback
    }
}
