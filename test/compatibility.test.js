// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("published compatibility metadata", () => {
  it("tracks the current iOS marketing version and latest database migration", () => {
    const compatibility = readFileSync(join(repositoryRoot, "src/compatibility.ts"), "utf8");
    const project = readFileSync(
      join(repositoryRoot, "ios/Bellwire/Bellwire.xcodeproj/project.pbxproj"),
      "utf8",
    );
    const appVersions = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/gu)]
      .map((match) => match[1]);
    const latestMigration = readdirSync(join(repositoryRoot, "d1/business"))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .at(-1)
      ?.split("_")[0];

    expect(appVersions.length).toBeGreaterThan(0);
    expect(new Set(appVersions).size).toBe(1);
    expect(compatibility).toContain(`appVersion: "${appVersions[0]}"`);
    expect(compatibility).toContain(`schemaMigration: "d1-business-${latestMigration}"`);
  });
});
