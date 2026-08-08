// SPDX-License-Identifier: MPL-2.0
import Foundation

@main
struct ProjectOverviewSurfaceCheck {
    static func main() throws {
        let cloudDemo = surface(
            id: "cloud-demo",
            projectID: "private-project",
            key: "demo-status"
        )
        let directRevenue = surface(
            id: "direct-revenue",
            projectID: "private-project",
            key: "revenue-today"
        )
        let otherProjectSurface = surface(
            id: "other-project",
            projectID: "other-project",
            key: "other-status"
        )

        let privateOverview = overview(
            id: "private-project",
            deliveryMode: .private,
            liveSurfaces: [cloudDemo]
        ).resolvingDetailLiveSurfaces(
            from: [otherProjectSurface, directRevenue]
        )
        guard privateOverview.liveSurfaces == [directRevenue] else {
            throw SurfaceResolutionError.privateProjectDidNotUseDirectSurfaces
        }

        let hostedOverview = overview(
            id: "hosted-project",
            deliveryMode: .hosted,
            liveSurfaces: [cloudDemo]
        ).resolvingDetailLiveSurfaces(from: [directRevenue])
        guard hostedOverview.liveSurfaces == [cloudDemo] else {
            throw SurfaceResolutionError.hostedProjectDidNotKeepCloudSurfaces
        }
    }

    private static func overview(
        id: String,
        deliveryMode: ProjectDeliveryMode,
        liveSurfaces: [LiveSurfaceRecord]
    ) -> ProjectOverview {
        ProjectOverview(
            id: id,
            name: "Project",
            slug: "project",
            icon: "bolt",
            logoUrl: nil,
            displayOrder: 0,
            category: "automation",
            status: "active",
            deliveryMode: deliveryMode,
            endpoint: "https://example.com",
            createdAt: "2026-08-05T00:00:00Z",
            updatedAt: "2026-08-05T00:00:00Z",
            eventSchemas: [],
            notificationSurfaces: [],
            liveSurfaces: liveSurfaces,
            deliveryHealth: DeliveryHealth(
                queued: 0,
                accepted: 0,
                failed: 0,
                status: "healthy"
            ),
            privateReadiness: PrivateReadinessSummary(
                readyDevices: 1,
                activeDevices: 1,
                connections: []
            )
        )
    }

    private static func surface(
        id: String,
        projectID: String,
        key: String
    ) -> LiveSurfaceRecord {
        LiveSurfaceRecord(
            id: id,
            projectId: projectID,
            surfaceKey: key,
            type: "metric",
            title: key,
            subtitle: nil,
            content: [:],
            action: nil,
            displayOrder: 0,
            version: 1,
            createdAt: "2026-08-05T00:00:00Z",
            updatedAt: "2026-08-05T00:00:00Z",
            project: nil
        )
    }
}

private enum SurfaceResolutionError: Error {
    case privateProjectDidNotUseDirectSurfaces
    case hostedProjectDidNotKeepCloudSurfaces
}
