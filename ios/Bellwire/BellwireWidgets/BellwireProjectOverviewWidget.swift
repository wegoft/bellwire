// SPDX-License-Identifier: MPL-2.0
import AppIntents
import SwiftUI
import WidgetKit

struct BellwireProjectOverviewTimelineEntry: TimelineEntry {
    let date: Date
    let snapshot: BellwireWidgetSnapshot
    let project: BellwireProjectWidgetEntity?
    let surfaces: [BellwireNativeSurface]
    let projectLogoData: Data?
    let hasUnavailableSelection: Bool
}

struct BellwireProjectOverviewTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> BellwireProjectOverviewTimelineEntry {
        entry(
            for: BellwireProjectOverviewWidgetIntent(),
            snapshot: BellwireWidgetSnapshotStore.preview
        )
    }

    func snapshot(
        for configuration: BellwireProjectOverviewWidgetIntent,
        in context: Context
    ) async -> BellwireProjectOverviewTimelineEntry {
        entry(
            for: configuration,
            snapshot: BellwireWidgetSnapshotStore.read() ?? BellwireWidgetSnapshotStore.preview
        )
    }

    func timeline(
        for configuration: BellwireProjectOverviewWidgetIntent,
        in context: Context
    ) async -> Timeline<BellwireProjectOverviewTimelineEntry> {
        let snapshot = BellwireWidgetSnapshotStore.read() ?? BellwireWidgetSnapshotStore.empty
        return Timeline(
            entries: [entry(for: configuration, snapshot: snapshot)],
            policy: .after(.now.addingTimeInterval(15 * 60))
        )
    }

    private func entry(
        for configuration: BellwireProjectOverviewWidgetIntent,
        snapshot: BellwireWidgetSnapshot
    ) -> BellwireProjectOverviewTimelineEntry {
        let firstSurface = snapshot.surfaces.first
        let project = configuration.project ?? firstSurface.map { surface in
            BellwireProjectWidgetEntity(
                id: surface.projectID,
                name: surface.projectName,
                icon: surface.projectIcon
            )
        }
        let surfaces = project.map { project in
            Array(snapshot.surfaces.filter { $0.projectID == project.id }.prefix(2))
        } ?? []
        return BellwireProjectOverviewTimelineEntry(
            date: .now,
            snapshot: snapshot,
            project: project,
            surfaces: surfaces,
            projectLogoData: BellwireWidgetSnapshotStore.projectLogoData(
                filename: surfaces.first?.projectLogoFilename
            ),
            hasUnavailableSelection: project != nil && surfaces.isEmpty
        )
    }
}

struct BellwireProjectOverviewWidget: Widget {
    let kind = "BellwireProjectOverview"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: BellwireProjectOverviewWidgetIntent.self,
            provider: BellwireProjectOverviewTimelineProvider()
        ) { entry in
            BellwireProjectOverviewWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    BellwireWidgetStyle.background
                }
        }
        .configurationDisplayName("Project Overview")
        .description("Choose one project and see its two leading cards.")
        .supportedFamilies([.systemMedium])
    }
}

struct BellwireProjectOverviewWidgetView: View {
    let entry: BellwireProjectOverviewTimelineEntry

    var body: some View {
        Group {
            if !entry.snapshot.isPro {
                BellwireWidgetMessageView(
                    icon: "bolt.fill",
                    title: "\(BellwireWidgetSnapshotStore.appDisplayName) Pro",
                    message: "Unlock live project Surfaces on your Home Screen."
                )
            } else if let project = entry.project, !entry.surfaces.isEmpty {
                BellwireProjectOverviewCard(project: project, entry: entry)
            } else if entry.hasUnavailableSelection {
                BellwireWidgetMessageView(
                    icon: "rectangle.stack.badge.minus",
                    title: "Project unavailable",
                    message: "Edit this widget and choose a project with live cards."
                )
            } else {
                BellwireWidgetMessageView(
                    icon: "rectangle.stack",
                    title: BellwireWidgetSnapshotStore.appDisplayName,
                    message: "Publish a Surface to see live project state here."
                )
            }
        }
        .widgetURL(BellwireWidgetSnapshotStore.projectURL(entry.project?.id))
    }
}

struct BellwireProjectOverviewCard: View {
    let project: BellwireProjectWidgetEntity
    let entry: BellwireProjectOverviewTimelineEntry

    var body: some View {
        VStack(alignment: .leading, spacing: BellwireWidgetStyle.standardSpacing) {
            HStack(spacing: BellwireWidgetStyle.standardSpacing) {
                BellwireWidgetProjectLabel(
                    name: project.name,
                    icon: project.icon,
                    logoData: entry.projectLogoData,
                    imageSize: 28,
                    font: .headline
                )
                Spacer(minLength: 4)
                Text(entry.snapshot.updatedAt, style: .relative)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            ViewThatFits(in: .vertical) {
                BellwireProjectOverviewRows(surfaces: entry.surfaces, showsDetails: true)
                BellwireProjectOverviewRows(surfaces: entry.surfaces, showsDetails: false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }
}

struct BellwireProjectOverviewRows: View {
    let surfaces: [BellwireNativeSurface]
    let showsDetails: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: BellwireWidgetStyle.standardSpacing) {
            ForEach(surfaces) { surface in
                BellwireProjectOverviewRow(surface: surface, showsDetails: showsDetails)
                if surface.id != surfaces.last?.id {
                    Divider()
                }
            }
        }
    }
}

struct BellwireProjectOverviewRow: View {
    let surface: BellwireNativeSurface
    let showsDetails: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: BellwireWidgetStyle.compactSpacing) {
            HStack(alignment: .firstTextBaseline, spacing: BellwireWidgetStyle.standardSpacing) {
                Text(widgetSurfaceTitle(surface))
                    .font(.subheadline)
                    .bold()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 8)
                BellwireProjectOverviewTrailingValue(surface: surface)
            }

            if showsDetails, surface.type == "trend", surface.trendPoints.count > 1 {
                HStack(spacing: BellwireWidgetStyle.standardSpacing) {
                    NativeSparkline(values: surface.trendPoints.map(\.value))
                        .stroke(
                            trendColor(surface.trendPoints, goal: surface.trendGoal),
                            lineWidth: 2
                        )
                        .frame(height: 16)
                    Text(trendDelta(surface.trendPoints, unit: surface.trendUnit))
                        .font(.caption)
                        .bold()
                        .monospacedDigit()
                        .foregroundStyle(
                            trendColor(surface.trendPoints, goal: surface.trendGoal)
                        )
                        .lineLimit(1)
                }
            } else if showsDetails, let progress = surface.progress {
                ProgressView(value: progress)
                    .tint(BellwireWidgetStyle.accent)
            } else if showsDetails, let subtitle = surface.subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

}

#if DEBUG
#Preview(as: .systemMedium) {
    BellwireProjectOverviewWidget()
} timeline: {
    BellwireProjectOverviewTimelineEntry(
        date: .now,
        snapshot: BellwireWidgetSnapshotStore.preview,
        project: BellwireProjectWidgetEntity(
            id: "preview-project",
            name: "VideoSays",
            icon: "play.rectangle.fill"
        ),
        surfaces: BellwireWidgetSnapshotStore.preview.surfaces,
        projectLogoData: nil,
        hasUnavailableSelection: false
    )
}
#endif

struct BellwireProjectOverviewTrailingValue: View {
    let surface: BellwireNativeSurface

    var body: some View {
        if surface.type == "status" {
            Label(
                surface.statusLabel ?? nativeStatusLabel(surface.statusState),
                systemImage: nativeStatusSymbol(surface.statusState)
            )
            .foregroundStyle(nativeStatusColor(surface.statusState))
        } else if surface.type == "checklist" {
            Text(checklistSummary(surface.checklistItems))
                .foregroundStyle(BellwireWidgetStyle.accent)
        } else if let value = surface.value {
            Text(value)
                .foregroundStyle(BellwireWidgetStyle.accent)
        }
    }
}
