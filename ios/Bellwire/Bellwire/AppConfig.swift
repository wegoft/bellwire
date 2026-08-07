// SPDX-License-Identifier: MPL-2.0
import Foundation

enum AppConfig {
    static let apiBaseURL = requiredURL(for: "BellwireAPIBaseURL")
    static let authBaseURL = requiredURL(for: "BellwireAuthBaseURL")
    static let keychainService = "\(Bundle.main.bundleIdentifier ?? "app.bellwire").session"
    static let sharedDirectKeychainService = "app.bellwire.direct-shared"
    static let keychainAccessGroup = requiredValue(for: "BellwireKeychainAccessGroup")
    static let urlScheme = requiredValue(for: "BellwireURLScheme")

    private static func requiredURL(for key: String) -> URL {
        let value = requiredValue(for: key)
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              url.host != nil else {
            preconditionFailure("Invalid URL for \(key)")
        }
        return url
    }

    private static func requiredValue(for key: String) -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            preconditionFailure("Missing \(key) in Info.plist")
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$("), !trimmed.contains("YOUR_") else {
            preconditionFailure("Unresolved build configuration for \(key)")
        }
        return trimmed
    }
}
