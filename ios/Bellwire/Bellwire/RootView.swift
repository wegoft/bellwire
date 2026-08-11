// SPDX-License-Identifier: MPL-2.0
import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("notificationOnboardingSeen") private var notificationOnboardingSeen = false

    var body: some View {
        Group {
#if DEBUG
            if Self.showsPaywallPreview {
                PaywallView(appAccountToken: nil)
            } else {
                authenticatedContent
            }
#else
            authenticatedContent
#endif
        }
        .background(BellwireTheme.background.ignoresSafeArea())
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: model.isAuthenticated)
        .task { await model.bootstrap() }
    }

    @ViewBuilder
    private var authenticatedContent: some View {
        if !model.isAuthenticated {
            WelcomeView()
                .transition(.opacity.combined(with: .move(edge: .bottom)))
        } else if !notificationOnboardingSeen {
            NotificationOnboardingView(isComplete: $notificationOnboardingSeen)
                .transition(.opacity.combined(with: .move(edge: .trailing)))
        } else if model.hasCompletedInitialDashboardLoad && !model.hasLoadedDashboardSuccessfully {
            InitialDashboardFailureView(
                message: model.errorMessage ?? "Check your connection and try again.",
                isRetrying: model.isLoading
            ) {
                Task { await model.loadDashboard(showLoading: true) }
            }
            .transition(.opacity)
        } else {
            MainTabView()
                .transition(.opacity)
        }
    }

#if DEBUG
    private static var showsPaywallPreview: Bool {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-BellwireScreenshot"),
              arguments.indices.contains(index + 1) else {
            return false
        }
        return arguments[index + 1] == "paywall"
    }
#endif
}

struct MainTabView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selection: MainTab = .home
    @State private var eventsFilter: EventFilter = .all

    init() {
#if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-BellwireScreenshot"),
           arguments.indices.contains(index + 1) {
            let tab: MainTab
            switch arguments[index + 1] {
            case "projects", "projects-empty": tab = .projects
            case "events": tab = .events
            case "settings": tab = .settings
            default: tab = .home
            }
            _selection = State(initialValue: tab)
        }
#endif
    }

    var body: some View {
        TabView(selection: $selection) {
            InboxView { preferUnread in
                eventsFilter = preferUnread ? .unread : .all
                selection = .events
            }
                .tag(MainTab.home)
                .tabItem { Label("Home", systemImage: BellwireIcons.home) }
            ProjectsView()
                .tag(MainTab.projects)
                .tabItem { Label("Projects", systemImage: BellwireIcons.projects) }
            EventsView(filter: $eventsFilter)
                .tag(MainTab.events)
                .tabItem { Label("Events", systemImage: BellwireIcons.events) }
                .badge(model.unreadCount)
            SettingsView()
                .tag(MainTab.settings)
                .tabItem { Label("Settings", systemImage: BellwireIcons.settings) }
        }
        .toolbarBackground(BellwireTheme.surface, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .onChange(of: model.pendingEventID) { _, eventID in
            if eventID != nil { selection = .home }
        }
        .onChange(of: model.pendingProjectID, initial: true) { _, projectID in
            if projectID != nil { selection = .home }
        }
        .onChange(of: model.pendingModeRequestNavigation) { _, shouldOpen in
            guard shouldOpen else { return }
            selection = .settings
            model.pendingModeRequestNavigation = false
        }
        .onAppear {
            guard model.pendingModeRequestNavigation else { return }
            selection = .settings
            model.pendingModeRequestNavigation = false
        }
        .sheet(item: $model.binding) { binding in
            BindingCodeSheet(binding: binding)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }
}

private struct InitialDashboardFailureView: View {
    @Environment(\.locale) private var locale
    let message: String
    let isRetrying: Bool
    let retry: () -> Void

    var body: some View {
        VStack(spacing: BellwireSpacing.roomy) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(BellwireTheme.danger)
                .frame(width: 64, height: 64)
                .background(
                    BellwireTheme.danger.opacity(0.09),
                    in: RoundedRectangle(cornerRadius: BellwireRadius.largeCard, style: .continuous)
                )
                .accessibilityHidden(true)

            VStack(spacing: BellwireSpacing.compact) {
                Text(AppConfig.branded("Bellwire couldn’t load", locale: locale))
                    .font(.title2)
                    .bold()
                    .foregroundStyle(BellwireTheme.ink)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(LocalizedStringKey(message))
                    .font(.body)
                    .foregroundStyle(BellwireTheme.secondaryInk)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            PrimaryButton(
                title: isRetrying ? "Trying again…" : "Try again",
                systemImage: "arrow.clockwise",
                isLoading: isRetrying,
                isDisabled: isRetrying,
                action: retry
            )
            .frame(maxWidth: 360)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(BellwireSpacing.page)
    }
}

private enum MainTab: Hashable {
    case home
    case projects
    case events
    case settings
}
