// SPDX-License-Identifier: MPL-2.0
import AuthenticationServices
import SwiftUI

struct WelcomeView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.locale) private var locale
    @State private var mascotState: MascotState = .idle

    var body: some View {
        ZStack {
            BellwireTheme.background.ignoresSafeArea()
            SignalBreathingGlow()
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: BellwireSpacing.compact) {
                        Text(AppConfig.displayName)
                            .bellwireTechnicalLabel()
                        Spacer()
                    }

                    VStack(alignment: .leading, spacing: BellwireSpacing.roomy) {
                        Text("Signals from every project,\non your iPhone.")
                            .font(BellwireTypography.hero)
                            .tracking(-0.8)
                            .foregroundStyle(BellwireTheme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)

                        Text(AppConfig.branded(
                            "Bellwire is wired up by your AI Agent. Codex, Claude Code, and other agents connect project events to your phone — no notification code or webhook setup required.",
                            locale: locale
                        ))
                            .font(.body)
                            .foregroundStyle(BellwireTheme.secondaryInk)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 46)

                    VStack(spacing: 0) {
                        WelcomePreviewRow(
                            icon: "creditcard.fill",
                            title: "Payment received",
                            detail: "Revenue signal · just now",
                            tint: BellwireTheme.accent
                        )
                        Divider().overlay(BellwireTheme.separator).padding(.leading, 58)
                        WelcomePreviewRow(
                            icon: "gearshape.2.fill",
                            title: "Agent run in progress",
                            detail: "Weekly report · running",
                            tint: BellwireTheme.live,
                            isLive: true
                        )
                        Divider().overlay(BellwireTheme.separator).padding(.leading, 58)
                        WelcomePreviewRow(
                            icon: "shippingbox.fill",
                            title: "Deployment completed",
                            detail: "Production · just now",
                            tint: BellwireTheme.secondaryInk
                        )
                    }
                    .padding(.horizontal, BellwireSpacing.standard)
                    .bellwireListGroup()
                    .overlay(alignment: .topTrailing) {
                        MascotView(
                            state: mascotState,
                            size: 92,
                            facing: .left
                        )
                            .offset(x: -12, y: -78)
                    }
                    .padding(.top, 58)

                    if let error = model.errorMessage {
                        ErrorBanner(message: error) { model.errorMessage = nil }
                            .padding(.top, BellwireSpacing.roomy)
                    }

                    VStack(spacing: BellwireSpacing.small) {
                        SignInWithAppleButton(.signIn) { request in
                            model.configureAppleRequest(request)
                        } onCompletion: { result in
                            Task { await model.completeAppleAuthorization(result) }
                        }
                        .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                        .frame(minHeight: 52)
                        .clipShape(RoundedRectangle(cornerRadius: BellwireRadius.control, style: .continuous))
                        .disabled(model.isAuthenticating)
                        .opacity(model.isAuthenticating ? 0.62 : 1)
                        .accessibilityHint("Signs in using your Apple ID")

                        if model.isAuthenticating {
                            ProgressView("Signing in…")
                                .font(.caption)
                                .foregroundStyle(BellwireTheme.mutedInk)
                        }

                        VStack(spacing: BellwireSpacing.micro) {
                            Text(AppConfig.branded(
                                "By continuing, you agree to Bellwire’s policies.",
                                locale: locale
                            ))
                            HStack(spacing: BellwireSpacing.standard) {
                                Link("Terms of Service", destination: AppConfig.termsURL)
                                Link("Privacy Policy", destination: AppConfig.privacyURL)
                            }
                            Text("Sensitive fields stay redacted until you reveal them.")
                        }
                        .font(.footnote)
                        .foregroundStyle(BellwireTheme.mutedInk)
                        .multilineTextAlignment(.center)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 34)
                    .padding(.bottom, BellwireSpacing.roomy)
                }
                .padding(.horizontal, BellwireSpacing.page)
                .padding(.top, BellwireSpacing.roomy)
            }
            .scrollIndicators(.hidden)
        }
        .task {
            guard mascotState == .idle else { return }
            if !reduceMotion {
                try? await Task.sleep(for: .milliseconds(550))
            }
            guard !Task.isCancelled else { return }
            mascotState = .listening
        }
    }
}

private struct WelcomePreviewRow: View {
    let icon: String
    let title: String
    let detail: String
    let tint: Color
    var isLive = false

    var body: some View {
        HStack(spacing: BellwireSpacing.small) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(BellwireTheme.accentInk)
                .frame(width: 34, height: 34)
                .background(tint, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 7) {
                    if isLive {
                        Circle().fill(BellwireTheme.live).frame(width: 6, height: 6)
                    }
                    Text(LocalizedStringKey(title))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(BellwireTheme.ink)
                }
                Text(LocalizedStringKey(detail))
                    .font(.caption)
                    .foregroundStyle(BellwireTheme.mutedInk)
            }
            Spacer()
            Text("now")
                .font(BellwireTypography.technical)
                .foregroundStyle(BellwireTheme.mutedInk)
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}

struct NotificationOnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.locale) private var locale
    @Binding var isComplete: Bool
    @State private var isRequesting = false

    var body: some View {
        ZStack {
            BellwireTheme.background.ignoresSafeArea()
            SignalBreathingGlow(intensity: 0.86).ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    MascotView(
                        state: .listening,
                        size: 64,
                        facing: .right,
                        animates: !isRequesting
                    )
                    .padding(.top, 28)

                    Text(AppConfig.branded("Let Bellwire ring\nwhen it matters.", locale: locale))
                        .font(BellwireTypography.pageTitle)
                        .tracking(-0.6)
                        .foregroundStyle(BellwireTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, BellwireSpacing.roomy)
                        .accessibilityAddTraits(.isHeader)

                    Text("You’ll only hear from projects you or your Agent explicitly wire up. Pause any project at any time.")
                        .font(.body)
                        .foregroundStyle(BellwireTheme.secondaryInk)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, BellwireSpacing.standard)

                    VStack(spacing: 0) {
                        NotificationValueRow(
                            icon: "creditcard.fill",
                            title: "Business signals",
                            detail: "Payments, subscriptions, refunds, and churn"
                        )
                        Divider().overlay(BellwireTheme.separator).padding(.leading, 52)
                        NotificationValueRow(
                            icon: "gearshape.2.fill",
                            title: "Agent runs",
                            detail: "Tasks started, completed, failed, or waiting"
                        )
                        Divider().overlay(BellwireTheme.separator).padding(.leading, 52)
                        NotificationValueRow(
                            icon: "exclamationmark.triangle.fill",
                            title: "Ops & alerts",
                            detail: "Deploys, cron jobs, thresholds, and incidents"
                        )
                    }
                    .padding(.horizontal, BellwireSpacing.standard)
                    .bellwireListGroup()
                    .padding(.top, 30)

                    if let error = model.errorMessage {
                        ErrorBanner(message: error) { model.errorMessage = nil }
                            .padding(.top, BellwireSpacing.roomy)
                    }
                }
                .padding(.horizontal, BellwireSpacing.page)
                .padding(.top, BellwireSpacing.roomy)
                .padding(.bottom, 150)
            }
            .scrollIndicators(.hidden)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: BellwireSpacing.compact) {
                PrimaryButton(
                    title: "Enable notifications",
                    systemImage: BellwireIcons.notification,
                    isLoading: isRequesting,
                    isDisabled: isRequesting
                ) {
                    isRequesting = true
                    Task {
                        let requestCompleted = await model.requestNotificationPermission()
                        isRequesting = false
                        if requestCompleted { isComplete = true }
                    }
                }
                Button("Not now") { isComplete = true }
                    .font(.body.weight(.semibold))
                    .foregroundStyle(BellwireTheme.secondaryInk)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .buttonStyle(PressableButtonStyle())
            }
            .padding(.horizontal, BellwireSpacing.page)
            .padding(.top, BellwireSpacing.small)
            .padding(.bottom, BellwireSpacing.compact)
            .background(.ultraThinMaterial)
        }
    }
}

private struct NotificationValueRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: BellwireSpacing.small) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(BellwireTheme.accent)
                .frame(width: 38, height: 38)
                .background(BellwireTheme.raisedSurface, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(LocalizedStringKey(title))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(BellwireTheme.ink)
                Text(LocalizedStringKey(detail))
                    .font(.caption)
                    .foregroundStyle(BellwireTheme.mutedInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 14)
        .accessibilityElement(children: .combine)
    }
}
