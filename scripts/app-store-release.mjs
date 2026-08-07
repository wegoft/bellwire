#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { importPKCS8, SignJWT } from "jose";

import { parseArguments } from "./self-host-config.mjs";

const usage = `Bellwire App Store release validator and uploader

Validates the exact IPA locally, authenticates with an App Store Connect team
API key, asks Apple to validate it, and uploads only when --upload is explicit.
Passwords and private-key contents are never accepted as arguments or printed.

Usage:
  APP_STORE_CONNECT_ISSUER_ID=00000000-0000-0000-0000-000000000000 \\
    npm run ios:release -- \\
      --ipa /secure/Bellwire.ipa \\
      --version 1.0.1 \\
      --build 13 \\
      --sha256 <expected-sha256> \\
      --upload

Options:
  --ipa <path>         App Store-distribution IPA
  --version <value>    Required CFBundleShortVersionString
  --build <value>      Required CFBundleVersion
  --sha256 <value>     Required IPA SHA-256
  --issuer-id <uuid>   Team Issuer ID; defaults to APP_STORE_CONNECT_ISSUER_ID
  --key-id <value>     Select one AuthKey_<key-id>.p8; otherwise probe all keys
  --key-dir <path>     Defaults to ~/.appstoreconnect/private_keys
  --bundle-id <value>  Defaults to app.bellwire
  --api-url <url>      Defaults to https://api.bellwire.app
  --auth-url <url>     Defaults to https://auth.bellwire.app
  --local-only         Verify artifact identity without contacting Apple
  --upload             Upload only after local and Apple validation both pass
  --json               Print machine-readable output
  --help
`;

const booleanOptions = new Set(["help", "json", "local-only", "upload"]);
const allowedOptions = new Set([
  ...booleanOptions,
  "api-url",
  "auth-url",
  "build",
  "bundle-id",
  "ipa",
  "issuer-id",
  "key-dir",
  "key-id",
  "sha256",
  "version",
]);

try {
  const options = parseArguments(process.argv.slice(2), booleanOptions, allowedOptions);
  if (options.help) {
    process.stdout.write(usage);
    process.exit(0);
  }
  if (options.upload && options["local-only"]) {
    throw new Error("--upload cannot be combined with --local-only");
  }

  const expected = {
    bundleId: options["bundle-id"] ?? "app.bellwire",
    version: requiredOption(options, "version"),
    build: requiredOption(options, "build"),
    sha256: requiredSha256(options.sha256),
    apiURL: requiredHttpsURL(options["api-url"] ?? "https://api.bellwire.app", "--api-url"),
    authURL: requiredHttpsURL(options["auth-url"] ?? "https://auth.bellwire.app", "--auth-url"),
  };
  const ipaPath = existingRegularFile(requiredOption(options, "ipa"), "--ipa");
  const artifact = inspectIPA(ipaPath);
  compareArtifact(artifact, expected);

  const result = {
    ok: true,
    artifact: {
      path: ipaPath,
      bundleId: artifact.bundleId,
      version: artifact.version,
      build: artifact.build,
      apiURL: artifact.apiURL,
      authURL: artifact.authURL,
      sha256: artifact.sha256,
    },
    appStoreConnect: options["local-only"] ? "not requested" : "pending",
    upload: options.upload ? "pending" : "not requested",
  };

  if (!options["local-only"]) {
    const issuerId = requiredIssuer(options["issuer-id"] ?? process.env.APP_STORE_CONNECT_ISSUER_ID);
    const keyDirectory = resolve(options["key-dir"] ?? join(homedir(), ".appstoreconnect", "private_keys"));
    const key = await findWorkingKey({
      keyDirectory,
      requestedKeyId: options["key-id"],
      issuerId,
      bundleId: expected.bundleId,
    });
    runAltool(
      ["--validate-app", "-f", ipaPath],
      { issuerId, keyId: key.id, keyDirectory },
      "Apple validation",
    );
    result.appStoreConnect = "validated";

    if (options.upload) {
      runAltool(
        ["--upload-app", "-f", ipaPath, "--show-progress"],
        { issuerId, keyId: key.id, keyDirectory },
        "App Store upload",
      );
      runAltool(
        [
          "--build-status",
          "--apple-id",
          key.appId,
          "--bundle-version",
          expected.build,
          "--bundle-short-version-string",
          expected.version,
          "--platform",
          "ios",
          "--wait",
        ],
        { issuerId, keyId: key.id, keyDirectory },
        "App Store processing",
      );
      result.upload = "uploaded and processed";
    }
  }

  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write("Bellwire App Store release\n");
    process.stdout.write(`✓ ${artifact.bundleId} ${artifact.version} (${artifact.build})\n`);
    process.stdout.write("✓ IPA SHA-256 and Cloudflare endpoints match\n");
    if (!options["local-only"]) process.stdout.write("✓ App Store Connect authentication and validation passed\n");
    if (options.upload) process.stdout.write("✓ build uploaded and Apple processing completed\n");
  }
} catch (error) {
  process.stderr.write(`Bellwire App Store release: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exit(1);
}

function requiredOption(options, name) {
  const value = options[name]?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function requiredSha256(value) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error("--sha256 must be a 64-character SHA-256 digest");
  }
  return normalized;
}

function requiredHttpsURL(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an HTTPS origin without a path, query, or fragment`);
  }
  return url.origin;
}

function requiredIssuer(value) {
  const issuerId = value?.trim();
  if (!issuerId) throw new Error("APP_STORE_CONNECT_ISSUER_ID or --issuer-id is required");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(issuerId)) {
    throw new Error("App Store Connect Issuer ID must be a UUID");
  }
  return issuerId;
}

function existingRegularFile(value, label) {
  const filePath = resolve(value);
  let details;
  try {
    details = lstatSync(filePath);
  } catch {
    throw new Error(`${label} does not exist`);
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a symlink`);
  }
  return filePath;
}

function inspectIPA(ipaPath) {
  const digest = createHash("sha256").update(readFileSync(ipaPath)).digest("hex");
  const unzip = spawnSync("unzip", ["-p", ipaPath, "Payload/Bellwire.app/Info.plist"], {
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (unzip.status !== 0 || !unzip.stdout?.length) {
    throw new Error("IPA does not contain Payload/Bellwire.app/Info.plist");
  }
  const converted = spawnSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
    input: unzip.stdout,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (converted.status !== 0) throw new Error("IPA Info.plist could not be decoded");
  let info;
  try {
    info = JSON.parse(converted.stdout);
  } catch {
    throw new Error("IPA Info.plist did not contain valid property-list data");
  }
  return {
    bundleId: info.CFBundleIdentifier,
    version: info.CFBundleShortVersionString,
    build: info.CFBundleVersion,
    apiURL: normalizeOrigin(info.BellwireAPIBaseURL),
    authURL: normalizeOrigin(info.BellwireAuthBaseURL),
    sha256: digest,
  };
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function compareArtifact(actual, expected) {
  const fields = ["bundleId", "version", "build", "sha256", "apiURL", "authURL"];
  for (const field of fields) {
    if (actual[field] !== expected[field]) {
      throw new Error(`IPA ${field} mismatch: expected ${expected[field]}, received ${actual[field]}`);
    }
  }
}

async function findWorkingKey({ keyDirectory, requestedKeyId, issuerId, bundleId }) {
  let names;
  try {
    names = readdirSync(keyDirectory);
  } catch {
    throw new Error(`App Store Connect key directory is unavailable: ${keyDirectory}`);
  }
  const candidates = names
    .filter((name) => /^AuthKey_[A-Z0-9]{10}\.p8$/u.test(name))
    .map((name) => ({ id: name.slice("AuthKey_".length, -".p8".length), path: join(keyDirectory, name) }))
    .filter((candidate) => !requestedKeyId || candidate.id === requestedKeyId)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!candidates.length) {
    throw new Error(requestedKeyId
      ? "The selected App Store Connect API key was not found"
      : "No AuthKey_<KEY_ID>.p8 files were found");
  }

  for (const candidate of candidates) {
    assertPrivateKeyFile(candidate.path);
    try {
      const privateKey = await importPKCS8(readFileSync(candidate.path, "utf8").trim(), "ES256");
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: candidate.id, typ: "JWT" })
        .setIssuer(issuerId)
        .setAudience("appstoreconnect-v1")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      const response = await fetch(
        `https://api.appstoreconnect.apple.com/v1/apps?filter%5BbundleId%5D=${encodeURIComponent(bundleId)}&limit=2`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok) continue;
      const body = await response.json();
      const apps = Array.isArray(body.data) ? body.data : [];
      const app = apps.find((entry) => entry.attributes?.bundleId === bundleId);
      if (app?.id) return { ...candidate, appId: app.id };
    } catch {
      // Try the next local key without revealing which credential failed.
    }
  }
  throw new Error("No local App Store Connect API key authenticated for this issuer and app");
}

function assertPrivateKeyFile(filePath) {
  const details = lstatSync(filePath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("App Store Connect private key must be a regular file, not a symlink");
  }
  if ((details.mode & 0o077) !== 0) {
    throw new Error(`App Store Connect private key permissions are too broad: ${basename(filePath)}`);
  }
}

function runAltool(command, { issuerId, keyId, keyDirectory }, label) {
  const authentication = ["--api-key", keyId, "--api-issuer", issuerId, "--output-format", "json"];
  const result = spawnSync("xcrun", ["altool", ...command, ...authentication], {
    encoding: "utf8",
    env: { ...process.env, API_PRIVATE_KEYS_DIR: keyDirectory },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label} could not start`);
  if (result.status !== 0) {
    const diagnostic = redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, [issuerId, keyId]);
    throw new Error(`${label} failed${diagnostic ? `: ${diagnostic}` : ""}`);
  }
}

function redact(value, secrets) {
  let output = value.trim();
  for (const secret of secrets) {
    if (secret) output = output.replaceAll(secret, "[REDACTED]");
  }
  return output.replaceAll(/AuthKey_[A-Z0-9]{10}\.p8/gu, "AuthKey_[REDACTED].p8");
}
