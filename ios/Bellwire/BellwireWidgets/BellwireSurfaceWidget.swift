// SPDX-License-Identifier: MPL-2.0
import AppIntents
import SwiftUI
import WidgetKit

struct BellwireSurfaceTimelineEntry: TimelineEntry {
    let date: Date
    let snapshot: BellwireWidgetSnapshot
    let surface: BellwireNativeSurface?
    let projectLogoData: Data?
    let hasUnavailableSelection: Bool
}

struct BellwireSurfaceTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> BellwireSurfaceTimelineEntry {
        entry(for: BellwireSurfaceWidgetIntent(), snapshot: BellwireWidgetSnapshotStore.preview)
    }

    func snapshot(
        for configuration: BellwireSurfaceWidgetIntent,
        in context: Context
    ) async -> BellwireSurfaceTimelineEntry {
        entry(
            for: configuration,
            snapshot: BellwireWidgetSnapshotStore.read() ?? BellwireWidgetSnapshotStore.preview
        )
    }

    func timeline(
        for configuration: BellwireSurfaceWidgetIntent,
        in context: Context
    ) async -> Timeline<BellwireSurfaceTimelineEntry> {
        let snapshot = BellwireWidgetSnapshotStore.read() ?? BellwireWidgetSnapshotStore.empty
        return Timeline(
            entries: [entry(for: configuration, snapshot: snapshot)],
            policy: .after(.now.addingTimeInterval(15 * 60))
        )
    }

    private func entry(
        for configuration: BellwireSurfaceWidgetIntent,
        snapshot: BellwireWidgetSnapshot
    ) -> BellwireSurfaceTimelineEntry {
        let candidates: [BellwireNativeSurface]
        if let projectID = configuration.project?.id {
            candidates = snapshot.surfaces.filter { $0.projectID == projectID }
        } else {
            candidates = snapshot.surfaces
        }
        let selected = configuration.surface.flatMap { selection in
            candidates.first { $0.id == selection.id }
        } ?? candidates.first
        return BellwireSurfaceTimelineEntry(
            date: .now,
            snapshot: snapshot,
            surface: selected,
            projectLogoData: BellwireWidgetSnapshotStore.projectLogoData(
                filename: selected?.projectLogoFilename
            ),
            hasUnavailableSelection: selected == nil
                && (configuration.project != nil || configuration.surface != nil)
        )
    }
}

struct BellwireSurfaceWidget: Widget {
    let kind = "BellwireSurfaces"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: BellwireSurfaceWidgetIntent.self,
            provider: BellwireSurfaceTimelineProvider()
        ) { entry in
            BellwireSurfaceWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    BellwireWidgetStyle.background
                }
        }
        .configurationDisplayName("Surface")
        .description("Choose one project card for your Home Screen.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct BellwireSurfaceWidgetView: View {
    let entry: BellwireSurfaceTimelineEntry

    var body: some View {
        Group {
            if !entry.snapshot.isPro {
                BellwireWidgetMessageView(
                    icon: "bolt.fill",
                    title: "\(BellwireWidgetSnapshotStore.appDisplayName) Pro",
                    message: "Unlock live project Surfaces on your Home Screen."
                )
            } else if let surface = entry.surface {
                BellwireSurfaceWidgetCard(
                    surface: surface,
                    projectLogoData: entry.projectLogoData
                )
            } else if entry.hasUnavailableSelection {
                BellwireWidgetMessageView(
                    icon: "rectangle.slash",
                    title: "Card unavailable",
                    message: "Edit this widget and choose an available project card."
                )
            } else {
                BellwireWidgetMessageView(
                    icon: "rectangle.stack",
                    title: BellwireWidgetSnapshotStore.appDisplayName,
                    message: "Publish a Surface to see live project state here."
                )
            }
        }
        .widgetURL(BellwireWidgetSnapshotStore.projectURL(entry.surface?.projectID))
    }
}

struct BellwireSurfaceWidgetCard: View {
    @Environment(\.widgetFamily) private var family
    let surface: BellwireNativeSurface
    let projectLogoData: Data?

    var body: some View {
        VStack(alignment: .leading, spacing: BellwireWidgetStyle.standardSpacing) {
            HStack(spacing: BellwireWidgetStyle.standardSpacing) {
                BellwireWidgetProjectLabel(
                    name: surface.projectName,
                    icon: surface.projectIcon,
                    logoData: projectLogoData,
                    imageSize: 22,
                    font: .caption
                )
                Spacer(minLength: 4)
                if family == .systemMedium {
                    Text(surface.updatedAt, style: .relative)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Text(widgetSurfaceTitle(surface))
                .font(family == .systemMedium ? .headline : .subheadline)
                .bold()
                .lineLimit(family == .systemMedium ? 1 : 2)
                .minimumScaleFactor(0.85)

            ViewThatFits(in: .vertical) {
                BellwireSurfaceWidgetDetail(surface: surface, family: family, showsSubtitle: true)
                BellwireSurfaceWidgetDetail(surface: surface, family: family, showsSubtitle: false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview(as: .systemSmall) {
    BellwireSurfaceWidget()
} timeline: {
    BellwireSurfaceTimelineEntry(
        date: .now,
        snapshot: BellwireWidgetSnapshotStore.preview,
        surface: BellwireWidgetSnapshotStore.preview.surfaces.first,
        projectLogoData: nil,
        hasUnavailableSelection: false
    )
}

#Preview(as: .systemMedium) {
    BellwireSurfaceWidget()
} timeline: {
    BellwireSurfaceTimelineEntry(
        date: .now,
        snapshot: BellwireWidgetSnapshotStore.preview,
        surface: BellwireWidgetSnapshotStore.preview.surfaces.last,
        projectLogoData: nil,
        hasUnavailableSelection: false
    )
}
#endif

struct BellwireSurfaceWidgetDetail: View {
    let surface: BellwireNativeSurface
    let family: WidgetFamily
    let showsSubtitle: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: BellwireWidgetStyle.compactSpacing) {
            switch surface.type {
            case "status":
                Label(
                    surface.statusLabel ?? nativeStatusLabel(surface.statusState),
                    systemImage: nativeStatusSymbol(surface.statusState)
                )
                .font(.title3)
                .bold()
                .foregroundStyle(nativeStatusColor(surface.statusState))
            case "checklist":
                HStack {
                    Text(checklistSummary(surface.checklistItems))
                        .font(.title3)
                        .bold()
                        .monospacedDigit()
                    Spacer()
                    Text("complete")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ProgressView(value: checklistProgress(surface.checklistItems))
                    .tint(BellwireWidgetStyle.accent)
                if showsSubtitle,
                   let current = surface.checklistItems.first(where: { $0.state == "running" })
                    ?? surface.checklistItems.first(where: { $0.state == "pending" }) {
                    Text(current.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            case "trend":
                if let value = surface.value {
                    Text(value)
                        .font(family == .systemMedium ? .title2 : .title3)
                        .bold()
                        .monospacedDigit()
                        .foregroundStyle(BellwireWidgetStyle.accent)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                HStack(spacing: BellwireWidgetStyle.standardSpacing) {
                    NativeSparkline(values: surface.trendPoints.map(\.value))
                        .stroke(
                            trendColor(surface.trendPoints, goal: surface.trendGoal),
                            lineWidth: 2.5
                        )
                        .frame(height: family == .systemMedium ? 34 : 24)
                    Text(trendDelta(surface.trendPoints, unit: surface.trendUnit))
                        .font(.caption)
                        .bold()
                        .monospacedDigit()
                        .foregroundStyle(
                            trendColor(surface.trendPoints, goal: surface.trendGoal)
                        )
                        .lineLimit(1)
                }
            default:
                if let value = surface.value {
                    Text(value)
                        .font(family == .systemMedium ? .title2 : .title3)
                        .bold()
                        .monospacedDigit()
                        .foregroundStyle(BellwireWidgetStyle.accent)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                if let progress = surface.progress {
                    ProgressView(value: progress)
                        .tint(BellwireWidgetStyle.accent)
                }
            }

            if showsSubtitle,
               surface.type != "checklist",
               let subtitle = surface.subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(family == .systemMedium ? 1 : 2)
            }
        }
    }
}

struct BellwireWidgetMessageView: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: BellwireWidgetStyle.standardSpacing) {
            Label(title, systemImage: icon)
                .font(.headline)
                .foregroundStyle(BellwireWidgetStyle.accent)
                .lineLimit(1)
            Text(LocalizedStringKey(message))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
