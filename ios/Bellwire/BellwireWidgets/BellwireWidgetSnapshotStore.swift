// SPDX-License-Identifier: MPL-2.0
import Foundation

struct BellwireWidgetSnapshotStore {
    static let empty = BellwireWidgetSnapshot(isPro: false, updatedAt: .now, surfaces: [])

    static let preview = BellwireWidgetSnapshot(
        isPro: true,
        updatedAt: .now,
        surfaces: [
            BellwireNativeSurface(
                id: "preview-today",
                projectID: "preview-project",
                projectName: "VideoSays",
                projectIcon: "play.rectangle.fill",
                projectLogoFilename: nil,
                surfaceKey: "revenue-today",
                type: "stats",
                title: "Today · VideoSays",
                subtitle: "Shanghai time · Aug 9 · 4 fulfilled orders",
                value: "¥108.80",
                progress: nil,
                statusState: nil,
                statusLabel: nil,
                checklistItems: [],
                trendPoints: [],
                trendGoal: nil,
                trendUnit: nil,
                updatedAt: .now
            ),
            BellwireNativeSurface(
                id: "preview-trend",
                projectID: "preview-project",
                projectName: "VideoSays",
                projectIcon: "play.rectangle.fill",
                projectLogoFilename: nil,
                surfaceKey: "revenue-30d",
                type: "trend",
                title: "CNY revenue trend · VideoSays",
                subtitle: "30 days · 28 fulfilled orders",
                value: "¥108.80",
                progress: nil,
                statusState: nil,
                statusLabel: nil,
                checklistItems: [],
                trendPoints: [
                    .init(label: "Aug 5", value: 32),
                    .init(label: "Aug 6", value: 48),
                    .init(label: "Aug 7", value: 41),
                    .init(label: "Aug 8", value: 66),
                    .init(label: "Aug 9", value: 108.8)
                ],
                trendGoal: "up",
                trendUnit: "CNY",
                updatedAt: .now
            )
        ]
    )

    static func read() -> BellwireWidgetSnapshot? {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroup
        ),
        let data = try? Data(contentsOf: container.appending(path: snapshotFilename))
        else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(BellwireWidgetSnapshot.self, from: data)
    }

    static func projectURL(_ projectID: String?) -> URL? {
        guard let projectID, !projectID.isEmpty else {
            return URL(string: "\(urlScheme)://home")
        }
        return URL(string: "\(urlScheme)://projects/\(projectID)")
    }

    static func projectLogoData(filename: String?) -> Data? {
        guard let filename,
              isValidProjectLogoFilename(filename),
              let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: appGroup
              )
        else {
            return nil
        }
        let fileURL = container
            .appending(path: projectLogoDirectory, directoryHint: .isDirectory)
            .appending(path: filename)
        guard let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe),
              data.count <= maximumProjectLogoBytes
        else {
            return nil
        }
        return data
    }

    static var appDisplayName: String {
        Bundle.main.object(forInfoDictionaryKey: "BellwireAppDisplayName") as? String
            ?? "Bellwire"
    }

    private static let snapshotFilename = "bellwire-widget-snapshot.json"
    private static let projectLogoDirectory = "WidgetProjectLogos"
    private static let maximumProjectLogoBytes = 1 * 1_024 * 1_024

    private static func isValidProjectLogoFilename(_ filename: String) -> Bool {
        guard filename.count == 68, filename.hasSuffix(".png") else { return false }
        return filename.dropLast(4).allSatisfy { character in
            character.isHexDigit && (character.isNumber || character.isLowercase)
        }
    }

    private static var appGroup: String {
        Bundle.main.object(forInfoDictionaryKey: "BellwireAppGroup") as? String
            ?? "group.app.bellwire.shared"
    }

    private static var urlScheme: String {
        Bundle.main.object(forInfoDictionaryKey: "BellwireURLScheme") as? String
            ?? "bellwire"
    }
}
