// SPDX-License-Identifier: MPL-2.0
import SwiftUI
import UIKit
import MessageUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var purchaseManager: PurchaseManager
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    @State private var isGeneratingBinding = false
    @State private var showsAgentInstructions = false
    @State private var showsSignOutConfirmation = false
    @State private var showsDeleteAccountPage = false
    @State private var showsClearPrivateHistoryConfirmation = false
    @State private var showsPaywall = false
    @State private var showsFeedbackMail = false
    @State private var showsFeedbackFallback = false
    @State private var feedbackEmailCopied = false
    @State private var pendingDeviceDeletion: DeviceRecord?
    @AppStorage(AppLanguage.storageKey) private var appLanguage = AppLanguage.system.rawValue
    @AppStorage(AppAppearance.storageKey) private var appAppearance = AppAppearance.system.rawValue

    private var hasPro: Bool {
        model.entitlement?.hasPro ?? purchaseManager.hasPro
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: BellwireSpacing.section) {
                    Text("Settings")
                        .font(BellwireTypography.pageTitle)
                        .foregroundStyle(BellwireTheme.ink)
                        .accessibilityAddTraits(.isHeader)

                    accountOverviewSection
                    if !model.pendingModeRequests.isEmpty {
                        modeRequestsSection
                    }
                    connectionSection
                    devicesSection
                    notificationsSection
                    appPreferencesSection
                    supportSection
                    accountSection

                    if let error = model.errorMessage {
                        ErrorBanner(message: error) { model.errorMessage = nil }
                    }

                    Text(appVersion)
                        .bellwireTechnicalLabel()
                        .frame(maxWidth: .infinity)
                        .padding(.top, BellwireSpacing.compact)
                }
                .padding(.horizontal, BellwireSpacing.roomy)
                .padding(.top, BellwireSpacing.standard)
                .padding(.bottom, BellwireSpacing.large)
            }
            .bellwirePageBackground()
            .toolbar(.hidden, for: .navigationBar)
            .refreshable {
                await model.refreshNotificationStatus()
                await model.loadDashboard()
            }
            .task {
                await model.refreshPendingModeRequests()
            }
            .sheet(item: $model.binding) { binding in
                BindingCodeSheet(binding: binding)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showsAgentInstructions) {
                AgentInstructionSheet()
                    .presentationDetents([.medium])
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showsFeedbackMail) {
                FeedbackMailView(
                    isPresented: $showsFeedbackMail,
                    recipient: feedbackEmail,
                    subject: "Bellwire Feedback",
                    body: feedbackBody
                )
            }
            .sheet(isPresented: $showsPaywall) {
                PaywallView(appAccountToken: model.session.flatMap { UUID(uuidString: $0.user.id) })
                    .environmentObject(purchaseManager)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.hidden)
                    .presentationCornerRadius(BellwireRadius.hero)
                    .presentationBackground(BellwireTheme.background)
            }
            .alert("Feedback unavailable", isPresented: $showsFeedbackFallback) {
                Button("Copy email") {
                    UIPasteboard.general.string = feedbackEmail
                    feedbackEmailCopied = true
                    BellwireHaptics.success()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("No mail account is configured. Copy the feedback email instead?")
            }
            .alert(
                "Sign out of Bellwire?",
                isPresented: $showsSignOutConfirmation
            ) {
                Button("Sign out", role: .destructive) { model.signOut() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your local session will be removed. Connected projects and server data are not deleted.")
            }
            .alert(
                "Clear Private history?",
                isPresented: $showsClearPrivateHistoryConfirmation
            ) {
                Button("Clear history", role: .destructive) { model.clearPrivateHistory() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Private notification and Inbox details cached on this iPhone will be removed. Your service data is not affected.")
            }
            .alert(item: $pendingDeviceDeletion) { device in
                Alert(
                    title: Text("Remove device?"),
                    message: Text("“\(device.name)” will stop receiving Bellwire notifications. You can register it again later."),
                    primaryButton: .destructive(Text("Remove")) {
                        Task { await model.deleteDevice(id: device.id) }
                    },
                    secondaryButton: .cancel()
                )
            }
            .navigationDestination(isPresented: $showsDeleteAccountPage) {
                DeleteAccountView()
            }
        }
    }

    private var accountOverviewSection: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Account & plan")
            VStack(spacing: 0) {
                HStack(spacing: BellwireSpacing.standard) {
                    Text(accountInitial)
                        .font(.system(.title3, design: .serif, weight: .regular))
                        .foregroundStyle(BellwireTheme.accentInk)
                        .frame(width: 44, height: 44)
                        .background(BellwireTheme.accent, in: Circle())
                    VStack(alignment: .leading, spacing: 3) {
                        Text(accountName)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(BellwireTheme.ink)
                            .lineLimit(1)
                        Text("Signed in with Apple")
                            .font(.caption)
                            .foregroundStyle(BellwireTheme.mutedInk)
                    }
                    Spacer()
                    StatusBadgeView(
                        text: hasPro ? "Pro" : "Free",
                        color: hasPro ? BellwireTheme.accent : BellwireTheme.mutedInk,
                        showsDot: false
                    )
                }
                .padding(.vertical, 14)

                Divider().overlay(BellwireTheme.separator)

                Button {
                    if hasPro {
                        Task { await model.captureProductEvent("subscription_managed", source: "settings") }
                        openURL(URL(string: "https://apps.apple.com/account/subscriptions")!)
                    } else {
                        Task { await model.captureProductEvent("upgrade_clicked", source: "settings") }
                        showsPaywall = true
                    }
                } label: {
                    if hasPro {
                        ProActiveSettingsRow()
                    } else {
                        SettingsRowView(
                            icon: "sparkles",
                            title: "Upgrade to Bellwire Pro",
                            hint: "More projects, events, devices, and history"
                        ) {
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(BellwireTheme.accent)
                        }
                    }
                }
                .buttonStyle(PressableButtonStyle())

                if let entitlement = model.entitlement {
                    Divider().overlay(BellwireTheme.separator).padding(.leading, 44)
                    VStack(alignment: .leading, spacing: BellwireSpacing.compact) {
                        HStack {
                            Text("Monthly Signals")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(BellwireTheme.ink)
                            Spacer()
                            Text("\(entitlement.usage.acceptedSignals.formatted()) / \(entitlement.limits.monthlySignals.formatted())")
                                .font(BellwireTypography.technicalStrong)
                                .foregroundStyle(signalUsageColor(entitlement))
                        }
                        ProgressView(value: signalUsagePercent(entitlement))
                            .tint(signalUsageColor(entitlement))
                    }
                    .padding(.vertical, 14)
                }
            }
            .padding(.horizontal, BellwireSpacing.standard)
            .bellwireListGroup()

            if let entitlement = model.entitlement, let notice = quotaNotice(entitlement) {
                Label {
                    Text(notice.message)
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: notice.icon)
                }
                .foregroundStyle(notice.color)
                .padding(.horizontal, BellwireSpacing.standard)
            }
        }
    }

    private var accountCard: some View {
        HStack(spacing: BellwireSpacing.standard) {
            Text(accountInitial)
                .font(.system(.title2, design: .serif, weight: .regular))
                .foregroundStyle(BellwireTheme.accentInk)
                .frame(width: 50, height: 50)
                .background(
                    LinearGradient(
                        colors: [BellwireTheme.accent, BellwireTheme.warning],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    in: Circle()
                )
            VStack(alignment: .leading, spacing: 3) {
                Text(accountName)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(BellwireTheme.ink)
                    .lineLimit(1)
                Text("Signed in with Apple")
                    .font(.caption)
                    .foregroundStyle(BellwireTheme.mutedInk)
            }
            Spacer()
            StatusBadgeView(text: "Connected", color: BellwireTheme.success)
        }
        .padding(BellwireSpacing.standard)
        .bellwireListGroup()
        .accessibilityElement(children: .combine)
    }

    private var proSection: some View {
        Button {
            if hasPro {
                Task { await model.captureProductEvent("subscription_managed", source: "settings") }
                openURL(URL(string: "https://apps.apple.com/account/subscriptions")!)
            } else {
                Task { await model.captureProductEvent("upgrade_clicked", source: "settings") }
                showsPaywall = true
            }
        } label: {
            HStack(spacing: BellwireSpacing.standard) {
                ZStack {
                    RoundedRectangle(cornerRadius: BellwireRadius.control, style: .continuous)
                        .fill(BellwireTheme.accent.opacity(0.14))
                    Image(systemName: hasPro ? "checkmark.seal.fill" : "sparkles")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(BellwireTheme.accent)
                }
                .frame(width: 46, height: 46)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: BellwireSpacing.compact) {
                        Text("Bellwire Pro")
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(BellwireTheme.ink)
                        if hasPro {
                            Text("ACTIVE")
                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                                .tracking(0.6)
                                .foregroundStyle(BellwireTheme.accentInk)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(BellwireTheme.accent, in: Capsule())
                        }
                    }
                    Text(
                        hasPro
                            ? "Your Pro access is active"
                            : "More projects, events, devices, and history"
                    )
                    .font(.caption)
                    .foregroundStyle(BellwireTheme.secondaryInk)
                    .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(BellwireTheme.accent)
            }
            .padding(BellwireSpacing.standard)
            .background(
                LinearGradient(
                    colors: [
                        BellwireTheme.surface,
                        BellwireTheme.accent.opacity(0.10),
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                in: RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)
                    .stroke(BellwireTheme.accent.opacity(0.34), lineWidth: 1)
            }
            .shadow(color: BellwireTheme.cardShadow, radius: 14, y: 5)
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityHint(
            hasPro
                ? "Opens App Store subscription management"
                : "Opens Bellwire Pro purchase options"
        )
    }

    private var usageSection: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Plan & usage")
            if let entitlement = model.entitlement {
                VStack(alignment: .leading, spacing: BellwireSpacing.standard) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(entitlement.plan == "pro" ? "Pro" : "Free")
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(BellwireTheme.ink)
                            Text("\(entitlement.usage.acceptedSignals.formatted()) of \(entitlement.limits.monthlySignals.formatted()) Signals")
                                .font(.caption)
                                .foregroundStyle(BellwireTheme.secondaryInk)
                        }
                        Spacer()
                        Text(signalUsagePercent(entitlement), format: .percent.precision(.fractionLength(0)))
                            .font(BellwireTypography.technicalStrong)
                            .foregroundStyle(signalUsageColor(entitlement))
                    }

                    ProgressView(value: signalUsagePercent(entitlement))
                        .tint(signalUsageColor(entitlement))

                    HStack {
                        if let resetDate = ISO8601DateFormatter.bellwireDate(
                            from: entitlement.usage.periodEnd
                        ) {
                            Label {
                                Text("Resets \(resetDate, format: .dateTime.month().day().hour().minute())")
                            } icon: {
                                Image(systemName: "arrow.clockwise")
                            }
                        }
                        Spacer()
                        Text("Hosted history · \(entitlement.limits.hostedRetentionDays) days")
                    }
                    .font(.caption2)
                    .foregroundStyle(BellwireTheme.mutedInk)

                    if let notice = quotaNotice(entitlement) {
                        VStack(alignment: .leading, spacing: 4) {
                            Label(notice.title, systemImage: notice.icon)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(notice.color)
                            Text(notice.message)
                                .font(.caption)
                                .foregroundStyle(BellwireTheme.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(BellwireSpacing.small)
                        .background(
                            notice.color.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: BellwireRadius.small)
                        )
                    }

                    if entitlement.plan == "free",
                       entitlement.activeProjects > entitlement.limits.activeProjects
                        || entitlement.activeDevices > entitlement.limits.activeDevices {
                        VStack(alignment: .leading, spacing: 5) {
                            Label("Choose what stays active", systemImage: "exclamationmark.circle.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(BellwireTheme.warning)
                            Text(
                                "Pause projects and remove devices until you are within the Free limits. Bellwire will never delete them just because Pro ended."
                            )
                            .font(.caption)
                            .foregroundStyle(BellwireTheme.secondaryInk)
                            if let deadline = entitlement.downgradeDeadline,
                               let date = ISO8601DateFormatter.bellwireDate(from: deadline) {
                                Text("Automatic organization \(date, style: .relative)")
                                    .font(.caption2)
                                    .foregroundStyle(BellwireTheme.mutedInk)
                            }
                        }
                        .padding(BellwireSpacing.small)
                        .background(BellwireTheme.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    }

                    HStack(spacing: BellwireSpacing.small) {
                        planMetric(
                            entitlement.activeProjects,
                            entitlement.limits.activeProjects,
                            "Projects"
                        )
                        planMetric(
                            entitlement.activeDevices,
                            entitlement.limits.activeDevices,
                            "Devices"
                        )
                        planLimitMetric(
                            entitlement.limits.surfacesPerProject,
                            "Surfaces"
                        )
                    }

                    Divider().overlay(BellwireTheme.separator)
                    Button {
                        showsClearPrivateHistoryConfirmation = true
                    } label: {
                        Label("Clear Private history on this iPhone", systemImage: "trash")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(BellwireTheme.danger)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(PressableButtonStyle())
                }
                .padding(BellwireSpacing.standard)
                .bellwireSurface(elevated: false)
            } else {
                LoadingEventRows(count: 1)
            }
        }
    }

    private var modeRequestsSection: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(
                title: "Delivery mode requests",
                hint: "\(model.pendingModeRequests.count)"
            )
            ForEach(model.pendingModeRequests) { request in
                VStack(alignment: .leading, spacing: BellwireSpacing.standard) {
                    Label(
                        request.toMode == .hosted ? "Enable Hosted delivery?" : "Enable Private delivery?",
                        systemImage: request.toMode == .hosted ? "cloud.fill" : "lock.shield.fill"
                    )
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(BellwireTheme.ink)
                    if let project = model.projects.first(where: { $0.id == request.projectId }) {
                        Text(project.name)
                            .bellwireTechnicalLabel()
                    }
                    Text(
                        request.toMode == .hosted
                            ? "Bellwire Cloud will receive and retain this project's Event, Inbox, Surface, and detailed notification content."
                            : "Bellwire will send content-free wakes. At least one iPhone must have a verified Direct connection."
                    )
                    .font(.caption)
                    .foregroundStyle(BellwireTheme.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    if let error = model.modeRequestErrors[request.id] {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(BellwireTheme.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: BellwireSpacing.small) {
                        Button(role: .cancel) {
                            Task { await model.resolveModeRequest(id: request.id, approve: false) }
                        } label: {
                            Text("Reject")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        Button {
                            Task { await model.resolveModeRequest(id: request.id, approve: true) }
                        } label: {
                            ZStack {
                                Text("Approve")
                                    .opacity(model.resolvingModeRequestID == request.id ? 0 : 1)
                                if model.resolvingModeRequestID == request.id {
                                    ProgressView()
                                        .tint(BellwireTheme.accentInk)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(BellwireTheme.accent)
                    }
                    .frame(maxWidth: .infinity)
                    .disabled(model.resolvingModeRequestID != nil)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(BellwireSpacing.standard)
                .bellwireSurface(elevated: false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func planMetric(_ value: Int, _ limit: Int, _ title: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(value)/\(limit)")
                .font(BellwireTypography.technicalStrong)
                .foregroundStyle(BellwireTheme.ink)
            Text(title)
                .font(.caption2)
                .foregroundStyle(BellwireTheme.mutedInk)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func planLimitMetric(_ limit: Int, _ title: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(limit)/project")
                .font(BellwireTypography.technicalStrong)
                .foregroundStyle(BellwireTheme.ink)
            Text(title)
                .font(.caption2)
                .foregroundStyle(BellwireTheme.mutedInk)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func signalUsagePercent(_ entitlement: AccountEntitlement) -> Double {
        min(
            Double(entitlement.usage.acceptedSignals)
                / Double(max(entitlement.limits.monthlySignals, 1)),
            1.1
        )
    }

    private func signalUsageColor(_ entitlement: AccountEntitlement) -> Color {
        let value = signalUsagePercent(entitlement)
        return value >= 1 ? BellwireTheme.danger : value >= 0.8 ? BellwireTheme.warning : BellwireTheme.accent
    }

    private func quotaNotice(
        _ entitlement: AccountEntitlement
    ) -> (title: LocalizedStringKey, message: LocalizedStringKey, icon: String, color: Color)? {
        let used = entitlement.usage.acceptedSignals
        let limit = entitlement.limits.monthlySignals
        let courtesy = entitlement.limits.courtesySignals
        if used >= courtesy {
            return (
                "Signal limit reached",
                "New Signals will be rejected until the UTC monthly reset. Already accepted notifications will still be delivered.",
                "xmark.octagon.fill",
                BellwireTheme.danger
            )
        }
        if used > limit {
            return (
                "Courtesy buffer in use",
                "Bellwire is still accepting Signals temporarily. Upgrade or reduce traffic before the buffer is exhausted.",
                "exclamationmark.triangle.fill",
                BellwireTheme.danger
            )
        }
        if used >= limit {
            return (
                "Monthly allowance used",
                "A limited courtesy buffer is active. Upgrade or wait for the monthly reset.",
                "exclamationmark.triangle.fill",
                BellwireTheme.warning
            )
        }
        if used >= Int((Double(limit) * 0.8).rounded(.up)) {
            return (
                "80% of monthly Signals used",
                "Review usage now so important notifications keep flowing.",
                "gauge.with.dots.needle.67percent",
                BellwireTheme.warning
            )
        }
        return nil
    }

    private var connectionSection: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(
                title: "Agent connection",
                hint: model.agentConnections.isEmpty ? nil : "\(model.agentConnections.count)"
            )
            VStack(spacing: 0) {
                Button {
                    isGeneratingBinding = true
                    Task {
                        await model.createBinding()
                        isGeneratingBinding = false
                    }
                } label: {
                    SettingsRowView(
                        icon: BellwireIcons.binding,
                        title: isGeneratingBinding ? "Generating binding code…" : "Generate binding code",
                        hint: "Single-use · expires after 10 minutes"
                    ) {
                        if isGeneratingBinding {
                            ProgressView().tint(BellwireTheme.accent)
                        } else {
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(BellwireTheme.mutedInk)
                        }
                    }
                }
                .buttonStyle(PressableButtonStyle())
                .disabled(isGeneratingBinding)
                Divider().overlay(BellwireTheme.separator).padding(.leading, 44)
                Button { showsAgentInstructions = true } label: {
                    SettingsRowView(
                        icon: "text.bubble",
                        title: "How to instruct your Agent",
                        hint: "Codex, Claude Code, or another Agent"
                    ) {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(BellwireTheme.mutedInk)
                    }
                }
                .buttonStyle(PressableButtonStyle())
            }
            .padding(.horizontal, BellwireSpacing.standard)
            .bellwireListGroup()

            if !model.agentConnections.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(model.agentConnections.enumerated()), id: \.element.id) {
                        index,
                        connection in
                        AgentConnectionRowView(
                            connection: connection,
                            isRevoking: model.revokingAgentConnectionID == connection.id
                        ) {
                            Task {
                                await model.revokeAgentConnection(id: connection.id)
                            }
                        }
                        if index < model.agentConnections.count - 1 {
                            Divider()
                                .overlay(BellwireTheme.separator)
                                .padding(.leading, 44)
                        }
                    }
                }
                .padding(.horizontal, BellwireSpacing.standard)
                .bellwireSurface(elevated: false)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var notificationsSection: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Notifications")
            VStack(spacing: 0) {
                SettingsRowView(
                    icon: BellwireIcons.notification,
                    title: "Notification permission",
                    hint: notificationHint
                ) {
                    StatusBadgeView(
                        text: model.notificationPermission.label,
                        color: notificationColor,
                        showsDot: model.notificationPermission == .authorized
                    )
                }
                Divider().overlay(BellwireTheme.separator).padding(.leading, 44)
                SettingsRowView(
                    icon: "hand.raised.fill",
                    title: "Private by default",
                    hint: "Private projects fetch details directly from your service"
                ) {
                    Image(systemName: "lock.shield.fill")
                        .foregroundStyle(BellwireTheme.success)
                }
                Divider().overlay(BellwireTheme.separator).padding(.leading, 44)
                Button { openSystemSettings() } label: {
                    SettingsRowView(
                        icon: "gearshape",
                        title: "Open iOS Settings",
                        hint: "Manage alerts, sounds, and badges"
                    ) {
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(BellwireTheme.mutedInk)
                    }
                }
                .buttonStyle(PressableButtonStyle())
            }
            .padding(.horizontal, BellwireSpacing.standard)
            .bellwireListGroup()

            Text("Hosted projects are clearly labeled and only enabled after your approval.")
                .font(.caption)
                .foregroundStyle(BellwireTheme.mutedInk)
                .padding(.horizontal, BellwireSpacing.standard)
        }
    }

    private var devicesSection: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Devices", hint: model.devices.isEmpty ? nil : "\(model.devices.count)")
            if model.devices.isEmpty {
                EmptyState(
                    icon: BellwireIcons.device,
                    title: "No registered devices",
                    message: "This iPhone appears after notification permission and APNs registration succeed."
                )
                .bellwireSurface(elevated: false)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(model.devices.enumerated()), id: \.element.id) { index, device in
                        DeviceRowView(
                            device: device,
                            onDelete: { pendingDeviceDeletion = device }
                        )
                        if index < model.devices.count - 1 {
                            Divider().overlay(BellwireTheme.separator).padding(.leading, 44)
                        }
                    }
                }
                .padding(.horizontal, BellwireSpacing.standard)
                .bellwireListGroup()
            }
        }
    }

    private var appPreferencesSection: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "App")
            VStack(spacing: 0) {
                Menu {
                    ForEach(AppLanguage.allCases) { language in
                        Button {
                            appLanguage = language.rawValue
                            BellwireHaptics.selection()
                        } label: {
                            if selectedLanguage == language {
                                Label {
                                    Text(language.title)
                                } icon: {
                                    Image(systemName: "checkmark")
                                }
                            } else {
                                Text(language.title)
                            }
                        }
                    }
                } label: {
                    SettingsRowView(
                        icon: "globe",
                        title: "Language",
                        hint: "Choose the language used throughout Bellwire"
                    ) {
                        settingSelectionLabel(selectedLanguage.title)
                    }
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel("Language")
                .accessibilityValue(Text(selectedLanguage.title))
                .accessibilityHint("Changes the language used throughout Bellwire")

                Divider().overlay(BellwireTheme.separator).padding(.leading, 44)

                Menu {
                    ForEach(AppAppearance.allCases) { appearance in
                        Button {
                            withAnimation(reduceMotion ? nil : BellwireAnimation.standard) {
                                appAppearance = appearance.rawValue
                            }
                            BellwireHaptics.selection()
                        } label: {
                            if selectedAppearance == appearance {
                                Label {
                                    Text(appearance.title)
                                } icon: {
                                    Image(systemName: "checkmark")
                                }
                            } else {
                                Text(appearance.title)
                            }
                        }
                    }
                } label: {
                    SettingsRowView(
                        icon: "circle.lefthalf.filled",
                        title: "Appearance",
                        hint: "Choose the appearance used throughout Bellwire"
                    ) {
                        settingSelectionLabel(selectedAppearance.title)
                    }
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel("Appearance")
                .accessibilityValue(Text(selectedAppearance.title))
                .accessibilityHint("Changes Bellwire between light and dark appearance")
            }
            .padding(.horizontal, BellwireSpacing.standard)
            .bellwireListGroup()
        }
    }

    private var supportSection: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Support")
            VStack(spacing: 0) {
                Button { openSupport() } label: {
                    SettingsRowView(
                        icon: "questionmark.circle",
                        title: "Help and support",
                        hint: "Setup help and troubleshooting"
                    ) {
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(BellwireTheme.mutedInk)
                    }
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityHint("Opens Bellwire support in your browser")
                Divider().overlay(BellwireTheme.separator).padding(.leading, 44)
                Button { openFeedback() } label: {
                    SettingsRowView(
                        icon: feedbackEmailCopied ? "checkmark" : "bubble.left.and.bubble.right",
                        title: "Send feedback",
                        hint: feedbackEmailCopied ? "Feedback email copied" : "Help improve Bellwire"
                    ) {
                        Image(systemName: feedbackEmailCopied ? "checkmark" : "arrow.up.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(feedbackEmailCopied ? BellwireTheme.success : BellwireTheme.mutedInk)
                    }
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityHint("Opens an email to Bellwire support")
            }
            .padding(.horizontal, BellwireSpacing.standard)
            .bellwireListGroup()
        }
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            SectionHeaderView(title: "Account")
            VStack(spacing: 0) {
                Button { openPrivacyPolicy() } label: {
                    SettingsRowView(
                        icon: "hand.raised",
                        title: "Privacy policy",
                        hint: "How Bellwire handles account, device, and project data"
                    ) {
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(BellwireTheme.mutedInk)
                    }
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityHint("Opens the Bellwire privacy policy in your browser")
                Divider().overlay(BellwireTheme.separator).padding(.leading, 44)
                Button { openTermsOfService() } label: {
                    SettingsRowView(
                        icon: "doc.text",
                        title: "Terms of service",
                        hint: "Rules for using Bellwire"
                    ) {
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(BellwireTheme.mutedInk)
                    }
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityHint("Opens the Bellwire terms of service in your browser")
                Divider().overlay(BellwireTheme.separator).padding(.leading, 44)
                Button { showsSignOutConfirmation = true } label: {
                    SettingsRowView(
                        icon: "rectangle.portrait.and.arrow.right",
                        title: "Sign out",
                        tone: BellwireTheme.danger
                    ) {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(BellwireTheme.danger)
                    }
                }
                .buttonStyle(PressableButtonStyle())
                Divider().overlay(BellwireTheme.separator).padding(.leading, 44)
                Button { showsDeleteAccountPage = true } label: {
                    SettingsRowView(
                        icon: "person.crop.circle.badge.minus",
                        title: "Delete account",
                        hint: "Permanently delete your account and data",
                        tone: BellwireTheme.danger
                    ) {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(BellwireTheme.danger)
                    }
                }
                .buttonStyle(PressableButtonStyle())
            }
            .padding(.horizontal, BellwireSpacing.standard)
            .bellwireListGroup()
        }
    }

    private var accountName: String {
        model.session?.user.email ?? "Apple account"
    }

    private var selectedLanguage: AppLanguage {
        AppLanguage.selected(from: appLanguage)
    }

    private var selectedAppearance: AppAppearance {
        AppAppearance.selected(from: appAppearance)
    }

    private func settingSelectionLabel(_ title: LocalizedStringKey) -> some View {
        HStack(spacing: 5) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(BellwireTheme.accent)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(BellwireTheme.mutedInk)
        }
    }

    private var accountInitial: String {
        String(accountName.first ?? "B").uppercased()
    }

    private var notificationHint: String {
        switch model.notificationPermission {
        case .unknown: return "Checking the system permission"
        case .notDetermined: return "Permission has not been requested"
        case .denied: return "Enable notifications in iOS Settings"
        case .authorized: return "Alerts can be delivered to this device"
        }
    }

    private var notificationColor: Color {
        switch model.notificationPermission {
        case .authorized: return BellwireTheme.success
        case .denied: return BellwireTheme.danger
        case .unknown, .notDetermined: return BellwireTheme.mutedInk
        }
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return "Bellwire \(version) · build \(build)"
    }

    private var feedbackEmail: String { "feedback@bellwire.app" }

    private var feedbackBody: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        let device = UIDevice.current
        return """
        请在这里填写反馈 / Please write your feedback here.


        ---
        Bellwire \(version) (\(build))
        \(device.localizedModel) · \(device.systemName) \(device.systemVersion)
        """
    }

    private func openFeedback() {
        feedbackEmailCopied = false
        if MFMailComposeViewController.canSendMail() {
            showsFeedbackMail = true
        } else {
            showsFeedbackFallback = true
        }
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func openPrivacyPolicy() {
        guard let url = URL(string: "https://bellwire.app/privacy") else { return }
        openURL(url)
    }

    private func openTermsOfService() {
        guard let url = URL(string: "https://bellwire.app/terms") else { return }
        openURL(url)
    }

    private func openSupport() {
        guard let url = URL(string: "https://bellwire.app/support") else { return }
        openURL(url)
    }
}

private struct ProActiveSettingsRow: View {
    var body: some View {
        HStack(spacing: BellwireSpacing.small) {
            ZStack {
                RoundedRectangle(cornerRadius: BellwireRadius.small, style: .continuous)
                    .fill(BellwireTheme.surface)
                RoundedRectangle(cornerRadius: BellwireRadius.small, style: .continuous)
                    .stroke(BellwireTheme.proActiveBorder, lineWidth: 1)
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(.body, design: .default, weight: .semibold))
                    .foregroundStyle(BellwireTheme.proActiveInk)
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 3) {
                activeBadge
                Text("Manage Bellwire Pro")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(BellwireTheme.ink)
                Text("Your Pro access is active")
                    .font(.caption)
                    .foregroundStyle(BellwireTheme.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Image(systemName: "chevron.right")
                .font(.body.weight(.semibold))
                .foregroundStyle(BellwireTheme.proActiveInk)
                .frame(width: 24)
                .frame(minHeight: 44)
        }
        .padding(.horizontal, BellwireSpacing.small)
        .padding(.vertical, BellwireSpacing.compact)
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: BellwireRadius.control, style: .continuous)
                .fill(BellwireTheme.proActiveSurface)
        }
        .overlay {
            RoundedRectangle(cornerRadius: BellwireRadius.control, style: .continuous)
                .stroke(BellwireTheme.proActiveBorder, lineWidth: 1)
        }
        .padding(.vertical, BellwireSpacing.compact)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Manage Bellwire Pro"))
        .accessibilityValue(Text("Your Pro access is active"))
    }

    private var activeBadge: some View {
        Text("PRO ACTIVE")
            .font(.caption2.weight(.bold))
            .tracking(0.7)
            .foregroundStyle(BellwireTheme.proActiveInk)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(BellwireTheme.accent.opacity(0.12), in: Capsule())
            .overlay {
                Capsule().stroke(BellwireTheme.proActiveBorder, lineWidth: 1)
            }
    }
}

private struct AgentConnectionRowView: View {
    @Environment(\.locale) private var locale
    @State private var showsDisconnectConfirmation = false
    let connection: AgentConnectionRecord
    let isRevoking: Bool
    let disconnect: () -> Void

    var body: some View {
        HStack(spacing: BellwireSpacing.small) {
            Image(systemName: "terminal")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(BellwireTheme.secondaryInk)
                .frame(width: 32, height: 32)
                .background(
                    BellwireTheme.raisedSurface,
                    in: RoundedRectangle(
                        cornerRadius: BellwireRadius.small,
                        style: .continuous
                    )
                )

            VStack(alignment: .leading, spacing: 3) {
                Text(connection.name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(BellwireTheme.ink)
                    .lineLimit(1)
                activityLabel
                    .font(.caption)
                    .foregroundStyle(BellwireTheme.mutedInk)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            StatusBadgeView(
                text: "Active",
                color: BellwireTheme.success,
                showsDot: true
            )

            Button(role: .destructive) {
                showsDisconnectConfirmation = true
            } label: {
                Group {
                    if isRevoking {
                        ProgressView()
                            .controlSize(.small)
                            .tint(BellwireTheme.danger)
                    } else {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .bold))
                    }
                }
                .frame(width: 40, height: 40)
                .foregroundStyle(BellwireTheme.danger)
                .background(
                    BellwireTheme.danger.opacity(0.08),
                    in: Circle()
                )
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(isRevoking)
            .accessibilityLabel(Text("Disconnect \(connection.name)"))
            .accessibilityHint("Revokes this Agent’s Bellwire access")
        }
        .padding(.vertical, BellwireSpacing.compact)
        .alert("Disconnect Agent?", isPresented: $showsDisconnectConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Disconnect", role: .destructive, action: disconnect)
        } message: {
            Text("“\(connection.name)” will immediately lose access to Bellwire. Your projects and data will remain.")
        }
    }

    @ViewBuilder
    private var activityLabel: some View {
        if let date = connection.lastUsedDate {
            Text("Last used") + Text(" \(BellwireDateFormatting.relative(date, locale: locale))")
        } else if let date = connection.createdDate {
            Text("Connected") + Text(" \(BellwireDateFormatting.relative(date, locale: locale))")
        } else {
            Text("Connected")
        }
    }
}

private struct DeleteAccountView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var showsFinalConfirmation = false
    @State private var isDeletingAccount = false
    @State private var deletionError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: BellwireSpacing.section) {
                VStack(alignment: .leading, spacing: BellwireSpacing.standard) {
                    Image(systemName: "person.crop.circle.badge.minus")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(BellwireTheme.danger)
                        .frame(width: 58, height: 58)
                        .background(BellwireTheme.danger.opacity(0.12), in: Circle())

                    Text("Delete your account?")
                        .font(BellwireTypography.pageTitle)
                        .foregroundStyle(BellwireTheme.ink)
                        .accessibilityAddTraits(.isHeader)

                    Text("Your Bellwire account and all connected data will be permanently deleted.")
                        .font(.body)
                        .foregroundStyle(BellwireTheme.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: 0) {
                    Text("This will delete")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(BellwireTheme.secondaryInk)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, BellwireSpacing.standard)
                        .padding(.top, BellwireSpacing.standard)
                        .padding(.bottom, BellwireSpacing.small)

                    Divider()
                        .overlay(BellwireTheme.separator)
                    deletionItem(icon: "square.stack.3d.up", title: "Projects and live cards")
                    deletionDivider
                    deletionItem(icon: "tray.full", title: "Events and notification history")
                    deletionDivider
                    deletionItem(icon: "iphone", title: "Registered devices")
                    deletionDivider
                    deletionItem(icon: "link", title: "Agent connections and access tokens")
                }
                .background(
                    BellwireTheme.surface,
                    in: RoundedRectangle(
                        cornerRadius: BellwireRadius.card,
                        style: .continuous
                    )
                )
                .clipShape(
                    RoundedRectangle(
                        cornerRadius: BellwireRadius.card,
                        style: .continuous
                    )
                )
                .overlay {
                    RoundedRectangle(cornerRadius: BellwireRadius.card, style: .continuous)
                        .stroke(BellwireTheme.separator, lineWidth: 1)
                }

                HStack(alignment: .top, spacing: BellwireSpacing.small) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(BellwireTheme.danger)
                    Text("This action cannot be undone. You will need to create a new account to use Bellwire again.")
                        .font(.subheadline)
                        .foregroundStyle(BellwireTheme.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let deletionError {
                    ErrorBanner(message: deletionError) {
                        self.deletionError = nil
                    }
                }

                Button {
                    showsFinalConfirmation = true
                } label: {
                    HStack(spacing: BellwireSpacing.compact) {
                        if isDeletingAccount {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "trash")
                        }
                        Text(isDeletingAccount ? "Deleting account…" : "Permanently delete account")
                            .font(.body.weight(.semibold))
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 52)
                    .background(BellwireTheme.danger, in: RoundedRectangle(cornerRadius: BellwireRadius.control, style: .continuous))
                }
                .buttonStyle(PressableButtonStyle())
                .disabled(isDeletingAccount)
            }
            .padding(.horizontal, BellwireSpacing.roomy)
            .padding(.top, BellwireSpacing.standard)
            .padding(.bottom, BellwireSpacing.large)
        }
        .bellwirePageBackground()
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .interactiveDismissDisabled(isDeletingAccount)
        .alert(
            "Permanently delete your Bellwire account?",
            isPresented: $showsFinalConfirmation
        ) {
            Button("Delete account and data", role: .destructive) {
                deleteAccount()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently deletes your account and all Bellwire data. This action cannot be undone.")
        }
    }

    private func deletionItem(icon: String, title: String) -> some View {
        HStack(spacing: BellwireSpacing.small) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(BellwireTheme.danger)
                .frame(width: 32, height: 32)
                .background(
                    BellwireTheme.danger.opacity(0.09),
                    in: RoundedRectangle(
                        cornerRadius: BellwireRadius.small,
                        style: .continuous
                    )
                )
            Text(LocalizedStringKey(title))
                .font(.subheadline)
                .foregroundStyle(BellwireTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .padding(.horizontal, BellwireSpacing.standard)
        .accessibilityElement(children: .combine)
    }

    private var deletionDivider: some View {
        Divider()
            .overlay(BellwireTheme.separator)
            .padding(.leading, 60)
    }

    private func deleteAccount() {
        guard !isDeletingAccount else { return }
        deletionError = nil
        isDeletingAccount = true
        Task {
            let deleted = await model.deleteAccount()
            isDeletingAccount = false
            if deleted {
                dismiss()
            } else {
                deletionError = model.errorMessage ?? String(localized: "Unable to delete account. Please try again.")
            }
        }
    }
}

private struct FeedbackMailView: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    let recipient: String
    let subject: String
    let body: String

    func makeCoordinator() -> Coordinator {
        Coordinator(isPresented: $isPresented)
    }

    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let controller = MFMailComposeViewController()
        controller.mailComposeDelegate = context.coordinator
        controller.setToRecipients([recipient])
        controller.setSubject(subject)
        controller.setMessageBody(body, isHTML: false)
        return controller
    }

    func updateUIViewController(_ uiViewController: MFMailComposeViewController, context: Context) {}

    final class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        @Binding private var isPresented: Bool

        init(isPresented: Binding<Bool>) {
            _isPresented = isPresented
        }

        func mailComposeController(
            _ controller: MFMailComposeViewController,
            didFinishWith result: MFMailComposeResult,
            error: Error?
        ) {
            isPresented = false
        }
    }
}

struct BindingCodeSheet: View {
    @Environment(\.locale) private var locale
    let binding: BindingResponse
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var copiedAction: CopiedBindingAction?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: BellwireSpacing.section) {
                HStack {
                    BellwireMark(size: 42)
                    Spacer()
                    Button("Done") { dismiss() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(BellwireTheme.accent)
                        .frame(minHeight: 44)
                        .buttonStyle(PressableButtonStyle())
                }

                VStack(alignment: .leading, spacing: BellwireSpacing.small) {
                    Text("Binding code")
                        .bellwireTechnicalLabel()
                    Text("Hand this to\nyour Agent.")
                        .font(BellwireTypography.pageTitle)
                        .foregroundStyle(BellwireTheme.ink)
                        .accessibilityAddTraits(.isHeader)
                    Text("This code is single-use. Once your Agent connects, project events can start flowing into Bellwire.")
                        .font(.subheadline)
                        .foregroundStyle(BellwireTheme.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }

                codeCard
                instructionCard

                VStack(spacing: BellwireSpacing.small) {
                    PrimaryButton(
                        title: copiedAction == .instruction ? "Instruction copied" : "Copy instruction",
                        systemImage: copiedAction == .instruction ? "checkmark" : BellwireIcons.copy
                    ) {
                        UIPasteboard.general.string = instruction
                        copiedAction = .instruction
                        BellwireHaptics.success()
                    }
                    SecondaryButton(
                        title: copiedAction == .code ? "Code copied" : "Copy code only",
                        systemImage: copiedAction == .code ? "checkmark" : BellwireIcons.copy
                    ) {
                        UIPasteboard.general.string = binding.code
                        copiedAction = .code
                        BellwireHaptics.success()
                    }
                }
            }
            .padding(BellwireSpacing.page)
        }
        .bellwirePageBackground()
    }

    private var codeCard: some View {
        VStack(spacing: BellwireSpacing.standard) {
            HStack {
                Text("Expires")
                    .bellwireTechnicalLabel()
                Spacer()
                if let expiryDate {
                    Text(BellwireDateFormatting.relative(
                        expiryDate,
                        locale: locale,
                        clampsNearNow: false
                    ))
                        .font(BellwireTypography.technicalStrong)
                        .monospacedDigit()
                        .foregroundStyle(BellwireTheme.accent)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 7) { codeDigits }
                Text(binding.code.chunkedPairs)
                    .font(.system(.title, design: .monospaced, weight: .bold))
                    .tracking(3)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity)
        }
        .foregroundStyle(BellwireTheme.ink)
        .padding(BellwireSpacing.standard)
        .background {
            RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)
                .fill(BellwireTheme.surface)
                .overlay(BellwireTheme.amberGlow.clipShape(RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)))
        }
        .overlay {
            RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)
                .stroke(BellwireTheme.strongSeparator, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Binding code \(binding.code)")
    }

    private var codeDigits: some View {
        ForEach(Array(binding.code.enumerated()), id: \.offset) { _, digit in
            Text(String(digit))
                .font(.system(.title2, design: .serif, weight: .semibold))
                .monospacedDigit()
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(BellwireTheme.background, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .stroke(BellwireTheme.strongSeparator, lineWidth: 1)
                }
        }
    }

    private var instructionCard: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.small) {
            Text("Say this to your Agent")
                .bellwireTechnicalLabel()
            Text("> ")
                .foregroundStyle(BellwireTheme.mutedInk)
            + Text("Connect Bellwire with code ")
                .foregroundStyle(BellwireTheme.ink)
            + Text(binding.code)
                .foregroundStyle(BellwireTheme.accent)
            + Text(".")
                .foregroundStyle(BellwireTheme.ink)
        }
        .font(.system(.body, design: .monospaced))
        .padding(BellwireSpacing.standard)
        .frame(maxWidth: .infinity, alignment: .leading)
        .bellwireSurface(radius: BellwireRadius.card, elevated: false)
        .textSelection(.enabled)
    }

    private var instruction: String {
        "Connect Bellwire with code \(binding.code)."
    }

    private var expiryDate: Date? {
        ISO8601DateFormatter.bellwireDate(from: binding.expiresAt)
    }
}

private enum CopiedBindingAction {
    case instruction
    case code
}

private struct AgentInstructionSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.roomy) {
            HStack {
                Text("Instruct your Agent")
                    .font(.system(.title2, design: .serif, weight: .regular))
                    .foregroundStyle(BellwireTheme.ink)
                Spacer()
                Button("Done") { dismiss() }
                    .foregroundStyle(BellwireTheme.accent)
                    .frame(minHeight: 44)
            }
            Text("1. Generate a binding code.\n2. Open the project with your Agent.\n3. Say: “Connect Bellwire with code …”\n4. Let the Agent configure the supported event and live-surface calls.")
                .font(.body)
                .foregroundStyle(BellwireTheme.secondaryInk)
                .lineSpacing(6)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .padding(BellwireSpacing.page)
        .bellwirePageBackground()
    }
}

private extension String {
    var chunkedPairs: String {
        stride(from: 0, to: count, by: 2).map { offset in
            let start = index(startIndex, offsetBy: offset)
            let end = index(start, offsetBy: min(2, count - offset))
            return String(self[start..<end])
        }.joined(separator: " ")
    }
}
