// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

const tag = readTag(process.argv.slice(2), process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME);
const packageMetadata = JSON.parse(readFileSync("package.json", "utf8"));
const expectedTag = `v${packageMetadata.version}`;

if (tag !== expectedTag) {
  throw new Error(`Release tag ${tag} does not match package version ${expectedTag}`);
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes(`## [${packageMetadata.version}] - `)) {
  throw new Error(`CHANGELOG.md has no dated ${packageMetadata.version} release entry`);
}

const requiredArtifacts = new Map([
  ["LICENSE", "GNU AFFERO GENERAL PUBLIC LICENSE"],
  ["LICENSE.md", "Bellwire licensing"],
  ["THIRD_PARTY_NOTICES.md", "SwiftUI-Agent-Skill"],
  ["skills/bellwire/LICENSE", "MIT No Attribution"],
  [".agents/skills/swiftui-pro/LICENSE", "MIT License"],
  ["docs/openapi.yaml", "openapi: 3.1.0"],
]);
for (const [path, expectedText] of requiredArtifacts) {
  const contents = readFileSync(path, "utf8");
  if (!contents.includes(expectedText)) {
    throw new Error(`${path} is missing required release text: ${expectedText}`);
  }
}

process.stdout.write(`✓ Release metadata and license payloads match ${tag}\n`);

function readTag(argv, environmentTag) {
  if (argv.length === 0) {
    if (!environmentTag) throw new Error("Pass --tag vX.Y.Z or set RELEASE_TAG");
    return environmentTag;
  }
  if (argv.length !== 2 || argv[0] !== "--tag" || !argv[1]) {
    throw new Error("Usage: npm run release:check -- --tag vX.Y.Z");
  }
  return argv[1];
}
