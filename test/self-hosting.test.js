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
    const authWorker = readFileSync(join(root, "wrangler.auth.self-host.toml"), "utf8");
    expect(ios).toContain("BELLWIRE_API_BASE_URL = https:/$()/bellwire.example.workers.dev");
    expect(ios).toContain("BELLWIRE_AUTH_BASE_URL = https:/$()/bellwire-auth.example.workers.dev");
    expect(ios).toContain("BELLWIRE_EXTENSION_BUNDLE_ID = com.example.bellwire.NotificationService");
    expect(ios).toContain("BELLWIRE_WIDGET_BUNDLE_ID = com.example.bellwire.Widgets");
    expect(ios).toContain("BELLWIRE_APP_GROUP = group.com.example.bellwire.shared");
    expect(ios).toContain("BELLWIRE_APP_DISPLAY_NAME = Example Signals");
    expect(ios).toContain("BELLWIRE_APP_ICON_NAME = SelfHostedAppIcon");
    expect(ios).toContain("BELLWIRE_BILLING_MODE = disabled");
    expect(ios).toContain("BELLWIRE_SUPPORT_EMAIL = support@example.com");
    expect(ios).toContain("BELLWIRE_PRIVACY_URL = https:/$()/example.com/privacy");
    expect(readFileSync(
      join(
        root,
        "ios/Bellwire/Bellwire/Assets.xcassets/SelfHostedAppIcon.appiconset/Contents.json",
      ),
      "utf8",
    )).toContain('"filename": "AppIcon.png"');
    expect(worker).toContain('APP_URL_SCHEME = "bellwire-self-host"');
    expect(worker).toContain('APP_DISPLAY_NAME = "Example Signals"');
    expect(worker).toContain('compatibility_flags = ["nodejs_compat"]');
    expect(worker).toContain('ENTITLEMENT_ENFORCEMENT_MODE = "disabled"');
    expect(worker).toContain('crons = ["17 * * * *"]');
    expect(worker).toContain('name = "APNS_PROVIDER_TOKEN_AUTHORITY"');
    expect(worker).toContain('class_name = "ApnsProviderTokenAuthority"');
    expect(worker).toContain('new_sqlite_classes = ["ApnsProviderTokenAuthority"]');
    expect(worker).toContain('binding = "DB"');
    expect(worker).toContain('service = "bellwire-example-auth"');
    expect(authWorker).toContain('binding = "AUTH_DB"');
    expect(authWorker).toContain('AUTH_AUDIENCE = "bellwire-api"');
    expect(`${ios}\n${worker}\n${authWorker}`).not.toMatch(/PRIVATE KEY|YOUR_/u);

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

  it("rejects an invalid D1 database id before writing files", () => {
    const root = temporaryRoot();
    const args = bootstrapArguments(root);
    const idIndex = args.indexOf("--auth-d1-id") + 1;
    args[idIndex] = "not-a-cloudflare-id";

    const result = run(bootstrapScript, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a Cloudflare D1 database UUID");
  });

  it("validates the custom app icon before writing any configuration", () => {
    const root = temporaryRoot();
    const invalidIcon = join(root, "invalid.png");
    writeFileSync(invalidIcon, "not a png");
    const args = bootstrapArguments(root);
    args[args.indexOf("--app-icon") + 1] = invalidIcon;

    const result = run(bootstrapScript, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--app-icon must be a valid PNG file");
    expect(() => readFileSync(join(root, "wrangler.self-host.toml"))).toThrow();
    expect(() => readFileSync(join(root, "ios/Bellwire/Configuration/Local.xcconfig"))).toThrow();
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
    ".dev.vars\nwrangler.self-host.toml\nwrangler.auth.self-host.toml\nios/Bellwire/Configuration/Local.xcconfig\nios/Bellwire/Bellwire/Assets.xcassets/SelfHostedAppIcon.appiconset/\n",
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
    "--auth-url", "https://bellwire-auth.example.workers.dev",
    "--business-d1-id", "11111111-1111-4111-8111-111111111111",
    "--auth-d1-id", "22222222-2222-4222-8222-222222222222",
    "--app-name", "Example Signals",
    "--app-icon", join(
      repositoryRoot,
      "ios/Bellwire/Bellwire/Assets.xcassets/AppIcon.appiconset/BellwireIcon.png",
    ),
    "--support-email", "support@example.com",
    "--privacy-url", "https://example.com/privacy",
    "--terms-url", "https://example.com/terms",
    "--support-url", "https://example.com/support",
  ];
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}
