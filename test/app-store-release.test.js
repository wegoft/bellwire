// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cli = join(repositoryRoot, "scripts/app-store-release.mjs");
let fixtureRoot;
let ipaPath;
let ipaSha256;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "bellwire-app-store-release-"));
  const appRoot = join(fixtureRoot, "Payload/Bellwire.app");
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.bellwire</string>
<key>CFBundleShortVersionString</key><string>1.0.1</string>
<key>CFBundleVersion</key><string>13</string>
<key>BellwireAPIBaseURL</key><string>https://api.bellwire.app</string>
<key>BellwireAuthBaseURL</key><string>https://auth.bellwire.app</string>
</dict></plist>\n`);
  ipaPath = join(fixtureRoot, "Bellwire.ipa");
  const archived = spawnSync("zip", ["-qry", ipaPath, "Payload"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  if (archived.status !== 0) throw new Error(archived.stderr);
  ipaSha256 = createHash("sha256").update(readFileSync(ipaPath)).digest("hex");
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("App Store release CLI", () => {
  it("documents the credential-free local preflight and explicit upload gate", () => {
    const result = run(["--help"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("--local-only");
    expect(result.stdout).toContain("--upload");
    expect(result.stdout).toContain("APP_STORE_CONNECT_ISSUER_ID");
  });

  it("verifies the exact Bellwire release identity without contacting Apple", () => {
    const result = run(releaseArguments("--local-only", "--json"));
    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: true,
      artifact: {
        bundleId: "app.bellwire",
        version: "1.0.1",
        build: "13",
        apiURL: "https://api.bellwire.app",
        authURL: "https://auth.bellwire.app",
        sha256: ipaSha256,
      },
      appStoreConnect: "not requested",
      upload: "not requested",
    });
  });

  it("fails closed on a mismatched artifact digest", () => {
    const args = releaseArguments("--local-only");
    args[args.indexOf(ipaSha256)] = "0".repeat(64);
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("IPA sha256 mismatch");
  });

  it("requires an issuer before any Apple validation and forbids local-only upload", () => {
    const missingIssuer = run(releaseArguments(), { APP_STORE_CONNECT_ISSUER_ID: "" });
    expect(missingIssuer.status).toBe(1);
    expect(missingIssuer.stderr).toContain("APP_STORE_CONNECT_ISSUER_ID");

    const unsafeCombination = run(releaseArguments("--local-only", "--upload"));
    expect(unsafeCombination.status).toBe(1);
    expect(unsafeCombination.stderr).toContain("cannot be combined");
  });
});

function releaseArguments(...extra) {
  return [
    "--ipa",
    ipaPath,
    "--version",
    "1.0.1",
    "--build",
    "13",
    "--sha256",
    ipaSha256,
    ...extra,
  ];
}

function run(argumentsList, environment = {}) {
  return spawnSync(process.execPath, [cli, ...argumentsList], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}
