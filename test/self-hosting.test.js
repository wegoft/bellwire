// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const bootstrapScript = join(repositoryRoot, "scripts/self-host-bootstrap.mjs");
const doctorScript = join(repositoryRoot, "scripts/self-host-doctor.mjs");
const apnsPreflightScript = join(repositoryRoot, "scripts/apns-preflight.mjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("self-host bootstrap and doctor", () => {
  it("generates consistent ignored configs and passes the offline doctor", () => {
    const root = temporaryRoot();
    writeGitignore(root);

    const bootstrap = run(bootstrapScript, [...bootstrapArguments(root), "--json"]);
    expect(bootstrap.status).toBe(0);
    expect(JSON.parse(bootstrap.stdout)).toMatchObject({
      apnsEnvironment: "sandbox",
      deliveryQueue: "bellwire-example-deliveries",
    });

    const ios = readFileSync(join(root, "ios/Bellwire/Configuration/Local.xcconfig"), "utf8");
    const worker = readFileSync(join(root, "wrangler.self-host.toml"), "utf8");
    expect(ios).toContain("BELLWIRE_API_BASE_URL = https:/$()/bellwire.example.workers.dev");
    expect(ios).toContain("BELLWIRE_EXTENSION_BUNDLE_ID = com.example.bellwire.NotificationService");
    expect(ios).toContain("BELLWIRE_WIDGET_BUNDLE_ID = com.example.bellwire.Widgets");
    expect(ios).toContain("BELLWIRE_APP_GROUP = group.com.example.bellwire.shared");
    expect(worker).toContain('APP_URL_SCHEME = "bellwire-self-host"');
    expect(worker).toContain('compatibility_flags = ["nodejs_compat"]');
    expect(worker).toContain('ENTITLEMENT_ENFORCEMENT_MODE = "disabled"');
    expect(worker).toContain('crons = ["17 * * * *"]');
    expect(worker).toContain('name = "APNS_PROVIDER_TOKEN_AUTHORITY"');
    expect(worker).toContain('class_name = "ApnsProviderTokenAuthority"');
    expect(worker).toContain('new_sqlite_classes = ["ApnsProviderTokenAuthority"]');
    expect(`${ios}\n${worker}`).not.toMatch(/sb_secret_|PRIVATE KEY|YOUR_/u);

    const doctor = run(doctorScript, ["--root", root, "--json"]);
    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: true, errors: [] });
  });

  it("refuses to overwrite an existing self-host configuration", () => {
    const root = temporaryRoot();
    writeGitignore(root);
    expect(run(bootstrapScript, bootstrapArguments(root)).status).toBe(0);

    const second = run(bootstrapScript, bootstrapArguments(root));
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("Refusing to overwrite existing configuration");
  });

  it("detects mismatched iOS and Worker URL schemes", () => {
    const root = temporaryRoot();
    writeGitignore(root);
    expect(run(bootstrapScript, bootstrapArguments(root)).status).toBe(0);
    const workerPath = join(root, "wrangler.self-host.toml");
    const worker = readFileSync(workerPath, "utf8").replace(
      'APP_URL_SCHEME = "bellwire-self-host"',
      'APP_URL_SCHEME = "different-scheme"',
    );
    writeFileSync(workerPath, worker);

    const doctor = run(doctorScript, ["--root", root, "--json"]);
    expect(doctor.status).toBe(1);
    expect(JSON.parse(doctor.stdout).errors).toContain(
      "URL scheme mismatch between iOS and Worker configuration",
    );
  });

  it("rejects a Supabase secret key before writing files", () => {
    const root = temporaryRoot();
    const args = bootstrapArguments(root);
    const keyIndex = args.indexOf("--supabase-publishable-key") + 1;
    args[keyIndex] = "sb_secret_not_for_a_mobile_app";

    const result = run(bootstrapScript, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not be a secret");
  });

  it("rejects unknown options instead of silently ignoring a typo", () => {
    const result = run(bootstrapScript, ["--teamid", "ABC123DEFG"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option: --teamid");
  });

  it("validates an APNs signing key locally without printing it", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateKeyPEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const result = spawnSync(process.execPath, [apnsPreflightScript, "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: privateKeyPEM,
      env: {
        ...process.env,
        APNS_KEY_ID: "ABC123DEFG",
        APNS_TEAM_ID: "ABC123DEFG",
        APNS_BUNDLE_ID: "com.example.bellwire",
        APNS_ENVIRONMENT: "sandbox",
      },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      providerToken: "generated",
      online: "not requested",
    });
    expect(result.stdout).not.toContain("PRIVATE KEY");
  });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "bellwire-self-host-"));
  temporaryDirectories.push(root);
  return root;
}

function writeGitignore(root) {
  writeFileSync(
    join(root, ".gitignore"),
    ".dev.vars\nwrangler.self-host.toml\nios/Bellwire/Configuration/Local.xcconfig\n",
  );
}

function bootstrapArguments(root) {
  return [
    "--root", root,
    "--team-id", "ABC123DEFG",
    "--bundle-id", "com.example.bellwire",
    "--url-scheme", "bellwire-self-host",
    "--worker-name", "bellwire-example",
    "--api-url", "https://bellwire.example.workers.dev",
    "--supabase-url", "https://example.supabase.co",
    "--supabase-publishable-key", "sb_publishable_example_key",
  ];
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}
