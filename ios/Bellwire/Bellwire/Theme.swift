// SPDX-License-Identifier: MPL-2.0
import SwiftUI
import UIKit

enum BellwireTheme {
    // MARK: Brand and semantic color roles

    static let brandOrange = Color(red: 245 / 255, green: 161 / 255, blue: 26 / 255)

    static let accent = adaptiveColor(
        light: UIColor(red: 0.66, green: 0.35, blue: 0.00, alpha: 1),
        dark: UIColor(red: 0.96, green: 0.63, blue: 0.10, alpha: 1)
    )
    static let accentInk = adaptiveColor(
        light: UIColor(red: 0.04, green: 0.06, blue: 0.15, alpha: 1),
        dark: UIColor(red: 0.04, green: 0.06, blue: 0.15, alpha: 1)
    )
    static let primaryButtonForeground = adaptiveColor(
        light: UIColor(red: 0.04, green: 0.06, blue: 0.15, alpha: 1),
        dark: UIColor(red: 0.04, green: 0.06, blue: 0.15, alpha: 1)
    )
    static let primaryButtonBackground = adaptiveColor(
        light: UIColor(red: 0.96, green: 0.63, blue: 0.10, alpha: 1),
        dark: UIColor(red: 0.96, green: 0.63, blue: 0.10, alpha: 1)
    )
    static let proActiveInk = adaptiveColor(
        light: UIColor(red: 0.66, green: 0.35, blue: 0.00, alpha: 1),
        dark: UIColor(red: 1.00, green: 0.77, blue: 0.36, alpha: 1)
    )
    static let background = adaptiveColor(
        light: UIColor(red: 0.96, green: 0.97, blue: 0.98, alpha: 1),
        dark: UIColor(red: 0.04, green: 0.06, blue: 0.15, alpha: 1)
    )
    static let surface = adaptiveColor(
        light: UIColor(red: 1.00, green: 1.00, blue: 1.00, alpha: 1),
        dark: UIColor(red: 0.07, green: 0.09, blue: 0.20, alpha: 1)
    )
    static let raisedSurface = adaptiveColor(
        light: UIColor(red: 0.93, green: 0.94, blue: 0.97, alpha: 1),
        dark: UIColor(red: 0.10, green: 0.13, blue: 0.25, alpha: 1)
    )
    static let tertiarySurface = adaptiveColor(
        light: UIColor(red: 0.88, green: 0.90, blue: 0.94, alpha: 1),
        dark: UIColor(red: 0.13, green: 0.16, blue: 0.30, alpha: 1)
    )
    static let ink = adaptiveColor(
        light: UIColor(red: 0.09, green: 0.10, blue: 0.18, alpha: 1),
        dark: UIColor(red: 0.97, green: 0.97, blue: 1.00, alpha: 1)
    )
    static let secondaryInk = adaptiveColor(
        light: UIColor(red: 0.25, green: 0.27, blue: 0.38, alpha: 1),
        dark: UIColor(red: 0.84, green: 0.85, blue: 0.91, alpha: 1)
    )
    static let mutedInk = adaptiveColor(
        light: UIColor(red: 0.41, green: 0.44, blue: 0.54, alpha: 1),
        dark: UIColor(red: 0.58, green: 0.61, blue: 0.72, alpha: 1)
    )
    static let separator = adaptiveColor(
        light: UIColor(red: 0.84, green: 0.85, blue: 0.91, alpha: 1),
        dark: UIColor(red: 0.17, green: 0.20, blue: 0.35, alpha: 1)
    )
    static let strongSeparator = adaptiveColor(
        light: UIColor(red: 0.72, green: 0.75, blue: 0.82, alpha: 1),
        dark: UIColor(red: 0.23, green: 0.27, blue: 0.44, alpha: 1)
    )
    static let live = adaptiveColor(
        light: UIColor(red: 0.05, green: 0.47, blue: 0.31, alpha: 1),
        dark: UIColor(red: 0.21, green: 0.79, blue: 0.55, alpha: 1)
    )
    static let success = adaptiveColor(
        light: UIColor(red: 0.05, green: 0.47, blue: 0.31, alpha: 1),
        dark: UIColor(red: 0.21, green: 0.79, blue: 0.55, alpha: 1)
    )
    static let warning = adaptiveColor(
        light: UIColor(red: 0.60, green: 0.38, blue: 0.00, alpha: 1),
        dark: UIColor(red: 0.96, green: 0.77, blue: 0.33, alpha: 1)
    )
    static let danger = adaptiveColor(
        light: UIColor(red: 0.79, green: 0.22, blue: 0.26, alpha: 1),
        dark: UIColor(red: 1.00, green: 0.38, blue: 0.42, alpha: 1)
    )

    static var amberGlow: RadialGradient {
        RadialGradient(
            colors: [accent.opacity(0.22), accent.opacity(0.06), .clear],
            center: .topTrailing,
            startRadius: 8,
            endRadius: 260
        )
    }

    static var amberGlowLeading: RadialGradient {
        RadialGradient(
            colors: [accent.opacity(0.09), accent.opacity(0.025), .clear],
            center: .bottomLeading,
            startRadius: 4,
            endRadius: 210
        )
    }

    static var cardShadow: Color {
        adaptiveColor(
            light: UIColor(red: 0.04, green: 0.06, blue: 0.15, alpha: 0.08),
            dark: UIColor(red: 0.01, green: 0.02, blue: 0.08, alpha: 0.32)
        )
    }

    private static func adaptiveColor(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }
}

enum BellwireTypography {
    static let hero = Font.system(.largeTitle, design: .serif, weight: .regular)
    static let pageTitle = Font.system(.largeTitle, design: .serif, weight: .regular)
    static let sectionTitle = Font.system(.subheadline, design: .default, weight: .semibold)
    static let technicalLabel = Font.system(size: 10, weight: .medium, design: .monospaced)
    static let technical = Font.system(size: 11, weight: .regular, design: .monospaced)
    static let technicalStrong = Font.system(size: 11, weight: .semibold, design: .monospaced)
    static let metric = Font.system(.title, design: .serif, weight: .regular)
    static let cardTitle = Font.system(size: 13, weight: .semibold, design: .default)
    static let metadata = Font.system(size: 11, weight: .regular, design: .default)
    static let microLabel = Font.system(size: 9, weight: .medium, design: .monospaced)
    static let microMetric = Font.system(.title3, design: .serif, weight: .regular)
}

enum BellwireSpacing {
    static let micro: CGFloat = 4
    static let compact: CGFloat = 8
    static let small: CGFloat = 12
    static let standard: CGFloat = 16
    static let roomy: CGFloat = 20
    static let section: CGFloat = 28
    static let page: CGFloat = 24
    static let large: CGFloat = 36
}

enum BellwireRadius {
    static let small: CGFloat = 8
    static let control: CGFloat = 14
    static let card: CGFloat = 20
    static let largeCard: CGFloat = 24
    static let hero: CGFloat = 32
}

enum BellwireShadow {
    static var cardColor: Color { BellwireTheme.cardShadow }
    static let cardRadius: CGFloat = 8
    static let cardY: CGFloat = 3
}

enum BellwireAnimation {
    static let quick = Animation.easeOut(duration: 0.15)
    static let standard = Animation.easeOut(duration: 0.25)
    static let spring = Animation.spring(response: 0.34, dampingFraction: 0.88)
    static let mascotArrival = Animation.spring(response: 0.48, dampingFraction: 0.86)
}

enum BellwireHaptics {
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func error() {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }

    static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }
}

struct PressableButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(reduceMotion ? nil : BellwireAnimation.quick, value: configuration.isPressed)
    }
}

private struct BellwireSurfaceModifier: ViewModifier {
    let radius: CGFloat
    let elevated: Bool

    func body(content: Content) -> some View {
        content
            .background(
                BellwireTheme.surface,
                in: RoundedRectangle(cornerRadius: radius, style: .continuous)
            )
            .shadow(
                color: elevated ? BellwireShadow.cardColor : .clear,
                radius: elevated ? BellwireShadow.cardRadius : 0,
                y: elevated ? BellwireShadow.cardY : 0
            )
    }
}

extension View {
    func bellwireSurface(radius: CGFloat = BellwireRadius.card, elevated: Bool = false) -> some View {
        modifier(BellwireSurfaceModifier(radius: radius, elevated: elevated))
    }

    func bellwireListGroup() -> some View {
        bellwireSurface(radius: BellwireRadius.card, elevated: false)
            .overlay {
                RoundedRectangle(cornerRadius: BellwireRadius.card, style: .continuous)
                    .stroke(BellwireTheme.separator, lineWidth: 1)
            }
    }

    func bellwireFeatureSurface() -> some View {
        bellwireSurface(radius: BellwireRadius.card, elevated: true)
    }

    func bellwirePageBackground() -> some View {
        background(BellwireTheme.background.ignoresSafeArea())
    }

    func bellwireTechnicalLabel() -> some View {
        font(BellwireTypography.technicalLabel)
            .textCase(.uppercase)
            .tracking(1.8)
            .foregroundStyle(BellwireTheme.mutedInk)
    }
}
