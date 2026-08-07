// SPDX-License-Identifier: MPL-2.0
import ActivityKit
import Foundation
import WidgetKit

@MainActor
final class NativeDisplayManager {
    static let shared = NativeDisplayManager()

    private let snapshotFilename = "bellwire-widget-snapshot.json"

    private init() {}

    func synchronize(
        surfaces: [LiveSurfaceRecord],
        projects: [ProjectSummary],
        isPro: Bool
    ) async {
        let allNativeSurfaces = surfaces.map(Self.nativeSurface)
        let nativeSurfaces = Array(allNativeSurfaces.prefix(10))
        writeSnapshot(
            BellwireWidgetSnapshot(
                isPro: isPro,
                updatedAt: .now,
                surfaces: nativeSurfaces
            )
        )
        WidgetCenter.shared.reloadTimelines(ofKind: "BellwireSurfaces")

        await synchronizePrivateAgentActivities(
            surfaces: surfaces,
            projects: projects,
            isPro: isPro
        )

        let byID = Dictionary(uniqueKeysWithValues: allNativeSurfaces.map { ($0.id, $0) })
        let recordsByID = Dictionary(uniqueKeysWithValues: surfaces.map { ($0.id, $0) })
        for activity in Activity<BellwireActivityAttributes>.activities {
            if activity.attributes.origin == "agent",
               let record = recordsByID[activity.attributes.surfaceID],
               record.liveActivity?.sessionId == activity.attributes.sessionID,
               record.liveActivity?.state == "ended" {
                await activity.end(nil, dismissalPolicy: .immediate)
                continue
            }
            guard isPro, let surface = byID[activity.attributes.surfaceID] else {
                await activity.end(nil, dismissalPolicy: .immediate)
                continue
            }
            await activity.update(
                ActivityContent(
                    state: Self.contentState(surface),
                    staleDate: Date().addingTimeInterval(15 * 60)
                )
            )
        }
    }

    func startLiveActivity(for surface: LiveSurfaceRecord) async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw NativeDisplayError.liveActivitiesDisabled
        }
        let native = Self.nativeSurface(surface)
        for activity in Activity<BellwireActivityAttributes>.activities
        where activity.attributes.surfaceID == surface.id {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        _ = try Activity.request(
            attributes: BellwireActivityAttributes(
                surfaceID: native.id,
                projectName: native.projectName,
                projectIcon: native.projectIcon,
                projectID: native.projectID,
                surfaceKey: native.surfaceKey,
                sessionID: nil,
                origin: "manual",
                deliveryMode: nil
            ),
            content: ActivityContent(
                state: Self.contentState(native),
                staleDate: Date().addingTimeInterval(15 * 60)
            ),
            pushType: nil
        )
    }

    func setAgentLiveActivitiesEnabled(_ enabled: Bool) async {
        UserDefaults.standard.set(enabled, forKey: Self.agentConsentKey)
        guard !enabled else { return }
        for activity in Activity<BellwireActivityAttributes>.activities
        where activity.attributes.origin == "agent" {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    func stopLiveActivity(surfaceID: String) async {
        for activity in Activity<BellwireActivityAttributes>.activities
        where activity.attributes.surfaceID == surfaceID {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    func isLive(surfaceID: String) -> Bool {
        Activity<BellwireActivityAttributes>.activities.contains {
            $0.attributes.surfaceID == surfaceID
        }
    }

    func clear() async {
        writeSnapshot(
            BellwireWidgetSnapshot(isPro: false, updatedAt: .now, surfaces: [])
        )
        WidgetCenter.shared.reloadTimelines(ofKind: "BellwireSurfaces")
        for activity in Activity<BellwireActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    private func writeSnapshot(_ snapshot: BellwireWidgetSnapshot) {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroup
        ) else { return }
        let url = container.appendingPathComponent(snapshotFilename)
        guard let data = try? JSONEncoder.bellwireNative.encode(snapshot) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtection])
    }

    private static var appGroup: String {
        Bundle.main.object(forInfoDictionaryKey: "BellwireAppGroup") as? String
            ?? "group.app.bellwire.shared"
    }

    private static let agentConsentKey = "agentLiveActivitiesEnabled"

    private func synchronizePrivateAgentActivities(
        surfaces: [LiveSurfaceRecord],
        projects: [ProjectSummary],
        isPro: Bool
    ) async {
        let enabled = UserDefaults.standard.bool(forKey: Self.agentConsentKey)
        guard enabled, isPro else {
            for activity in Activity<BellwireActivityAttributes>.activities
            where activity.attributes.origin == "agent" {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            return
        }
        let privateProjectIDs = Set(
            projects.filter { $0.deliveryMode == .private }.map(\.id)
        )
        let directives = surfaces.filter {
            privateProjectIDs.contains($0.projectId) && $0.liveActivity != nil
        }
        for surface in directives {
            guard let directive = surface.liveActivity else { continue }
            let matching = Activity<BellwireActivityAttributes>.activities.filter {
                $0.attributes.origin == "agent"
                    && $0.attributes.projectID == surface.projectId
                    && $0.attributes.sessionID == directive.sessionId
            }
            if directive.state == "ended" {
                for activity in matching {
                    await activity.end(nil, dismissalPolicy: .immediate)
                }
                continue
            }
            guard matching.isEmpty else { continue }
            for activity in Activity<BellwireActivityAttributes>.activities
            where activity.attributes.origin == "agent"
                && activity.attributes.projectID == surface.projectId {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            let activeAgentCount = Activity<BellwireActivityAttributes>.activities.count {
                $0.attributes.origin == "agent"
            }
            guard activeAgentCount < 3, ActivityAuthorizationInfo().areActivitiesEnabled else {
                continue
            }
            let native = Self.nativeSurface(surface)
            _ = try? Activity.request(
                attributes: BellwireActivityAttributes(
                    surfaceID: native.id,
                    projectName: native.projectName,
                    projectIcon: native.projectIcon,
                    projectID: native.projectID,
                    surfaceKey: native.surfaceKey,
                    sessionID: directive.sessionId,
                    origin: "agent",
                    deliveryMode: "private"
                ),
                content: ActivityContent(
                    state: Self.contentState(native),
                    staleDate: Date().addingTimeInterval(15 * 60)
                ),
                pushType: nil
            )
        }
    }

    private static func nativeSurface(_ surface: LiveSurfaceRecord) -> BellwireNativeSurface {
        let progress: Double?
        if let percentage = surface.content["percentage"]?.numberValue {
            progress = min(max(percentage / 100, 0), 1)
        } else if let value = surface.content["value"]?.numberValue,
                  let upper = surface.content["upperLimit"]?.numberValue,
                  upper > 0 {
            progress = min(max(value / upper, 0), 1)
        } else {
            progress = nil
        }
        let metric = surface.metrics.first
        let directValue = surface.content["displayValue"]?.displayValue
            ?? surface.content["value"]?.displayValue
        let value = metric.map { $0.value.displayValue + ($0.unit ?? "") } ?? directValue
        let checklistItems = surface.checklistItems.map {
            BellwireNativeSurface.ChecklistItem(id: $0.id, title: $0.title, state: $0.state)
        }
        let trendPoints = surface.trendPoints.map {
            BellwireNativeSurface.TrendPoint(label: $0.label, value: $0.value)
        }
        return BellwireNativeSurface(
            id: surface.id,
            projectID: surface.projectId,
            projectName: surface.project?.name ?? "Bellwire",
            projectIcon: surface.project?.icon ?? "rectangle.3.group",
            surfaceKey: surface.surfaceKey,
            type: surface.type,
            title: surface.title,
            subtitle: surface.subtitle,
            value: value,
            progress: progress,
            statusState: surface.content["state"]?.stringValue,
            statusLabel: surface.content["label"]?.stringValue,
            checklistItems: checklistItems,
            trendPoints: trendPoints,
            trendGoal: surface.content["goal"]?.stringValue,
            trendUnit: surface.content["unit"]?.stringValue,
            updatedAt: surface.updatedDate ?? .now
        )
    }

    private static func contentState(
        _ surface: BellwireNativeSurface
    ) -> BellwireActivityAttributes.ContentState {
        .init(
            title: surface.title,
            subtitle: surface.subtitle,
            value: surface.value,
            progress: surface.progress,
            type: surface.type,
            statusState: surface.statusState,
            statusLabel: surface.statusLabel,
            checklistItems: surface.checklistItems,
            trendPoints: surface.trendPoints,
            trendGoal: surface.trendGoal,
            trendUnit: surface.trendUnit,
            updatedAt: surface.updatedAt
        )
    }
}

enum NativeDisplayError: LocalizedError {
    case liveActivitiesDisabled

    var errorDescription: String? {
        switch self {
        case .liveActivitiesDisabled:
            String(localized: "Live Activities are disabled in iPhone Settings.")
        }
    }
}

private extension JSONEncoder {
    static var bellwireNative: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}
