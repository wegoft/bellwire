// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("iOS Inbox preview", () => {
  it(
    "excludes server-declared sensitive fields and decodes legacy responses",
    () => {
      const temporaryDirectory = mkdtempSync(
        join(tmpdir(), "bellwire-ios-preview-"),
      );
      const executable = join(temporaryDirectory, "InboxPreviewCheck");
      try {
        execFileSync(
          "xcrun",
          [
            "swiftc",
            "ios/Bellwire/Bellwire/Models.swift",
            "test/InboxPreviewCheck.swift",
            "-o",
            executable,
          ],
          { stdio: "pipe" },
        );
        expect(() => execFileSync(executable, { stdio: "pipe" })).not.toThrow();
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "formats dates using the in-app language instead of the system locale",
    () => {
      const temporaryDirectory = mkdtempSync(
        join(tmpdir(), "bellwire-ios-locale-"),
      );
      const executable = join(temporaryDirectory, "LocalizationCheck");
      try {
        execFileSync(
          "xcrun",
          [
            "swiftc",
            "ios/Bellwire/Bellwire/Localization.swift",
            "test/LocalizationCheck.swift",
            "-o",
            executable,
          ],
          { stdio: "pipe" },
        );
        expect(() => execFileSync(executable, { stdio: "pipe" })).not.toThrow();
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      const settings = readFileSync(
        "ios/Bellwire/Bellwire/SettingsView.swift",
        "utf8",
      );
      const bindingSheet = settings.slice(
        settings.indexOf("struct BindingCodeSheet"),
        settings.indexOf("private enum CopiedBindingAction"),
      );
      expect(bindingSheet).toContain("clampsNearNow: false");
    },
    30_000,
  );

  it(
    "keeps Cloud project metadata authoritative across Direct cards",
    () => {
      const temporaryDirectory = mkdtempSync(
        join(tmpdir(), "bellwire-ios-consistency-"),
      );
      const executable = join(temporaryDirectory, "ProjectDataConsistencyCheck");
      try {
        execFileSync(
          "xcrun",
          [
            "swiftc",
            "ios/Bellwire/Bellwire/Models.swift",
            "ios/Bellwire/Bellwire/ProjectDataConsistency.swift",
            "test/ProjectDataConsistencyCheck.swift",
            "-o",
            executable,
          ],
          { stdio: "pipe" },
        );
        expect(() => execFileSync(executable, { stdio: "pipe" })).not.toThrow();
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }

      const model = readFileSync("ios/Bellwire/Bellwire/AppModel.swift", "utf8");
      const details = readFileSync("ios/Bellwire/Bellwire/DetailViews.swift", "utf8");
      const directSurfaceFetch = model.slice(
        model.indexOf("private func fetchDirectSurfaces"),
        model.indexOf("private func fetchDirectInbox"),
      );
      expect(model).toContain("ProjectDataConsistency.mergeProjects(");
      expect(model).toContain("ProjectDataConsistency.normalizeSurfaces(");
      expect(model).toContain("ProjectDataConsistency.normalizeEvents(");
      expect(model).not.toContain("DirectSurfaceResult");
      expect(directSurfaceFetch).not.toContain("ProjectSummary(");
      expect(directSurfaceFetch).not.toContain('status: "active"');
      expect(details).toContain("model.liveSurfaces.filter { $0.projectId == projectID }");
    },
    30_000,
  );

  it(
    "uses Direct live surfaces for Private project details and Cloud surfaces for Hosted projects",
    () => {
      const temporaryDirectory = mkdtempSync(
        join(tmpdir(), "bellwire-ios-project-surfaces-"),
      );
      const executable = join(temporaryDirectory, "ProjectOverviewSurfaceCheck");
      try {
        execFileSync(
          "xcrun",
          [
            "swiftc",
            "ios/Bellwire/Bellwire/Models.swift",
            "test/ProjectOverviewSurfaceCheck.swift",
            "-o",
            executable,
          ],
          { stdio: "pipe" },
        );
        expect(() => execFileSync(executable, { stdio: "pipe" })).not.toThrow();
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }

      const model = readFileSync("ios/Bellwire/Bellwire/AppModel.swift", "utf8");
      const loadProject = model.slice(
        model.indexOf("func loadProject(id:"),
        model.indexOf("func exportProject("),
      );
      expect(loadProject).toContain(
        "cloudOverview.resolvingDetailLiveSurfaces(from: liveSurfaces)",
      );
    },
    30_000,
  );

  it("refreshes current data from lifecycle and notification signals", () => {
    const app = readFileSync("ios/Bellwire/Bellwire/BellwireApp.swift", "utf8");
    const model = readFileSync("ios/Bellwire/Bellwire/AppModel.swift", "utf8");
    const push = readFileSync("ios/Bellwire/Bellwire/PushDelegate.swift", "utf8");

    expect(app).toContain(".onChange(of: scenePhase)");
    expect(model).toContain("func handleBecameActive() async");
    expect(model).toContain("private var dashboardLoadTask: Task<Void, Never>?");
    expect(model).toContain("private var sessionRefreshTask: Task<AuthSession, Error>?");
    expect(push.match(/handleRemoteNotification/gu)).toHaveLength(2);
  });

  it("loads live cards independently and keeps stale cards visible while refreshing", () => {
    const model = readFileSync("ios/Bellwire/Bellwire/AppModel.swift", "utf8");
    const inbox = readFileSync("ios/Bellwire/Bellwire/InboxViews.swift", "utf8");
    const details = readFileSync("ios/Bellwire/Bellwire/DetailViews.swift", "utf8");
    const loading = readFileSync(
      "ios/Bellwire/Bellwire/LiveSurfaceLoadingView.swift",
      "utf8",
    );
    const dashboardLoad = model.slice(
      model.indexOf("private func performDashboardLoad()"),
      model.indexOf("func loadEvent(id:"),
    );

    expect(model).toContain(
      "@Published private(set) var isLoadingLiveSurfaces = false",
    );
    expect(dashboardLoad.indexOf("liveSurfaces = sortedSurfaces(")).toBeLessThan(
      dashboardLoad.indexOf("let inboxResponse = try await inboxRequest"),
    );
    expect(dashboardLoad.indexOf("await refreshDirectConnections(userID: userID)")).toBeLessThan(
      dashboardLoad.indexOf("let (\n                deviceResponse"),
    );
    expect(inbox).toContain(
      "if model.isLoadingLiveSurfaces && model.liveSurfaces.isEmpty",
    );
    expect(inbox).toContain(
      "LiveSurfaceLoadingView(presentation: .compact)",
    );
    expect(inbox).not.toContain("LoadingEventRows(count: 2)");
    expect(details).toContain(
      "projectSurfaces.isEmpty && (isLoadingProject || model.isLoadingLiveSurfaces)",
    );
    expect(loading).toContain("@Environment(\\.accessibilityReduceMotion)");
    expect(loading).toContain("paused: scenePhase != .active");
  });

  it("uses the Bellwire mascot for pull-to-refresh feedback", () => {
    const inbox = readFileSync("ios/Bellwire/Bellwire/InboxViews.swift", "utf8");
    const details = readFileSync("ios/Bellwire/Bellwire/DetailViews.swift", "utf8");
    const settings = readFileSync("ios/Bellwire/Bellwire/SettingsView.swift", "utf8");
    const scrollView = readFileSync(
      "ios/Bellwire/Bellwire/BellwireRefreshScrollView.swift",
      "utf8",
    );
    const indicator = readFileSync(
      "ios/Bellwire/Bellwire/BellwireRefreshIndicator.swift",
      "utf8",
    );

    expect(inbox.match(/BellwireRefreshScrollView\(action: refresh\)/gu)).toHaveLength(3);
    expect(details).toContain("BellwireRefreshScrollView(action: refresh)");
    expect(settings).toContain("BellwireRefreshScrollView(action: refresh)");
    expect(inbox).not.toContain(".refreshable");
    expect(scrollView).toContain("private let refreshThreshold: CGFloat = 72");
    expect(scrollView).toContain(".onGeometryChange(for: CGFloat.self)");
    expect(scrollView).toContain("BellwireHaptics.selection()");
    expect(scrollView).toContain("isRefreshing || isCompleting");
    expect(scrollView).toContain("Task.sleep(for: .milliseconds(320))");
    expect(scrollView).toContain('.accessibilityAction(named: Text("Refresh"))');
    expect(indicator).toContain("MascotView(");
    expect(indicator).toContain("return .listening");
    expect(indicator).toContain("return .connecting");
    expect(indicator).toContain("return .verified");
    expect(indicator).toContain("@Environment(\\.accessibilityReduceMotion)");
    expect(indicator).toContain("animates: isRefreshing && !reduceMotion");
    expect(indicator).not.toContain("Circle()");
  });

  it("recovers a missing Private manifest before refreshing encrypted envelopes", () => {
    const model = readFileSync("ios/Bellwire/Bellwire/AppModel.swift", "utf8");
    const project = readFileSync(
      "ios/Bellwire/Bellwire.xcodeproj/project.pbxproj",
      "utf8",
    );
    const recovery = model.slice(
      model.indexOf("let missingManifestProjects"),
      model.indexOf("await synchronizeNativeDisplays()"),
    );
    const dashboardLoad = model.slice(
      model.indexOf("private func performDashboardLoad()"),
      model.indexOf("func loadEvent(id:"),
    );

    expect(dashboardLoad).toContain(
      "async let deviceKeyRegistration: Void? = try? registerCurrentDeviceKey(userID: userID)",
    );
    expect(dashboardLoad.indexOf("async let deviceKeyRegistration")).toBeLessThan(
      dashboardLoad.indexOf("async let projectRequest"),
    );
    expect(recovery.indexOf("_ = await deviceKeyRegistration")).toBeLessThan(
      recovery.indexOf("await requestDirectConnectionRecovery("),
    );
    expect(recovery).toContain("project.deliveryMode == .private");
    expect(recovery).toContain("project.deliveryMode == .hosted");
    expect(recovery).toContain("await requestDirectConnectionRecovery(");
    expect(recovery.indexOf("await requestDirectConnectionRecovery(")).toBeLessThan(
      recovery.indexOf("await refreshDirectConnections(userID: userID)"),
    );
    expect(model).toContain("let installationId: String");
    expect(model).toContain("let appVersion: String");
    expect(model).toContain("let buildNumber: String");
    expect(model).toContain("let notificationAuthorization: String");
    expect(model).toContain('"v1/device-keys"');
    expect(model).toContain("identity.descriptor(installationID: installationID)");
    expect(model).toContain('"v1/projects/\\(project.id)/direct-connection-recovery"');

    const buildNumbers = [...project.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/gu)]
      .map((match) => match[1]);
    expect(buildNumbers.length).toBeGreaterThan(0);
    expect(new Set(buildNumbers)).toEqual(new Set(["15"]));

    const marketingVersions = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/gu)]
      .map((match) => match[1]);
    expect(marketingVersions.length).toBeGreaterThan(0);
    expect(new Set(marketingVersions)).toEqual(new Set(["1.0.2"]));
  });

  it("does not require Apple's optional authorization code to sign in", () => {
    const model = readFileSync("ios/Bellwire/Bellwire/AppModel.swift", "utf8");
    const signIn = model.slice(
      model.indexOf("func completeAppleAuthorization"),
      model.indexOf("func loadDashboard"),
    );

    expect(signIn).toContain("guard let tokenData = credential.identityToken");
    expect(signIn).toContain("guard let nonce = currentNonce");
    expect(signIn).toContain(
      "let authorizationCode = credential.authorizationCode",
    );
    expect(signIn).toContain("authorizationCode: authorizationCode");
    expect(signIn).not.toContain("guard let authorizationCode");
    expect(signIn).not.toContain("let codeData = credential.authorizationCode");
    expect(signIn).not.toContain("signOut()");
  });

  it("keeps the project fallback visible and persists successful remote logos", () => {
    const components = readFileSync("ios/Bellwire/Bellwire/Components.swift", "utf8");
    const cache = readFileSync(
      "ios/Bellwire/Bellwire/ProjectLogoCache.swift",
      "utf8",
    );
    const fallback = components.indexOf("Text(initials)");
    const cachedLogo = components.indexOf("CachedProjectLogo(url: logoURL)");

    expect(fallback).toBeGreaterThan(-1);
    expect(cachedLogo).toBeGreaterThan(fallback);
    expect(components).not.toContain("AsyncImage");
    expect(cache).toContain("urls(for: .cachesDirectory");
    expect(cache).toContain("downloaded.write(to: fileURL, options: .atomic)");
    expect(cache).toContain("private var inFlight: [URL: Task<Data?, Never>]");
    expect(cache).toContain("data.count <= maximumImageBytes");
  });

  it("presents the paywall immediately while StoreKit loads in a large sheet", () => {
    const paywall = readFileSync("ios/Bellwire/Bellwire/PaywallView.swift", "utf8");
    const purchases = readFileSync(
      "ios/Bellwire/Bellwire/PurchaseManager.swift",
      "utf8",
    );
    const chinese = readFileSync(
      "ios/Bellwire/Bellwire/zh-Hans.lproj/Localizable.strings",
      "utf8",
    );
    const settings = readFileSync("ios/Bellwire/Bellwire/SettingsView.swift", "utf8");
    const details = readFileSync("ios/Bellwire/Bellwire/DetailViews.swift", "utf8");

    expect(paywall.indexOf("appeared = true")).toBeLessThan(
      paywall.indexOf("await purchaseManager.prepare()"),
    );
    expect(settings).toContain(".sheet(isPresented: $showsPaywall)");
    expect(details).toContain(".sheet(isPresented: $showsPaywall)");
    expect(settings).toContain(".presentationCornerRadius(BellwireRadius.hero)");
    expect(details).toContain(".presentationCornerRadius(BellwireRadius.hero)");
    expect(paywall).toContain("@Environment(\\.locale) private var locale");
    expect(paywall).toContain(
      'String(localized: "Continue with yearly", locale: locale)',
    );
    expect(paywall).toContain("Text(localized(errorMessage))");
    expect(paywall).toContain('Text(localized("More room for every signal."))');
    expect(paywall).toContain(
      'Text(String(localized: "Price unavailable", locale: locale))',
    );
    expect(paywall).toContain(
      "purchaseManager.isUnavailableInCurrentStorefront",
    );
    expect(purchases).toContain("func title(locale: Locale) -> String");
    expect(purchases).not.toContain("errorMessage = String(localized:");
    expect(chinese).toContain(
      '"Bellwire could not refresh your plan status." = "Bellwire 暂时无法刷新你的套餐状态。";',
    );
  });

  it("uses a structured delete-account summary card that remains readable on small screens", () => {
    const settings = readFileSync("ios/Bellwire/Bellwire/SettingsView.swift", "utf8");
    const deletePage = settings.slice(settings.indexOf("private struct DeleteAccountView"));

    expect(deletePage).not.toContain('Image(systemName: "trash.fill")');
    expect(deletePage).toContain('Text("This will delete")');
    expect(deletePage).toContain(".font(.subheadline.weight(.semibold))");
    expect(deletePage).toContain(".padding(.top, BellwireSpacing.standard)");
    expect(deletePage).toContain(".padding(.bottom, BellwireSpacing.small)");
    expect(deletePage).toContain("deletionDivider");
    expect(deletePage).toContain(".frame(maxWidth: .infinity, minHeight: 56");
    expect(deletePage).toContain(".fixedSize(horizontal: false, vertical: true)");
    expect(deletePage).toContain(".padding(.leading, 60)");
  });

  it("keeps routine groups flat and collapses technical detail by default", () => {
    const theme = readFileSync("ios/Bellwire/Bellwire/Theme.swift", "utf8");
    const components = readFileSync("ios/Bellwire/Bellwire/Components.swift", "utf8");
    const inbox = readFileSync("ios/Bellwire/Bellwire/InboxViews.swift", "utf8");
    const details = readFileSync("ios/Bellwire/Bellwire/DetailViews.swift", "utf8");
    const paywall = readFileSync("ios/Bellwire/Bellwire/PaywallView.swift", "utf8");
    const chinese = readFileSync(
      "ios/Bellwire/Bellwire/zh-Hans.lproj/Localizable.strings",
      "utf8",
    );

    expect(theme).toContain("func bellwireListGroup()");
    expect(theme).toContain("elevated: Bool = false");
    expect(components).toContain("struct TechnicalDisclosure");
    expect(components).toContain("@State private var isExpanded = false");
    expect(
      details.match(/TechnicalDisclosure\(title: "Technical details"\)/gu),
    ).toHaveLength(2);
    expect(details).toContain('Image(systemName: "ellipsis.circle")');
    expect(details).toContain(
      'Text(project.status == "paused" ? "Resuming…" : "Pausing…")',
    );
    expect(details).toContain(
      ".disabled(isUpdating || isExporting || isDeleting)",
    );
    expect(inbox).toContain('"Connect a project"');
    expect(inbox).not.toContain("StrokeStyle(lineWidth: 1, dash:");
    expect(paywall).toContain(".safeAreaInset(edge: .bottom)");
    expect(chinese).toContain('"Technical details" = "技术详情";');
  });

  it("uses a dedicated warm foreground for primary button content", () => {
    const theme = readFileSync("ios/Bellwire/Bellwire/Theme.swift", "utf8");
    const components = readFileSync("ios/Bellwire/Bellwire/Components.swift", "utf8");
    const primaryButton = components.slice(
      components.indexOf("struct PrimaryButton"),
      components.indexOf("struct SecondaryButton"),
    );

    expect(primaryButton).not.toContain("BellwireTheme.accentInk");
    expect(primaryButton).not.toContain("BellwireTheme.accent, in:");
    expect(theme).toContain("static let primaryButtonForeground = adaptiveColor(");
    expect(theme).toContain("static let primaryButtonBackground = adaptiveColor(");
    expect(primaryButton).toContain("BellwireTheme.primaryButtonBackground");
    expect(
      primaryButton.match(/BellwireTheme\.primaryButtonForeground/gu),
    ).toHaveLength(2);
  });

  it("keeps active Pro premium but as a restrained standard settings row", () => {
    const settings = readFileSync("ios/Bellwire/Bellwire/SettingsView.swift", "utf8");
    const theme = readFileSync("ios/Bellwire/Bellwire/Theme.swift", "utf8");
    const zhHans = readFileSync(
      "ios/Bellwire/Bellwire/zh-Hans.lproj/Localizable.strings",
      "utf8",
    );
    const accountOverview = settings.slice(
      settings.indexOf("private var accountOverviewSection"),
      settings.indexOf("private var accountCard"),
    );
    const proActiveRow = settings.slice(
      settings.indexOf("private struct ProActiveSettingsRow"),
      settings.indexOf("private struct AgentConnectionRowView"),
    );

    expect(accountOverview).toContain("if hasPro {");
    expect(accountOverview).toContain("ProActiveSettingsRow()");
    expect(accountOverview).toContain("if model.entitlement?.isSelfHosted == true {");
    expect(accountOverview).toContain('icon: "sparkles"');
    expect(accountOverview).toContain('title: "Upgrade to \\(AppConfig.displayName) Pro"');
    expect(accountOverview).not.toContain('icon: hasPro ? "checkmark.seal.fill" : "sparkles"');

    expect(theme).not.toContain("static let proActiveSurface = adaptiveColor(");
    expect(theme).not.toContain("static let proActiveBorder = adaptiveColor(");
    expect(theme).toContain("static let proActiveInk = adaptiveColor(");
    expect(proActiveRow).not.toContain(".foregroundStyle(BellwireTheme.accent)");
    expect(
      proActiveRow.match(/\.foregroundStyle\(BellwireTheme\.proActiveInk\)/gu),
    ).toHaveLength(1);
    expect(proActiveRow).toContain('Image(systemName: "checkmark.seal.fill")');
    expect(proActiveRow).not.toContain("activeBadge");
    expect(proActiveRow).not.toContain('Text("PRO ACTIVE")');
    expect(proActiveRow).not.toContain("RoundedRectangle");
    expect(proActiveRow).not.toContain("Capsule");
    expect(proActiveRow).not.toContain(".background");
    expect(proActiveRow).not.toContain(".overlay");
    expect(proActiveRow).not.toContain(".stroke(");
    expect(proActiveRow).not.toContain(".frame(width: 40, height: 40)");
    expect(proActiveRow).toContain('Text("Manage \\(AppConfig.displayName) Pro")');
    expect(proActiveRow).toContain('Text("Your Pro access is active")');
    expect(proActiveRow).toContain('Image(systemName: "chevron.right")');
    expect(proActiveRow).toContain(".foregroundStyle(BellwireTheme.mutedInk)");
    expect(proActiveRow).toContain(".padding(.vertical, 13)");
    expect(proActiveRow).toContain(".frame(maxWidth: .infinity, minHeight: 44");
    expect(proActiveRow).toContain(
      '.accessibilityLabel(Text("Manage \\(AppConfig.displayName) Pro"))',
    );
    expect(proActiveRow).toContain('.accessibilityValue(Text("Your Pro access is active"))');
    expect(zhHans).not.toContain('"PRO ACTIVE" = "PRO 已生效";');
  });

  it("uses one light copy action and a weaker compact code action", () => {
    const settings = readFileSync("ios/Bellwire/Bellwire/SettingsView.swift", "utf8");
    const zhHans = readFileSync(
      "ios/Bellwire/Bellwire/zh-Hans.lproj/Localizable.strings",
      "utf8",
    );
    const bindingSheet = settings.slice(
      settings.indexOf("struct BindingCodeSheet"),
      settings.indexOf("private enum CopiedBindingAction"),
    );
    const copyActions = bindingSheet.slice(
      bindingSheet.indexOf("private var copyActions"),
      bindingSheet.indexOf("private var codeCard"),
    );

    expect(bindingSheet).toContain("copyActions");
    expect(copyActions.match(/Button \{/gu)).toHaveLength(2);
    expect(copyActions).not.toContain("PrimaryButton(");
    expect(copyActions).not.toContain("SecondaryButton(");
    expect(copyActions).not.toContain("minHeight: 52");
    expect(copyActions).toContain(".frame(maxWidth: .infinity, minHeight: 48)");
    expect(copyActions).toContain(".frame(minHeight: 44)");
    expect(copyActions).toContain("BellwireTheme.surface");
    expect(copyActions).toContain(".stroke(BellwireTheme.strongSeparator, lineWidth: 1)");
    expect(copyActions).toContain(".foregroundStyle(BellwireTheme.ink)");
    expect(copyActions).toContain(".foregroundStyle(BellwireTheme.secondaryInk)");
    expect(copyActions.match(/\? "checkmark" : BellwireIcons\.copy/gu)).toHaveLength(2);
    expect(copyActions).toContain("UIPasteboard.general.string = instruction");
    expect(copyActions).toContain("UIPasteboard.general.string = binding.code");
    expect(copyActions.match(/BellwireHaptics\.success\(\)/gu)).toHaveLength(2);
    expect(zhHans).toContain('"Copy instruction" = "复制接入指令";');
    expect(zhHans).toContain('"Instruction copied" = "指令已复制";');
    expect(zhHans).toContain('"Copy code only" = "仅复制绑定码";');
    expect(zhHans).toContain('"Code copied" = "绑定码已复制";');
  });

  it("shows the app shell while the initial dashboard loads", () => {
    const root = readFileSync("ios/Bellwire/Bellwire/RootView.swift", "utf8");
    const model = readFileSync("ios/Bellwire/Bellwire/AppModel.swift", "utf8");
    const inbox = readFileSync("ios/Bellwire/Bellwire/InboxViews.swift", "utf8");
    const settings = readFileSync("ios/Bellwire/Bellwire/SettingsView.swift", "utf8");
    const authenticatedContent = root.slice(
      root.indexOf("private var authenticatedContent"),
      root.indexOf("#if DEBUG", root.indexOf("private var authenticatedContent")),
    );

    expect(model).toContain(
      "@Published private(set) var hasCompletedInitialDashboardLoad = false",
    );
    expect(model).toContain(
      "@Published private(set) var hasLoadedDashboardSuccessfully = false",
    );
    expect(model).toContain(
      "if isInitialLoad { hasCompletedInitialDashboardLoad = true }",
    );
    expect(model).toContain("hasLoadedDashboardSuccessfully = true");
    expect(model).toContain(
      "isAuthenticated && !hasCompletedInitialDashboardLoad",
    );
    expect(authenticatedContent).not.toContain("InitialDashboardLoadingView");
    expect(authenticatedContent).toContain(
      "else if model.hasCompletedInitialDashboardLoad && !model.hasLoadedDashboardSuccessfully",
    );
    expect(authenticatedContent.indexOf("InitialDashboardFailureView")).toBeLessThan(
      authenticatedContent.indexOf("MainTabView()"),
    );
    expect(inbox).toContain("if model.isPreparingInitialDashboard");
    expect(inbox).toContain("LoadingEventRows(count: 4)");
    expect(root).toContain("Task { await model.loadDashboard(showLoading: true) }");
    expect(root.match(/\.sheet\(item: \$model\.binding\)/gu)).toHaveLength(1);
    expect(inbox).not.toContain(".sheet(item: $model.binding)");
    expect(settings).not.toContain(".sheet(item: $model.binding)");
  });

  it("makes zero-project activation real-first and labels Hosted sample storage", () => {
    const inbox = readFileSync("ios/Bellwire/Bellwire/InboxViews.swift", "utf8");
    const english = readFileSync(
      "ios/Bellwire/Bellwire/en.lproj/Localizable.strings",
      "utf8",
    );
    const chinese = readFileSync(
      "ios/Bellwire/Bellwire/zh-Hans.lproj/Localizable.strings",
      "utf8",
    );
    const activation = inbox.slice(
      inbox.indexOf("private struct FirstSessionActivationView"),
      inbox.indexOf("private struct FirstSignalPromptView"),
    );
    const home = inbox.slice(
      inbox.indexOf("struct InboxView"),
      inbox.indexOf("private struct GreetingEntranceModifier"),
    );
    const projectsEmpty = inbox.slice(
      inbox.indexOf("private struct ProjectConnectionEmptyView"),
      inbox.indexOf("private enum ProjectFilter"),
    );

    expect(home).toContain("if model.projects.isEmpty {");
    expect(home).toContain("firstSessionActivation");
    expect(home).toContain("homeHeader\n                        digestStrip");
    expect(activation).toContain('"Connect your Agent"');
    expect(home).toContain("await model.createBinding()");
    expect(activation).toContain('"Try a Hosted demo"');
    expect(activation).toContain(
      '"Creates revenue, service health, and lifecycle samples in one project."',
    );
    expect(activation).toContain(
      '"Sample content is stored in Bellwire Cloud. Delete the demo at any time."',
    );
    expect(activation).toContain("ProgressView().tint(BellwireTheme.ink)");
    expect(inbox).not.toContain("private sample project");
    expect(projectsEmpty).toContain('"Generate binding code"');
    expect(projectsEmpty).toContain("action: connect");
    expect(inbox).toContain('"Ready for the first Signal"');
    expect(inbox).toContain("NavigationLink(value: AppRoute.project(project.id))");
    expect(inbox).toContain(
      '"A project is connected. Open it for connection details, then ask your Agent to send the first Signal."',
    );
    expect(english).toContain(
      '"Sample content is stored in Bellwire Cloud. Delete the demo at any time."',
    );
    expect(chinese).toContain(
      '"Sample content is stored in Bellwire Cloud. Delete the demo at any time." = "示例内容会存储在 Bellwire Cloud 中，你可以随时删除。";',
    );
    expect(chinese).toContain(
      '"Creates revenue, service health, and lifecycle samples in one project." = "在一个项目中创建收入、服务健康和生命周期示例。";',
    );
  });

  it("localizes the Welcome hero while keeping deployment legal links configurable", () => {
    const onboarding = readFileSync("ios/Bellwire/Bellwire/OnboardingViews.swift", "utf8");
    const english = readFileSync(
      "ios/Bellwire/Bellwire/en.lproj/Localizable.strings",
      "utf8",
    );
    const chinese = readFileSync(
      "ios/Bellwire/Bellwire/zh-Hans.lproj/Localizable.strings",
      "utf8",
    );
    const welcome = onboarding.slice(
      onboarding.indexOf("struct WelcomeView"),
      onboarding.indexOf("private struct WelcomePreviewRow"),
    );
    expect(welcome).toContain('Text("Signals from every project,\\non your iPhone.")');
    expect(welcome).toContain('"By continuing, you agree to Bellwire’s policies."');
    expect(welcome).toContain('Link("Terms of Service", destination: AppConfig.termsURL)');
    expect(welcome).toContain('Link("Privacy Policy", destination: AppConfig.privacyURL)');
    expect(welcome).not.toContain('+ Text("every project,")');
    expect(welcome).not.toContain(".foregroundColor(");
    expect(english).toContain(
      '"Signals from every project,\\non your iPhone." = "Signals from every project,\\non your iPhone.";',
    );
    expect(chinese).toContain(
      '"Signals from every project,\\non your iPhone." = "每个项目的 Signal，\\n尽在你的 iPhone。";',
    );
    expect(english).toContain(
      '"By continuing, you agree to Bellwire’s policies." = "By continuing, you agree to Bellwire’s policies.";',
    );
    expect(chinese).toContain(
      '"By continuing, you agree to Bellwire’s policies." = "继续即表示你同意 Bellwire 的相关政策。";',
    );
  });

  it("makes Notification permission state-aware in Settings", () => {
    const settings = readFileSync("ios/Bellwire/Bellwire/SettingsView.swift", "utf8");
    const onboarding = readFileSync("ios/Bellwire/Bellwire/OnboardingViews.swift", "utf8");
    const model = readFileSync("ios/Bellwire/Bellwire/AppModel.swift", "utf8");
    const handler = settings.slice(
      settings.indexOf("private func handleNotificationPermissionAction"),
      settings.indexOf("private func openPrivacyPolicy"),
    );
    const notificationRow = settings.slice(
      settings.indexOf("private struct NotificationPermissionSettingsRow"),
      settings.indexOf("private struct ProActiveSettingsRow"),
    );

    expect(handler).toContain("case .notDetermined:");
    expect(handler).toContain("await model.requestNotificationPermission()");
    expect(handler).toContain("case .denied:");
    expect(handler).toContain("openSystemSettings()");
    expect(model).toContain("func requestNotificationPermission() async -> Bool");
    expect(onboarding).toContain(
      "let requestCompleted = await model.requestNotificationPermission()",
    );
    expect(onboarding).toContain("if requestCompleted { isComplete = true }");
    expect(notificationRow).toContain("Button(action: action)");
    expect(notificationRow).toContain('hint: isRequesting ? "Requesting notification permission…" : hint');
    expect(notificationRow).toContain("ProgressView()");
    expect(notificationRow).toContain('"Requests notification permission from iOS"');
    expect(notificationRow).toContain('"Opens notification settings in iOS"');
  });

  it("keeps the mascot restrained, state-aware, and accessible", () => {
    const components = readFileSync("ios/Bellwire/Bellwire/Components.swift", "utf8");
    const onboarding = readFileSync("ios/Bellwire/Bellwire/OnboardingViews.swift", "utf8");
    const inbox = readFileSync("ios/Bellwire/Bellwire/InboxViews.swift", "utf8");
    const root = readFileSync("ios/Bellwire/Bellwire/RootView.swift", "utf8");
    const settings = readFileSync("ios/Bellwire/Bellwire/SettingsView.swift", "utf8");

    expect(components).toContain("Image(state.assetName)");
    expect(components).toContain('case .listening:\n            "MascotListening"');
    expect(components).toContain('case .connecting, .testing:\n            "MascotConnecting"');
    expect(components).toContain('case .accepted, .awaitingApproval:\n            "MascotAccepted"');
    expect(components).toContain('case .verified, .recovered:\n            "MascotVerified"');
    expect(components).toContain('case .issue:\n            "MascotIssue"');
    expect(components).not.toContain("case delivered");
    expect(components).toContain("@Environment(\\.accessibilityReduceMotion)");
    expect(components).toContain("@Environment(\\.scenePhase)");
    expect(components).toContain("paused: scenePhase != .active");
    expect(components).toContain("enum MascotFacing");
    expect(components).toContain("gestureProgress(for: displayedState, at: seconds)");
    expect(components).toContain("minimumInterval: 1.0 / 24.0");
    expect(components).toContain("BellwireAnimation.mascotArrival.delay(0.08)");
    expect(components).toContain("Ellipse()");
    expect(components).toContain(".allowsHitTesting(false)");
    expect(components).toContain(".accessibilityHidden(true)");
    expect(onboarding).toContain("size: 92,\n                            facing: .left");
    expect(onboarding).toContain("size: 64,\n                        facing: .right");
    expect(onboarding).toContain("state: mascotState,");
    expect(onboarding).toContain("mascotState = .listening");
    expect(onboarding).toContain("SignalBreathingGlow(intensity: 0.86)");
    expect(inbox).toMatch(/state: \.verified,[\s\S]{0,80}size: 58,[\s\S]{0,80}facing: \.right/u);
    expect(inbox).toContain("state: isGeneratingBinding ? .connecting : .allQuiet");
    expect(inbox).toContain(
      "state: isGeneratingBinding || isCreatingHostedDemo ? .connecting : .allQuiet",
    );
    expect(root).not.toContain("InitialDashboardLoadingView");
    expect(settings).toContain("state: isExpired ? .issue : .connecting");
    expect(settings).toContain("This binding code expired. Close this sheet and generate a new one.");
    expect(settings).toContain(".disabled(isExpired)");
    for (const asset of [
      "MascotSignalBird",
      "MascotListening",
      "MascotConnecting",
      "MascotAccepted",
      "MascotVerified",
      "MascotIssue",
    ]) {
      expect(existsSync(
        `ios/Bellwire/Bellwire/Assets.xcassets/${asset}.imageset/${asset}@3x.png`,
      )).toBe(true);
    }
  });

  it("uses the current brand mark and keeps Home and the paywall gradient-free", () => {
    const components = readFileSync("ios/Bellwire/Bellwire/Components.swift", "utf8");
    const inbox = readFileSync("ios/Bellwire/Bellwire/InboxViews.swift", "utf8");
    const paywall = readFileSync("ios/Bellwire/Bellwire/PaywallView.swift", "utf8");
    const surfaces = readFileSync("ios/Bellwire/Bellwire/SurfaceViews.swift", "utf8");
    const digestStrip = inbox.slice(
      inbox.indexOf("private var digestStrip"),
      inbox.indexOf("private var liveSection"),
    );
    const appIcon = readFileSync(
      "ios/Bellwire/Bellwire/Assets.xcassets/AppIcon.appiconset/BellwireIcon.png",
    );
    const brandLogo = readFileSync(
      "ios/Bellwire/Bellwire/Assets.xcassets/BellwireLogo.imageset/BellwireLogo.png",
    );

    expect(components).toContain('Image("BellwireLogo")');
    expect(components).not.toContain(".fill(BellwireTheme.brandOrange)");
    expect(brandLogo).toEqual(appIcon);
    expect(digestStrip).not.toContain("SignalBreathingGlow");
    expect(paywall).not.toContain("LinearGradient");
    expect(paywall).not.toContain("RadialGradient");
    expect(paywall).toContain("BellwireTheme.primaryButtonBackground");
    expect(paywall).toContain(
      "Unlimited Surfaces per project · Live Activities · export",
    );
    expect(surfaces).not.toContain("LinearGradient");
  });

  it("offers configurable widgets without truncating selectable cards", () => {
    const surfaceWidget = readFileSync(
      "ios/Bellwire/BellwireWidgets/BellwireSurfaceWidget.swift",
      "utf8",
    );
    const overviewWidget = readFileSync(
      "ios/Bellwire/BellwireWidgets/BellwireProjectOverviewWidget.swift",
      "utf8",
    );
    const entities = readFileSync(
      "ios/Bellwire/BellwireWidgets/BellwireWidgetEntities.swift",
      "utf8",
    );
    const intents = readFileSync(
      "ios/Bellwire/BellwireWidgets/BellwireWidgetIntents.swift",
      "utf8",
    );
    const nativeDisplay = readFileSync(
      "ios/Bellwire/Bellwire/NativeDisplayManager.swift",
      "utf8",
    );
    const model = readFileSync("ios/Bellwire/Bellwire/AppModel.swift", "utf8");

    expect(surfaceWidget).toContain("AppIntentConfiguration(");
    expect(surfaceWidget).toContain('let kind = "BellwireSurfaces"');
    expect(surfaceWidget).toContain("ViewThatFits(in: .vertical)");
    expect(surfaceWidget).toContain(".supportedFamilies([.systemSmall, .systemMedium])");
    expect(overviewWidget).toContain("AppIntentConfiguration(");
    expect(overviewWidget).toContain('let kind = "BellwireProjectOverview"');
    expect(overviewWidget).toContain(".supportedFamilies([.systemMedium])");
    expect(overviewWidget).toContain("ViewThatFits(in: .vertical)");
    expect(overviewWidget).toContain("showsDetails: false");
    expect(intents).toContain('@Parameter(title: "Project")');
    expect(intents).toContain('@Parameter(title: "Card")');
    expect(entities).toContain("@IntentParameterDependency<BellwireSurfaceWidgetIntent>");
    expect(nativeDisplay).toContain("surfaces: allNativeSurfaces");
    expect(nativeDisplay).not.toContain("allNativeSurfaces.prefix(");
    expect(nativeDisplay).toContain(
      'WidgetCenter.shared.reloadTimelines(ofKind: "BellwireProjectOverview")',
    );
    expect(model).toContain('url.host == "projects"');
    expect(model).toContain("pendingProjectID = id");
  });
});
