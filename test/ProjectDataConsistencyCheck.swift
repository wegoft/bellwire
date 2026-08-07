// SPDX-License-Identifier: MPL-2.0
import Foundation

@main
struct ProjectDataConsistencyCheck {
    static func main() throws {
        let direct = project(
            name: "Manifest name",
            icon: "bolt",
            logoURL: "https://direct.example/logo.png",
            status: "active"
        )
        let cloud = project(
            name: "Cloud name",
            icon: "cloud",
            logoURL: "https://cloud.example/logo.png",
            status: "paused"
        )
        let merged = ProjectDataConsistency.mergeProjects(
            cloud: [cloud],
            fallbacks: [direct]
        )
        guard merged == [cloud] else {
            throw ConsistencyCheckError.cloudProjectDidNotWin
        }
        let staleProject = EventProject(
            id: direct.id,
            name: direct.name,
            icon: direct.icon,
            logoUrl: direct.logoUrl
        )
        let surface = LiveSurfaceRecord(
            id: "surface-1",
            projectId: cloud.id,
            surfaceKey: "build",
            type: "progress",
            title: "Build",
            subtitle: nil,
            content: ["percentage": .number(42)],
            action: nil,
            displayOrder: 0,
            version: 1,
            createdAt: "2026-08-07T00:00:00Z",
            updatedAt: "2026-08-07T00:01:00Z",
            project: staleProject
        )
        let normalizedSurface = ProjectDataConsistency.normalizeSurfaces(
            [surface],
            projects: merged
        )[0]
        guard normalizedSurface.project == EventProject(
            id: cloud.id,
            name: cloud.name,
            icon: cloud.icon,
            logoUrl: cloud.logoUrl
        ) else {
            throw ConsistencyCheckError.surfaceProjectWasNotNormalized
        }

        let event = InboxEvent(
            id: "event-1",
            projectId: cloud.id,
            eventType: "build.completed",
            data: [:],
            occurredAt: "2026-08-07T00:01:00Z",
            receivedAt: "2026-08-07T00:01:00Z",
            status: "accepted",
            readAt: nil,
            project: staleProject,
            sensitiveFields: []
        )
        let normalizedEvent = ProjectDataConsistency.normalizeEvents(
            [event],
            projects: merged
        )[0]
        guard normalizedEvent.project.name == cloud.name,
              normalizedEvent.project.icon == cloud.icon,
              normalizedEvent.project.logoUrl == cloud.logoUrl
        else {
            throw ConsistencyCheckError.eventProjectWasNotNormalized
        }
    }

    private static func project(
        name: String,
        icon: String,
        logoURL: String,
        status: String
    ) -> ProjectSummary {
        ProjectSummary(
            id: "project-1",
            name: name,
            slug: "project-1",
            icon: icon,
            logoUrl: logoURL,
            displayOrder: 0,
            category: "automation",
            status: status,
            deliveryMode: .private,
            endpoint: "https://direct.example",
            createdAt: "2026-08-07T00:00:00Z",
            updatedAt: "2026-08-07T00:01:00Z"
        )
    }
}

private enum ConsistencyCheckError: Error {
    case cloudProjectDidNotWin
    case surfaceProjectWasNotNormalized
    case eventProjectWasNotNormalized
}
