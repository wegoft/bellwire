// SPDX-License-Identifier: MPL-2.0
import XCTest
@testable import Bellwire

final class EntitlementCapabilityTests: XCTestCase {
    func testLegacyWidgetSnapshotDecodesWithoutProjectLogoFilename() throws {
        let json = """
        {
          "isPro": true,
          "updatedAt": "2026-08-11T00:00:00Z",
          "surfaces": [{
            "id": "surface-1",
            "projectID": "project-1",
            "projectName": "VideoSays",
            "projectIcon": "play.rectangle.fill",
            "surfaceKey": "revenue-today",
            "type": "stats",
            "title": "Today",
            "checklistItems": [],
            "trendPoints": [],
            "updatedAt": "2026-08-11T00:00:00Z"
          }]
        }
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let snapshot = try decoder.decode(
            BellwireWidgetSnapshot.self,
            from: Data(json.utf8)
        )

        XCTAssertNil(snapshot.surfaces.first?.projectLogoFilename)
    }

    func testSelfHostedCapabilitiesEnableFeaturesWithoutBilling() {
        let entitlement = makeEntitlement(
            plan: "pro",
            deployment: "self_hosted",
            capabilities: EntitlementCapabilities(
                billing: "disabled",
                commercialLimitsEnforced: false,
                projectExport: true,
                liveActivities: true
            )
        )

        XCTAssertTrue(entitlement.isSelfHosted)
        XCTAssertTrue(entitlement.hasPro)
        XCTAssertTrue(entitlement.canExportProjects)
        XCTAssertTrue(entitlement.canUseLiveActivities)
        XCTAssertFalse(entitlement.billingEnabled)
        XCTAssertEqual(entitlement.planDisplayName, "Self-hosted")
    }

    func testHostedFreeCapabilitiesRemainRestricted() {
        let entitlement = makeEntitlement(
            plan: "free",
            deployment: "hosted",
            capabilities: EntitlementCapabilities(
                billing: "app_store",
                commercialLimitsEnforced: true,
                projectExport: false,
                liveActivities: false
            )
        )

        XCTAssertFalse(entitlement.hasPro)
        XCTAssertFalse(entitlement.canExportProjects)
        XCTAssertFalse(entitlement.canUseLiveActivities)
        XCTAssertTrue(entitlement.billingEnabled)
        XCTAssertEqual(entitlement.planDisplayName, "Free")
    }

    func testOlderProResponseUsesBackwardsCompatibleFeatureFallbacks() {
        let entitlement = makeEntitlement(plan: "pro")

        XCTAssertTrue(entitlement.hasPro)
        XCTAssertTrue(entitlement.canExportProjects)
        XCTAssertTrue(entitlement.canUseLiveActivities)
        XCTAssertTrue(entitlement.billingEnabled)
    }

    private func makeEntitlement(
        plan: String,
        deployment: String? = nil,
        capabilities: EntitlementCapabilities? = nil
    ) -> AccountEntitlement {
        AccountEntitlement(
            plan: plan,
            status: "active",
            deployment: deployment,
            capabilities: capabilities,
            productId: nil,
            expiresAt: nil,
            downgradeDeadline: nil,
            limits: PlanLimits(
                activeProjects: 1,
                activeDevices: 1,
                monthlySignals: 100,
                courtesySignals: 110,
                ingestPerMinute: 60,
                hostedRetentionDays: 7,
                surfacesPerProject: 3
            ),
            usage: SignalUsage(
                periodStart: "2026-08-01T00:00:00.000Z",
                periodEnd: "2026-09-01T00:00:00.000Z",
                acceptedSignals: 0,
                remainingSignals: 100,
                courtesyRemainingSignals: 110
            ),
            activeProjects: 0,
            activeDevices: 0
        )
    }
}
