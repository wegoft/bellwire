// SPDX-License-Identifier: MPL-2.0
import StoreKit
import SwiftUI

struct PaywallView: View {
    @EnvironmentObject private var purchaseManager: PurchaseManager
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @Environment(\.openURL) private var openURL
    @State private var selectedPlan = BellwirePurchasePlan.yearly
    @State private var appeared = false

    let appAccountToken: UUID?

    private let benefits: [(icon: String, title: String)] = [
        ("square.grid.2x2", "20 projects · 50,000 monthly Signals"),
        ("clock.arrow.circlepath", "90-day history · 3 iPhones in sync"),
        ("rectangle.stack.badge.play", "Unlimited Surfaces per project · Live Activities · export"),
    ]

    var body: some View {
        ZStack {
            BellwireTheme.background.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 0) {
                    topBar
                        .paywallEntrance(appeared: appeared, delay: 0, reduceMotion: reduceMotion)

                    hero
                        .padding(.top, BellwireSpacing.roomy)
                        .paywallEntrance(appeared: appeared, delay: 0.06, reduceMotion: reduceMotion)

                    benefitCard
                        .padding(.top, BellwireSpacing.page)
                        .paywallEntrance(appeared: appeared, delay: 0.12, reduceMotion: reduceMotion)

                    planOptions
                        .padding(.top, BellwireSpacing.roomy)
                        .paywallEntrance(appeared: appeared, delay: 0.16, reduceMotion: reduceMotion)

                    footer
                        .padding(.top, BellwireSpacing.roomy)
                        .paywallEntrance(appeared: appeared, delay: 0.22, reduceMotion: reduceMotion)
                }
                .padding(.horizontal, BellwireSpacing.roomy)
                .padding(.top, BellwireSpacing.compact)
                .padding(.bottom, BellwireSpacing.section)
            }
            .scrollIndicators(.hidden)
        }
        .safeAreaInset(edge: .bottom) {
            purchaseButton
                .padding(.horizontal, BellwireSpacing.roomy)
                .padding(.top, BellwireSpacing.small)
                .padding(.bottom, BellwireSpacing.compact)
                .background(.ultraThinMaterial)
                .paywallEntrance(appeared: appeared, delay: 0.18, reduceMotion: reduceMotion)
        }
        .task {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.38)) {
                appeared = true
            }
            await model.captureProductEvent("paywall_viewed", source: "ios")
            await purchaseManager.prepare()
        }
        .onChange(of: purchaseManager.hasPro) { _, hasPro in
            if hasPro { dismiss() }
        }
    }

    private var topBar: some View {
        ZStack {
            Text(localized("Bellwire Pro"))
                .font(.headline.weight(.semibold))
                .foregroundStyle(BellwireTheme.ink)

            HStack {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(BellwireTheme.accent)
                        .frame(width: 46, height: 46)
                        .background(
                            BellwireTheme.accent.opacity(0.10),
                            in: Circle()
                        )
                        .overlay {
                            Circle()
                                .stroke(BellwireTheme.accent.opacity(0.42), lineWidth: 1)
                        }
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel(localized("Close"))

                Spacer()
            }
        }
        .frame(minHeight: 48)
    }

    private var hero: some View {
        VStack(spacing: BellwireSpacing.small) {
            BellwireMark(size: 76)

            Text(localized("More room for every signal."))
                .font(.system(.title2, design: .serif, weight: .semibold))
                .foregroundStyle(BellwireTheme.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Text(localized("Pro expands Hosted capacity and history. Private delivery and 30 days on this iPhone stay free."))
                .font(.subheadline)
                .foregroundStyle(BellwireTheme.secondaryInk)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
    }

    private var benefitCard: some View {
        VStack(spacing: 0) {
            ForEach(Array(benefits.enumerated()), id: \.offset) { index, benefit in
                HStack(spacing: BellwireSpacing.small) {
                    Image(systemName: benefit.icon)
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(BellwireTheme.accent)
                        .frame(width: 26)

                    Text(localized(benefit.title))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(BellwireTheme.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(BellwireTheme.accent)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 45)

                if index < benefits.count - 1 {
                    Divider()
                        .overlay(BellwireTheme.separator)
                        .padding(.leading, 38)
                }
            }
        }
        .padding(.horizontal, BellwireSpacing.standard)
        .padding(.vertical, BellwireSpacing.compact)
        .background(
            BellwireTheme.surface.opacity(0.92),
            in: RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)
                .stroke(BellwireTheme.strongSeparator.opacity(0.48), lineWidth: 1)
        }
        .shadow(color: BellwireTheme.cardShadow, radius: BellwireShadow.cardRadius, y: BellwireShadow.cardY)
    }

    private var planOptions: some View {
        VStack(spacing: BellwireSpacing.small) {
            ForEach(BellwirePurchasePlan.allCases) { plan in
                Button {
                    selectedPlan = plan
                    BellwireHaptics.selection()
                } label: {
                    PaywallPlanRow(
                        plan: plan,
                        product: purchaseManager.product(for: plan),
                        monthlyProduct: purchaseManager.product(for: .monthly),
                        isSelected: selectedPlan == plan,
                        showsTrial: purchaseManager.isTrialEligible(for: plan)
                            || (Self.isScreenshotPreview && plan == .yearly),
                        previewPrice: Self.isScreenshotPreview ? plan.previewPrice : nil,
                        previewMonthlyEquivalent: Self.isScreenshotPreview && plan == .yearly
                            ? String(localized: "$2.50", locale: locale)
                            : nil,
                        previewSavings: Self.isScreenshotPreview ? 37 : nil,
                        loadState: purchaseManager.loadState
                    )
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityAddTraits(selectedPlan == plan ? .isSelected : [])
            }
        }
    }

    private var purchaseButton: some View {
        VStack(spacing: BellwireSpacing.small) {
            if let errorMessage = purchaseManager.errorMessage {
                Text(localized(errorMessage))
                    .font(.caption)
                    .foregroundStyle(BellwireTheme.danger)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                if purchaseManager.isUnavailableInCurrentStorefront {
                    dismiss()
                    return
                }
                guard let product = selectedProduct else {
                    Task { await purchaseManager.loadProducts() }
                    return
                }
                Task {
                    _ = await purchaseManager.purchase(
                        product,
                        appAccountToken: appAccountToken
                    )
                }
            } label: {
                HStack(spacing: BellwireSpacing.compact) {
                    if purchaseManager.isPurchasing {
                        ProgressView()
                            .tint(BellwireTheme.accentInk)
                    }
                    Text(primaryButtonTitle)
                        .font(.headline.weight(.bold))
                }
                .foregroundStyle(BellwireTheme.accentInk)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 58)
                .background(
                    BellwireTheme.primaryButtonBackground,
                    in: Capsule()
                )
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(purchaseManager.isPurchasing || purchaseManager.isRestoring)
        }
    }

    private var footer: some View {
        VStack(spacing: BellwireSpacing.small) {
            Button {
                Task { await purchaseManager.restorePurchases() }
            } label: {
                HStack(spacing: BellwireSpacing.compact) {
                    if purchaseManager.isRestoring {
                        ProgressView()
                            .controlSize(.small)
                            .tint(BellwireTheme.accent)
                    }
                    Text(localized("Restore Purchases"))
                        .font(.subheadline.weight(.medium))
                }
                .foregroundStyle(BellwireTheme.accent)
                .frame(minHeight: 44)
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(purchaseManager.isPurchasing || purchaseManager.isRestoring)

            Text(localized("Subscriptions renew automatically unless canceled at least 24 hours before the current period ends. Manage or cancel in Apple ID settings."))
                .font(.caption2)
                .foregroundStyle(BellwireTheme.mutedInk)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: BellwireSpacing.roomy) {
                Button(localized("Terms")) {
                    openURL(URL(string: "https://bellwire.app/terms")!)
                }
                Button(localized("Privacy")) {
                    openURL(URL(string: "https://bellwire.app/privacy")!)
                }
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(BellwireTheme.secondaryInk)
            .buttonStyle(PressableButtonStyle())
        }
    }

    private var selectedProduct: Product? {
        purchaseManager.product(for: selectedPlan)
    }

    private var primaryButtonTitle: String {
        if purchaseManager.loadState == .loading {
            return String(localized: "Loading App Store…", locale: locale)
        }
        if purchaseManager.isUnavailableInCurrentStorefront {
            return String(localized: "Close", locale: locale)
        }
        if purchaseManager.isTrialEligible(for: selectedPlan)
            || (Self.isScreenshotPreview && selectedPlan == .yearly) {
            return String(localized: "Start free trial", locale: locale)
        }
        if selectedProduct == nil {
            return String(localized: "Try again", locale: locale)
        }
        switch selectedPlan {
        case .yearly:
            return String(localized: "Continue with yearly", locale: locale)
        case .monthly:
            return String(localized: "Continue with monthly", locale: locale)
        }
    }

    private func localized(_ key: String) -> String {
        String(localized: String.LocalizationValue(key), locale: locale)
    }

    private static var isScreenshotPreview: Bool {
#if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-BellwireScreenshot"),
              arguments.indices.contains(index + 1) else {
            return false
        }
        return arguments[index + 1] == "paywall"
#else
        return false
#endif
    }
}

private struct PaywallPlanRow: View {
    @Environment(\.locale) private var locale

    let plan: BellwirePurchasePlan
    let product: Product?
    let monthlyProduct: Product?
    let isSelected: Bool
    let showsTrial: Bool
    let previewPrice: String?
    let previewMonthlyEquivalent: String?
    let previewSavings: Int?
    let loadState: PurchaseManager.LoadState

    var body: some View {
        HStack(spacing: BellwireSpacing.standard) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: BellwireSpacing.compact) {
                    Text(plan.title(locale: locale))
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(BellwireTheme.ink)

                    if plan == .yearly {
                        Text(savingsLabel)
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .tracking(0.6)
                            .foregroundStyle(BellwireTheme.accentInk)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(BellwireTheme.accent, in: Capsule())
                    }
                }

                Text(detailText)
                    .font(.caption)
                    .foregroundStyle(BellwireTheme.secondaryInk)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Group {
                if let product {
                    Text(product.displayPrice)
                        .font(.system(.title3, design: .rounded, weight: .bold))
                        .monospacedDigit()
                } else if let previewPrice {
                    Text(previewPrice)
                        .font(.system(.title3, design: .rounded, weight: .bold))
                        .monospacedDigit()
                } else if loadState == .loading || loadState == .idle {
                    ProgressView()
                        .controlSize(.small)
                        .tint(BellwireTheme.accent)
                        .accessibilityLabel(
                            String(localized: "Loading App Store…", locale: locale)
                        )
                } else {
                    Text(String(localized: "Price unavailable", locale: locale))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(BellwireTheme.secondaryInk)
                }
            }
            .foregroundStyle(BellwireTheme.ink)

            ZStack {
                Circle()
                    .stroke(
                        isSelected ? BellwireTheme.accent : BellwireTheme.mutedInk.opacity(0.55),
                        lineWidth: isSelected ? 0 : 2
                    )
                    .frame(width: 28, height: 28)

                Circle()
                    .fill(BellwireTheme.accent)
                    .frame(width: 28, height: 28)
                    .opacity(isSelected ? 1 : 0)
                    .scaleEffect(isSelected ? 1 : 0.25)
                    .blur(radius: isSelected ? 0 : 4)

                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(BellwireTheme.accentInk)
                    .opacity(isSelected ? 1 : 0)
                    .scaleEffect(isSelected ? 1 : 0.25)
                    .blur(radius: isSelected ? 0 : 4)
            }
            .animation(.spring(duration: 0.3, bounce: 0), value: isSelected)
        }
        .padding(.horizontal, BellwireSpacing.standard)
        .frame(minHeight: 82)
        .background(
            isSelected ? BellwireTheme.accent.opacity(0.08) : BellwireTheme.surface.opacity(0.92),
            in: RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)
                .stroke(
                    isSelected ? BellwireTheme.accent : BellwireTheme.strongSeparator.opacity(0.65),
                    lineWidth: isSelected ? 1.5 : 1
                )
        }
        .contentShape(RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous))
    }

    private var detailText: String {
        if showsTrial && plan == .yearly {
            return String(
                localized: "7-day free trial · then billed yearly",
                locale: locale
            )
        }
        guard plan == .yearly,
              let equivalent = previewMonthlyEquivalent
                ?? product.flatMap(monthlyEquivalent(for:)) else {
            return plan.renewalDescription(locale: locale)
        }
        return String(
            format: String(
                localized: "%@ per month · billed yearly",
                locale: locale
            ),
            equivalent
        )
    }

    private var savingsLabel: String {
        if let previewSavings {
            return String(
                format: String(localized: "SAVE %d%%", locale: locale),
                previewSavings
            )
        }
        guard let yearly = product,
              let monthly = monthlyProduct,
              let percentage = savingsPercentage(yearly: yearly, monthly: monthly),
              percentage > 0 else {
            return String(localized: "BEST VALUE", locale: locale)
        }
        return String(
            format: String(localized: "SAVE %d%%", locale: locale),
            percentage
        )
    }

    private func monthlyEquivalent(for product: Product) -> String? {
        let value = product.price / Decimal(12)
        return value.formatted(product.priceFormatStyle)
    }

    private func savingsPercentage(yearly: Product, monthly: Product) -> Int? {
        let regularAnnualPrice = monthly.price * Decimal(12)
        guard regularAnnualPrice > 0 else { return nil }
        let ratio = NSDecimalNumber(decimal: yearly.price / regularAnnualPrice).doubleValue
        return Int(((1 - ratio) * 100).rounded())
    }
}

private extension BellwirePurchasePlan {
    var previewPrice: String {
        switch self {
        case .yearly: return "$29.99"
        case .monthly: return "$3.99"
        }
    }
}

private extension View {
    func paywallEntrance(appeared: Bool, delay: Double, reduceMotion: Bool) -> some View {
        opacity(appeared ? 1 : 0)
            .blur(radius: appeared || reduceMotion ? 0 : 4)
            .offset(y: appeared || reduceMotion ? 0 : 12)
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.34).delay(delay),
                value: appeared
            )
    }
}
