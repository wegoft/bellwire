// SPDX-License-Identifier: MPL-2.0
import SwiftUI

enum AppLanguage: String, CaseIterable, Identifiable {
    static let storageKey = "bellwireAppLanguage"

    case system
    case english = "en"
    case simplifiedChinese = "zh-Hans"

    var id: String { rawValue }

    var locale: Locale {
        switch self {
        case .system: return .autoupdatingCurrent
        case .english: return Locale(identifier: "en")
        case .simplifiedChinese: return Locale(identifier: "zh-Hans")
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .system: return "Follow system"
        case .english: return "English"
        case .simplifiedChinese: return "Simplified Chinese"
        }
    }

    static func selected(from rawValue: String) -> AppLanguage {
        AppLanguage(rawValue: rawValue) ?? .system
    }
}

enum AppAppearance: String, CaseIterable, Identifiable {
    static let storageKey = "bellwireAppAppearance"

    case system
    case light
    case dark

    var id: String { rawValue }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .system: return "Follow system"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    static func selected(from rawValue: String) -> AppAppearance {
        AppAppearance(rawValue: rawValue) ?? .system
    }
}

enum BellwireDateFormatting {
    static func relative(
        _ date: Date,
        relativeTo referenceDate: Date = .now,
        locale: Locale,
        unitsStyle: RelativeDateTimeFormatter.UnitsStyle = .abbreviated,
        clampsNearNow: Bool = true
    ) -> String {
        let interval = date.timeIntervalSince(referenceDate)
        if clampsNearNow, abs(interval) < 30 {
            return String(localized: "Just now", locale: locale)
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = unitsStyle
        return formatter.localizedString(for: date, relativeTo: referenceDate)
    }

    static func headerDate(_ date: Date, locale: Locale) -> String {
        date.formatted(
            .dateTime
                .locale(locale)
                .weekday(.wide)
                .month(.abbreviated)
                .day()
        )
    }

    static func dateTime(_ date: Date, locale: Locale) -> String {
        date.formatted(
            Date.FormatStyle(date: .abbreviated, time: .standard)
                .locale(locale)
        )
    }
}
