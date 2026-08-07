// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve("ios/Bellwire/Bellwire/PushDelegate.swift"),
  "utf8",
);

describe("iOS notification response routing", () => {
  it("uses the completion-handler delegate instead of the async bridge", () => {
    expect(source).toContain("withCompletionHandler completionHandler");
    expect(source).not.toMatch(/didReceive response: UNNotificationResponse\s*\) async/u);
  });

  it("finishes UIKit restoration before scheduling SwiftUI navigation", () => {
    const responseHandler = source.slice(
      source.indexOf("didReceive response: UNNotificationResponse"),
      source.indexOf("private func schedulePendingNotificationResponseIfPossible"),
    );
    expect(responseHandler.indexOf("completionHandler()"))
      .toBeLessThan(responseHandler.indexOf("pendingNotificationResponse ="));
  });

  it("holds cold-launch responses until the app is active", () => {
    expect(source).toContain("func applicationDidBecomeActive");
    expect(source).toContain(
      "guard isApplicationActive, model != nil, pendingNotificationResponse != nil",
    );
    expect(source).toContain("self.pendingNotificationResponse = nil");
  });
});
