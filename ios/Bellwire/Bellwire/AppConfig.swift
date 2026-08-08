// SPDX-License-Identifier: MPL-2.0
import Foundation

enum AppConfig {
    enum BillingMode: String {
        case appStore = "app_store"
        case disabled
    }

    static let apiBaseURL = requiredURL(for: "BellwireAPIBaseURL")
    static let authBaseURL = requiredURL(for: "BellwireAuthBaseURL")
    static let displayName = requiredValue(for: "CFBundleDisplayName")
    static let supportEmail = requiredValue(for: "BellwireSupportEmail")
    static let privacyURL = requiredURL(for: "BellwirePrivacyURL")
    static let termsURL = requiredURL(for: "BellwireTermsURL")
    static let supportURL = requiredURL(for: "BellwireSupportURL")
    static let keychainService = "\(Bundle.main.bundleIdentifier ?? "app.bellwire").session"
    static let sharedDirectKeychainService = "\(Bundle.main.bundleIdentifier ?? "app.bellwire").direct-shared"
    static let keychainAccessGroup = requiredValue(for: "BellwireKeychainAccessGroup")
    static let urlScheme = requiredValue(for: "BellwireURLScheme")
    static let billingMode = requiredBillingMode()
    static let monthlyProductID = requiredValue(for: "BellwireProMonthlyProductID")
    static let yearlyProductID = requiredValue(for: "BellwireProYearlyProductID")

    static var billingEnabled: Bool { billingMode == .appStore }
    static var hostedServiceDisplayName: String {
        billingEnabled ? "Bellwire Cloud" : "\(displayName) server"
    }

    static func branded(
        _ value: String.LocalizationValue,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        String(localized: value, locale: locale)
            .replacingOccurrences(of: "Bellwire Cloud", with: hostedServiceDisplayName)
            .replacingOccurrences(of: "Bellwire", with: displayName)
    }

    private static func requiredBillingMode() -> BillingMode {
        let value = requiredValue(for: "BellwireBillingMode")
        guard let mode = BillingMode(rawValue: value) else {
            preconditionFailure("Invalid BellwireBillingMode: \(value)")
        }
        return mode
    }

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
