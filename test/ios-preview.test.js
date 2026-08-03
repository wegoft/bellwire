// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

    expect(dashboardLoad).toContain("try? await registerCurrentDeviceKey(userID: userID)");
    expect(dashboardLoad.indexOf("try? await registerCurrentDeviceKey(userID: userID)")).toBeLessThan(
      dashboardLoad.indexOf("async let projectRequest"),
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
    expect(new Set(buildNumbers)).toEqual(new Set(["11"]));

    const marketingVersions = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/gu)]
      .map((match) => match[1]);
    expect(marketingVersions.length).toBeGreaterThan(0);
    expect(new Set(marketingVersions)).toEqual(new Set(["1.0.1"]));
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
    expect(signIn).toContain("if let authorizationCode");
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
});
