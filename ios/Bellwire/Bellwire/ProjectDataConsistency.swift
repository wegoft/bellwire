// SPDX-License-Identifier: MPL-2.0
import Foundation

enum ProjectDataConsistency {
    static func mergeProjects(
        cloud: [ProjectSummary],
        fallbacks: [ProjectSummary]
    ) -> [ProjectSummary] {
        var merged: [ProjectSummary] = []
        var indexes: [String: Int] = [:]

        for project in fallbacks + cloud {
            if let index = indexes[project.id] {
                merged[index] = project
            } else {
                indexes[project.id] = merged.count
                merged.append(project)
            }
        }
        return merged
    }

    static func normalizeSurfaces(
        _ surfaces: [LiveSurfaceRecord],
        projects: [ProjectSummary]
    ) -> [LiveSurfaceRecord] {
        let projectsByID = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })
        return surfaces.map { surface in
            guard let project = projectsByID[surface.projectId] else { return surface }
            return LiveSurfaceRecord(
                id: surface.id,
                projectId: surface.projectId,
                surfaceKey: surface.surfaceKey,
                type: surface.type,
                title: surface.title,
                subtitle: surface.subtitle,
                content: surface.content,
                action: surface.action,
                displayOrder: surface.displayOrder,
                version: surface.version,
                createdAt: surface.createdAt,
                updatedAt: surface.updatedAt,
                project: eventProject(from: project)
            )
        }
    }

    static func normalizeEvents(
        _ events: [InboxEvent],
        projects: [ProjectSummary]
    ) -> [InboxEvent] {
        let projectsByID = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })
        return events.map { event in
            guard let project = projectsByID[event.projectId] else { return event }
            return InboxEvent(
                id: event.id,
                projectId: event.projectId,
                eventType: event.eventType,
                data: event.data,
                occurredAt: event.occurredAt,
                receivedAt: event.receivedAt,
                status: event.status,
                readAt: event.readAt,
                project: eventProject(from: project),
                sensitiveFields: event.sensitiveFields
            )
        }
    }

    private static func eventProject(from project: ProjectSummary) -> EventProject {
        EventProject(
            id: project.id,
            name: project.name,
            icon: project.icon,
            logoUrl: project.logoUrl
        )
    }
}
