// SPDX-License-Identifier: MPL-2.0
import ActivityKit
import Foundation

struct BellwireNativeSurface: Codable, Hashable, Identifiable {
    struct ChecklistItem: Codable, Hashable, Identifiable {
        let id: String
        let title: String
        let state: String
    }

    struct TrendPoint: Codable, Hashable {
        let label: String
        let value: Double
    }

    let id: String
    let projectID: String
    let projectName: String
    let projectIcon: String
    let projectLogoFilename: String?
    let surfaceKey: String
    let type: String
    let title: String
    let subtitle: String?
    let value: String?
    let progress: Double?
    let statusState: String?
    let statusLabel: String?
    let checklistItems: [ChecklistItem]
    let trendPoints: [TrendPoint]
    let trendGoal: String?
    let trendUnit: String?
    let updatedAt: Date
}

struct BellwireWidgetSnapshot: Codable {
    let isPro: Bool
    let updatedAt: Date
    let surfaces: [BellwireNativeSurface]
}

struct BellwireActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let title: String
        let subtitle: String?
        let value: String?
        let progress: Double?
        let type: String?
        let statusState: String?
        let statusLabel: String?
        let checklistItems: [BellwireNativeSurface.ChecklistItem]?
        let trendPoints: [BellwireNativeSurface.TrendPoint]?
        let trendGoal: String?
        let trendUnit: String?
        let updatedAt: Date
    }

    let surfaceID: String
    let projectName: String
    let projectIcon: String
    let projectID: String?
    let surfaceKey: String?
    let sessionID: String?
    let origin: String?
    let deliveryMode: String?
}
