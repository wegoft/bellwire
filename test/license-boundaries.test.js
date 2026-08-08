// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(path, "utf8");

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function expectSpdx(paths, identifier) {
  for (const path of paths) {
    expect(read(path), `${path} must declare its component license`).toContain(
      `SPDX-License-Identifier: ${identifier}`,
    );
  }
}

describe("multi-license boundaries", () => {
  it("ships the complete selected license texts", () => {
    expect(read("LICENSE")).toBe(read("LICENSES/AGPL-3.0-only.txt"));
    expect(read("LICENSES/AGPL-3.0-only.txt")).toContain(
      "GNU AFFERO GENERAL PUBLIC LICENSE",
    );
    expect(read("LICENSES/AGPL-3.0-only.txt")).toContain(
      "13. Remote Network Interaction; Use with the GNU General Public License.",
    );
    expect(read("LICENSES/MPL-2.0.txt")).toContain(
      "Mozilla Public License Version 2.0",
    );
    expect(read("LICENSES/Apache-2.0.txt")).toContain(
      "Apache License\n                           Version 2.0, January 2004",
    );
  });

  it("documents every component boundary and the trademark exclusion", () => {
    const policy = read("LICENSE.md");
    for (const identifier of ["AGPL-3.0-only", "MPL-2.0", "Apache-2.0"]) {
      expect(policy).toContain(identifier);
    }
    expect(policy).toContain("docs/private/**");
    expect(policy).toMatch(/Bellwire app icon\s+files remain brand assets/);
    expect(read("CHANGELOG.md")).toContain(
      "SPDX-License-Identifier: Apache-2.0",
    );
    expect(read("TRADEMARK.md")).toMatch(
      /must use their own app name, icon,\s+Bundle IDs, URL scheme, signing identity, and service domain/,
    );
  });

  it("marks Workers, D1, tooling, and JS/TS tests as AGPL", () => {
    const paths = [
      ...filesBelow("src").filter((path) => extname(path) === ".ts"),
      ...filesBelow("scripts").filter((path) => extname(path) === ".mjs"),
      ...filesBelow("d1").filter((path) => extname(path) === ".sql"),
      ...filesBelow("test").filter((path) =>
        [".js", ".ts"].includes(extname(path)),
      ),
    ];
    expectSpdx(paths, "AGPL-3.0-only");
  });

  it("marks native iOS source and Swift checks as MPL", () => {
    const paths = [
      ...filesBelow("ios").filter((path) => extname(path) === ".swift"),
      ...filesBelow("test").filter((path) => extname(path) === ".swift"),
    ];
    expectSpdx(paths, "MPL-2.0");
  });

  it("marks executable Skill and example code as Apache", () => {
    const paths = [
      ...filesBelow("skills/bellwire/scripts").filter(
        (path) => extname(path) === ".mjs",
      ),
      ...filesBelow("examples").filter((path) =>
        [".mjs", ".sh", ".ts"].includes(extname(path)),
      ),
    ];
    expectSpdx(paths, "Apache-2.0");
  });

  it("places a nearby license notice in every major component", () => {
    const notices = new Map([
      ["src/LICENSE.md", "AGPL-3.0-only"],
      ["scripts/LICENSE.md", "AGPL-3.0-only"],
      ["d1/LICENSE.md", "AGPL-3.0-only"],
      ["test/LICENSE.md", "AGPL-3.0-only"],
      ["ios/LICENSE.md", "MPL-2.0"],
      ["skills/LICENSE.md", "Apache-2.0"],
      ["examples/LICENSE.md", "Apache-2.0"],
      ["docs/LICENSE.md", "Apache-2.0"],
    ]);
    for (const [path, identifier] of notices) {
      expect(read(path)).toContain(`SPDX-License-Identifier: ${identifier}`);
    }
  });
});
