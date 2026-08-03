// SPDX-License-Identifier: MPL-2.0
import Foundation

@main
struct LocalizationCheck {
    static func main() throws {
        let reference = Date(timeIntervalSince1970: 1_753_200_000)
        let earlier = reference.addingTimeInterval(-2 * 60 * 60)
        let english = BellwireDateFormatting.relative(
            earlier,
            relativeTo: reference,
            locale: Locale(identifier: "en")
        )
        let chinese = BellwireDateFormatting.relative(
            earlier,
            relativeTo: reference,
            locale: Locale(identifier: "zh-Hans")
        )

        guard english != chinese, english.lowercased().contains("ago"), chinese.contains("前") else {
            throw LocalizationCheckError.localeWasIgnored(english: english, chinese: chinese)
        }

        let nearFuture = BellwireDateFormatting.relative(
            reference.addingTimeInterval(5),
            relativeTo: reference,
            locale: Locale(identifier: "zh-Hans")
        )
        let nearPast = BellwireDateFormatting.relative(
            reference.addingTimeInterval(-5),
            relativeTo: reference,
            locale: Locale(identifier: "zh-Hans")
        )
        let actualFuture = BellwireDateFormatting.relative(
            reference.addingTimeInterval(2 * 60),
            relativeTo: reference,
            locale: Locale(identifier: "zh-Hans")
        )
        let directionalNearFuture = BellwireDateFormatting.relative(
            reference.addingTimeInterval(5),
            relativeTo: reference,
            locale: Locale(identifier: "zh-Hans"),
            clampsNearNow: false
        )
        let directionalNearPast = BellwireDateFormatting.relative(
            reference.addingTimeInterval(-5),
            relativeTo: reference,
            locale: Locale(identifier: "zh-Hans"),
            clampsNearNow: false
        )
        let boundaryFuture = BellwireDateFormatting.relative(
            reference.addingTimeInterval(30),
            relativeTo: reference,
            locale: Locale(identifier: "zh-Hans")
        )
        let boundaryPast = BellwireDateFormatting.relative(
            reference.addingTimeInterval(-30),
            relativeTo: reference,
            locale: Locale(identifier: "zh-Hans")
        )
        guard nearFuture == nearPast,
              !nearFuture.contains("后"),
              !nearPast.contains("前"),
              actualFuture.contains("后") else {
            throw LocalizationCheckError.nearNowWasNotClamped(
                nearFuture: nearFuture,
                nearPast: nearPast,
                actualFuture: actualFuture
            )
        }
        guard directionalNearFuture.contains("后"),
              directionalNearPast.contains("前"),
              boundaryFuture.contains("后"),
              boundaryPast.contains("前") else {
            throw LocalizationCheckError.directionalRelativeFormattingFailed
        }

        guard AppAppearance.selected(from: "dark") == .dark,
              AppAppearance.selected(from: "unsupported") == .system else {
            throw LocalizationCheckError.appearanceSelectionFailed
        }
    }
}

enum LocalizationCheckError: Error {
    case localeWasIgnored(english: String, chinese: String)
    case nearNowWasNotClamped(nearFuture: String, nearPast: String, actualFuture: String)
    case directionalRelativeFormattingFailed
    case appearanceSelectionFailed
}
