// SPDX-License-Identifier: MPL-2.0
import SwiftUI
import UIKit

enum BellwireTheme {
    // MARK: Brand and semantic color roles

    static let brandOrange = Color(red: 233 / 255, green: 149 / 255, blue: 32 / 255)

    static let accent = adaptiveColor(
        light: UIColor(red: 0.74, green: 0.44, blue: 0.06, alpha: 1),
        dark: UIColor(red: 0.96, green: 0.66, blue: 0.18, alpha: 1)
    )
    static let accentInk = adaptiveColor(
        light: UIColor(red: 0.13, green: 0.09, blue: 0.04, alpha: 1),
        dark: UIColor(red: 0.13, green: 0.09, blue: 0.04, alpha: 1)
    )
    static let primaryButtonForeground = adaptiveColor(
        light: UIColor(red: 1.00, green: 0.97, blue: 0.91, alpha: 1),
        dark: UIColor(red: 1.00, green: 0.97, blue: 0.91, alpha: 1)
    )
    static let primaryButtonBackground = adaptiveColor(
        light: UIColor(red: 0.66, green: 0.36, blue: 0.03, alpha: 1),
        dark: UIColor(red: 0.62, green: 0.34, blue: 0.03, alpha: 1)
    )
    static let proActiveSurface = adaptiveColor(
        light: UIColor(red: 0.985, green: 0.955, blue: 0.89, alpha: 1),
        dark: UIColor(red: 0.235, green: 0.205, blue: 0.16, alpha: 1)
    )
    static let proActiveBorder = adaptiveColor(
        light: UIColor(red: 0.64, green: 0.38, blue: 0.09, alpha: 0.34),
        dark: UIColor(red: 0.95, green: 0.69, blue: 0.27, alpha: 0.48)
    )
    static let proActiveInk = adaptiveColor(
        light: UIColor(red: 0.56, green: 0.29, blue: 0.02, alpha: 1),
        dark: UIColor(red: 0.96, green: 0.66, blue: 0.18, alpha: 1)
    )
    static let background = adaptiveColor(
        light: UIColor(red: 0.955, green: 0.942, blue: 0.912, alpha: 1),
        dark: UIColor(red: 0.145, green: 0.139, blue: 0.129, alpha: 1)
    )
    static let surface = adaptiveColor(
        light: UIColor(red: 0.992, green: 0.982, blue: 0.956, alpha: 1),
        dark: UIColor(red: 0.195, green: 0.187, blue: 0.174, alpha: 1)
    )
    static let raisedSurface = adaptiveColor(
        light: UIColor(red: 0.925, green: 0.902, blue: 0.856, alpha: 1),
        dark: UIColor(red: 0.235, green: 0.224, blue: 0.207, alpha: 1)
    )
    static let tertiarySurface = adaptiveColor(
        light: UIColor(red: 0.875, green: 0.846, blue: 0.790, alpha: 1),
        dark: UIColor(red: 0.282, green: 0.267, blue: 0.245, alpha: 1)
    )
    static let ink = adaptiveColor(
        light: UIColor(red: 0.12, green: 0.112, blue: 0.10, alpha: 1),
        dark: UIColor(red: 0.97, green: 0.955, blue: 0.925, alpha: 1)
    )
    static let secondaryInk = adaptiveColor(
        light: UIColor(red: 0.37, green: 0.345, blue: 0.305, alpha: 1),
        dark: UIColor(red: 0.78, green: 0.745, blue: 0.69, alpha: 1)
    )
    static let mutedInk = adaptiveColor(
        light: UIColor(red: 0.45, green: 0.415, blue: 0.365, alpha: 1),
        dark: UIColor(red: 0.60, green: 0.57, blue: 0.52, alpha: 1)
    )
    static let separator = adaptiveColor(
        light: UIColor(red: 0.22, green: 0.18, blue: 0.12, alpha: 0.09),
        dark: UIColor(red: 0.56, green: 0.52, blue: 0.45, alpha: 0.22)
    )
    static let strongSeparator = adaptiveColor(
        light: UIColor.black.withAlphaComponent(0.16),
        dark: UIColor.white.withAlphaComponent(0.18)
    )
    static let live = adaptiveColor(
        light: UIColor(red: 0.15, green: 0.56, blue: 0.31, alpha: 1),
        dark: UIColor(red: 0.44, green: 0.86, blue: 0.53, alpha: 1)
    )
    static let success = adaptiveColor(
        light: UIColor(red: 0.12, green: 0.52, blue: 0.33, alpha: 1),
        dark: UIColor(red: 0.43, green: 0.83, blue: 0.58, alpha: 1)
    )
    static let warning = adaptiveColor(
        light: UIColor(red: 0.71, green: 0.43, blue: 0.05, alpha: 1),
        dark: UIColor(red: 0.95, green: 0.72, blue: 0.25, alpha: 1)
    )
    static let danger = adaptiveColor(
        light: UIColor(red: 0.72, green: 0.20, blue: 0.16, alpha: 1),
        dark: UIColor(red: 0.95, green: 0.39, blue: 0.32, alpha: 1)
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
            light: UIColor(red: 0.31, green: 0.24, blue: 0.14, alpha: 0.055),
            dark: UIColor.black.withAlphaComponent(0.12)
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
