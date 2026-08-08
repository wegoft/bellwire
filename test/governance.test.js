// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(path, "utf8");

describe("open-source governance and release contracts", () => {
  it("enforces DCO sign-offs with immutable Actions", () => {
    const workflow = read(".github/workflows/dco.yml");
    expect(workflow).toContain("Developer Certificate of Origin");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("node scripts/check-dco.mjs");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/u);
  });

  it("binds repository releases to versioned metadata, notices, and an SBOM", () => {
    const packageMetadata = JSON.parse(read("package.json"));
    const workflow = read(".github/workflows/release.yml");
    expect(packageMetadata.version).toBe("0.2.0");
    expect(read("CHANGELOG.md")).toContain(`## [${packageMetadata.version}] - `);
    expect(workflow).toContain("npm run release:check");
    expect(workflow).toContain("npm sbom --sbom-format=cyclonedx");
    expect(workflow).toContain("MIT No Attribution");
    expect(workflow).toContain("THIRD_PARTY_NOTICES.md");
  });

  it("publishes operational and API documentation without private paths", () => {
    const openapi = read("docs/openapi.yaml");
    expect(openapi).toContain("openapi: 3.1.0");
    expect(read("docs/telemetry.md")).toContain("POSTHOG_PROJECT_KEY");
    expect(read("docs/upgrading.md")).toContain("forward-only");
    expect(read("docs/security-model.md")).toContain("Incident response");
    expect(read("docs/lovable-ui-mapping.md")).not.toContain("/Users/");
  });

  it("keeps every public business API operation in OpenAPI", () => {
    const sourceOperations = [...read("src/app.ts").matchAll(
      /app\.(get|post|put|patch|delete)\("([^"]+)"/gu,
    )].map((match) => normalizeOperation(match[1], match[2]));
    const documentedOperations = [];
    let currentPath;
    for (const line of read("docs/openapi.yaml").split("\n")) {
      const path = /^ {2}(\/[^:]+(?:\{[^}]+\}[^:]*)?):$/u.exec(line);
      if (path) {
        currentPath = path[1];
        continue;
      }
      const method = /^ {4}(get|post|put|patch|delete):$/u.exec(line);
      if (method && currentPath) {
        documentedOperations.push(normalizeOperation(method[1], currentPath));
      }
    }
    expect(new Set(documentedOperations)).toEqual(new Set(sourceOperations));
  });
});

function normalizeOperation(method, path) {
  return `${method} ${path.replace(/:[^/]+|\{[^}]+\}/gu, "{parameter}")}`;
}
