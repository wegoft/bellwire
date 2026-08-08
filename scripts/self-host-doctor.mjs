#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";

import {
  LOCAL_XCCONFIG_PATH,
  WRANGLER_AUTH_SELF_HOST_PATH,
  WRANGLER_SELF_HOST_PATH,
  containsPlaceholder,
  fileExists,
  parseArguments,
  parseWranglerConfiguration,
  parseXcconfig,
  readText,
  resolveRoot,
  validateBootstrapOptions,
} from "./self-host-config.mjs";

const usage = `Bellwire self-host doctor

Usage:
  npm run self-host:doctor
  npm run self-host:doctor -- --online

Options:
  --online       Verify both Worker health endpoints and the Better Auth JWKS endpoint
  --root <path>  Repository root (default: current directory)
  --json         Print machine-readable output
  --help
`;

const allowedOptions = new Set(["online", "root", "json", "help"]);

const checks = [];
const errors = [];
const warnings = [];

try {
  const options = parseArguments(
    process.argv.slice(2),
    new Set(["help", "json", "online"]),
    allowedOptions,
  );
  if (options.help) {
    process.stdout.write(usage);
    process.exit(0);
  }

  const root = resolveRoot(options.root);
  const iosPath = path.join(root, LOCAL_XCCONFIG_PATH);
  const workerPath = path.join(root, WRANGLER_SELF_HOST_PATH);
  const authWorkerPath = path.join(root, WRANGLER_AUTH_SELF_HOST_PATH);
  const iosSource = await requiredFile(iosPath, LOCAL_XCCONFIG_PATH);
  const workerSource = await requiredFile(workerPath, WRANGLER_SELF_HOST_PATH);
  const authWorkerSource = await requiredFile(authWorkerPath, WRANGLER_AUTH_SELF_HOST_PATH);
  const gitignore = await optionalFile(path.join(root, ".gitignore"));

  if (iosSource && workerSource && authWorkerSource) {
    rejectSecrets(LOCAL_XCCONFIG_PATH, iosSource);
    rejectSecrets(WRANGLER_SELF_HOST_PATH, workerSource);
    rejectSecrets(WRANGLER_AUTH_SELF_HOST_PATH, authWorkerSource);
    const ios = parseXcconfig(iosSource);
    const worker = parseWranglerConfiguration(workerSource);
    const authWorker = parseWranglerConfiguration(authWorkerSource);
    validateRequiredValues(ios, worker, authWorker);
    validateFormats(ios, worker, authWorker);
    validateConsistency(ios, worker, authWorker);
    validateGitignore(gitignore);

    if (options.online && errors.length === 0) {
      await verifyOnline(ios.BELLWIRE_API_BASE_URL, ios.BELLWIRE_AUTH_BASE_URL);
    }
  }

  const result = { ok: errors.length === 0, checks, warnings, errors };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write("Bellwire self-host doctor\n");
    for (const item of checks) process.stdout.write(`✓ ${item}\n`);
    for (const item of warnings) process.stdout.write(`! ${item}\n`);
    for (const item of errors) process.stdout.write(`✗ ${item}\n`);
    process.stdout.write(result.ok ? "Ready for the next self-hosting step.\n" : "Configuration needs attention.\n");
  }
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  process.stderr.write(`Bellwire doctor: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exit(1);
}

async function requiredFile(filePath, label) {
  if (!(await fileExists(filePath))) {
    errors.push(`${label} is missing; run npm run self-host:bootstrap`);
    return undefined;
  }
  checks.push(`${label} exists`);
  return readText(filePath);
}

async function optionalFile(filePath) {
  return (await fileExists(filePath)) ? readText(filePath) : "";
}

function rejectSecrets(label, source) {
  const secretPatterns = [
    /APNS_PRIVATE_KEY\s*=\s*\S+/u,
    /APPLE_TOKEN_ENCRYPTION_KEY\s*=\s*\S+/u,
    /BETTER_AUTH_SECRET\s*=\s*\S+/u,
    /AUTH_INTERNAL_SECRET\s*=\s*\S+/u,
    /APPLE_SIGN_IN_PRIVATE_KEY\s*=\s*\S+/u,
    /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/u,
    /bw_(?:agent|live|ingest)_[A-Za-z0-9_-]{12,}/u,
  ];
  if (secretPatterns.some((pattern) => pattern.test(source))) {
    errors.push(`${label} appears to contain a secret; move it to Wrangler secrets`);
  } else {
    checks.push(`${label} contains no recognized secret values`);
  }
}

function validateRequiredValues(ios, worker, authWorker) {
  const iosKeys = [
    "BELLWIRE_DEVELOPMENT_TEAM",
    "BELLWIRE_APP_BUNDLE_ID",
    "BELLWIRE_EXTENSION_BUNDLE_ID",
    "BELLWIRE_WIDGET_BUNDLE_ID",
    "BELLWIRE_APP_GROUP",
    "BELLWIRE_URL_SCHEME",
    "BELLWIRE_API_BASE_URL",
    "BELLWIRE_AUTH_BASE_URL",
  ];
  const workerKeys = [
    "APP_ENV",
    "AUTH_ISSUER",
    "AUTH_AUDIENCE",
    "APNS_BUNDLE_ID",
    "APP_URL_SCHEME",
    "APNS_ENVIRONMENT",
    "ENTITLEMENT_ENFORCEMENT_MODE",
  ];
  for (const key of iosKeys) validateValue(`iOS ${key}`, ios[key]);
  for (const key of workerKeys) validateValue(`Worker ${key}`, worker.vars[key]);
  for (const key of [
    "AUTH_ENVIRONMENT",
    "AUTH_ISSUER",
    "AUTH_AUDIENCE",
    "APPLE_SIGN_IN_CLIENT_ID",
    "APPLE_APP_BUNDLE_ID",
  ]) validateValue(`Auth Worker ${key}`, authWorker.vars[key]);
  validateValue("Worker name", worker.root.name);
  validateValue("Worker compatibility flags", worker.root.compatibility_flags);
  validateValue("delivery Queue", worker.producer.queue);
  validateValue("consumer Queue", worker.consumer.queue);
  validateValue("dead-letter Queue", worker.consumer.dead_letter_queue);
  validateValue("APNs token authority binding", worker.durableObject.name);
  validateValue("APNs token authority class", worker.durableObject.class_name);
  validateValue("Durable Object migration tag", worker.migration.tag);
  validateValue("Durable Object migration class", worker.migration.new_sqlite_classes);
  validateValue("business D1 binding", worker.d1.binding);
  validateValue("business D1 name", worker.d1.database_name);
  validateValue("business D1 id", worker.d1.database_id);
  validateValue("Auth service binding", worker.service.binding);
  validateValue("Auth service name", worker.service.service);
  validateValue("Auth Worker name", authWorker.root.name);
  validateValue("Auth D1 binding", authWorker.d1.binding);
  validateValue("Auth D1 name", authWorker.d1.database_name);
  validateValue("Auth D1 id", authWorker.d1.database_id);
  if (errors.length === 0) checks.push("all required configuration values are resolved");
}

function validateValue(label, value) {
  if (value === undefined || value === "") errors.push(`${label} is missing`);
  else if (containsPlaceholder(value)) errors.push(`${label} still contains an example placeholder`);
}

function validateFormats(ios, worker, authWorker) {
  const errorCount = errors.length;
  if (errorCount > 0) return;
  try {
    validateBootstrapOptions({
      "team-id": ios.BELLWIRE_DEVELOPMENT_TEAM,
      "bundle-id": ios.BELLWIRE_APP_BUNDLE_ID,
      "extension-bundle-id": ios.BELLWIRE_EXTENSION_BUNDLE_ID,
      "widget-bundle-id": ios.BELLWIRE_WIDGET_BUNDLE_ID,
      "app-group": ios.BELLWIRE_APP_GROUP,
      "url-scheme": ios.BELLWIRE_URL_SCHEME,
      "worker-name": worker.root.name,
      "queue-prefix": worker.root.name,
      "api-url": ios.BELLWIRE_API_BASE_URL,
      "auth-url": ios.BELLWIRE_AUTH_BASE_URL,
      "auth-worker-name": authWorker.root.name,
      "business-d1-name": worker.d1.database_name,
      "business-d1-id": worker.d1.database_id,
      "auth-d1-name": authWorker.d1.database_name,
      "auth-d1-id": authWorker.d1.database_id,
      "apns-environment": worker.vars.APNS_ENVIRONMENT,
    });
    checks.push("configuration values use valid formats");
  } catch (error) {
    errors.push(`configuration format is invalid: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

function validateConsistency(ios, worker, authWorker) {
  compare("Bundle ID", ios.BELLWIRE_APP_BUNDLE_ID, worker.vars.APNS_BUNDLE_ID);
  compare("URL scheme", ios.BELLWIRE_URL_SCHEME, worker.vars.APP_URL_SCHEME);
  compare("Auth URL", normalizeURL(ios.BELLWIRE_AUTH_BASE_URL), normalizeURL(worker.vars.AUTH_ISSUER));
  compare("Auth Worker issuer", normalizeURL(ios.BELLWIRE_AUTH_BASE_URL), normalizeURL(authWorker.vars.AUTH_ISSUER));
  compare("Auth audience", worker.vars.AUTH_AUDIENCE, authWorker.vars.AUTH_AUDIENCE);
  compare("Auth service", worker.service.service, authWorker.root.name);
  compare("Auth Apple Bundle ID", ios.BELLWIRE_APP_BUNDLE_ID, authWorker.vars.APPLE_APP_BUNDLE_ID);
  compare("producer and consumer Queue", worker.producer.queue, worker.consumer.queue);
  if (
    worker.durableObject.name !== "APNS_PROVIDER_TOKEN_AUTHORITY" ||
    worker.durableObject.class_name !== "ApnsProviderTokenAuthority"
  ) {
    errors.push("Worker APNs provider-token Durable Object binding is invalid");
  } else {
    checks.push("APNs provider-token Durable Object binding is configured");
  }
  if (!String(worker.migration.new_sqlite_classes).includes("ApnsProviderTokenAuthority")) {
    errors.push("Worker Durable Object migration is missing ApnsProviderTokenAuthority");
  } else {
    checks.push("APNs provider-token Durable Object migration is configured");
  }
  if (!String(worker.root.compatibility_flags).includes("nodejs_compat")) {
    errors.push("Worker compatibility flags are missing nodejs_compat");
  } else {
    checks.push("Worker Node.js compatibility is enabled");
  }
  const expectedExtension = `${ios.BELLWIRE_APP_BUNDLE_ID}.NotificationService`;
  if (ios.BELLWIRE_EXTENSION_BUNDLE_ID !== expectedExtension) {
    warnings.push(`extension Bundle ID is ${ios.BELLWIRE_EXTENSION_BUNDLE_ID}; expected convention is ${expectedExtension}`);
  } else {
    checks.push("notification extension Bundle ID matches the main App ID");
  }
  const expectedWidget = `${ios.BELLWIRE_APP_BUNDLE_ID}.Widgets`;
  if (ios.BELLWIRE_WIDGET_BUNDLE_ID !== expectedWidget) {
    warnings.push(`Widget Bundle ID is ${ios.BELLWIRE_WIDGET_BUNDLE_ID}; expected convention is ${expectedWidget}`);
  } else {
    checks.push("Widget Bundle ID matches the main App ID");
  }
  const expectedGroup = `group.${ios.BELLWIRE_APP_BUNDLE_ID}.shared`;
  if (ios.BELLWIRE_APP_GROUP !== expectedGroup) {
    warnings.push(`App Group is ${ios.BELLWIRE_APP_GROUP}; expected convention is ${expectedGroup}`);
  } else {
    checks.push("App Group matches the main App ID");
  }
  if (worker.d1.binding !== "DB") errors.push("Worker business D1 binding must be DB");
  else checks.push("business D1 binding is configured");
  if (authWorker.d1.binding !== "AUTH_DB") errors.push("Auth Worker D1 binding must be AUTH_DB");
  else checks.push("Auth D1 binding is configured");
  if (worker.service.binding !== "AUTH_SERVICE") errors.push("Worker Auth service binding must be AUTH_SERVICE");
  else checks.push("Auth service binding is configured");
  if (worker.vars.APP_ENV !== "production") errors.push("Worker APP_ENV must be production for durable self-hosting");
  if (authWorker.vars.AUTH_ENVIRONMENT !== "production") errors.push("Auth Worker AUTH_ENVIRONMENT must be production for durable self-hosting");
  if (worker.vars.ENTITLEMENT_ENFORCEMENT_MODE !== "disabled") {
    errors.push("Self-hosted Worker ENTITLEMENT_ENFORCEMENT_MODE must be disabled");
  } else {
    checks.push("commercial plan enforcement is disabled for self-hosting");
  }
  if (!["sandbox", "production"].includes(worker.vars.APNS_ENVIRONMENT)) {
    errors.push("Worker APNS_ENVIRONMENT must be sandbox or production");
  }
}

function compare(label, left, right) {
  if (left !== right) errors.push(`${label} mismatch between iOS and Worker configuration`);
  else checks.push(`${label} matches between iOS and Worker configuration`);
}

function validateGitignore(source) {
  const ignored = new Set(source.split(/\r?\n/u).map((line) => line.trim()));
  for (const expected of [
    LOCAL_XCCONFIG_PATH,
    WRANGLER_SELF_HOST_PATH,
    WRANGLER_AUTH_SELF_HOST_PATH,
    ".dev.vars",
  ]) {
    if (ignored.has(expected)) checks.push(`${expected} is ignored by Git`);
    else errors.push(`${expected} is not explicitly ignored by Git`);
  }
}

async function verifyOnline(apiBaseURL, authBaseURL) {
  const health = await fetchJSON(new URL("health", `${normalizeURL(apiBaseURL)}/`), "Worker health");
  if (health?.status !== "ok" || health?.service !== "bellwire-api") {
    errors.push("Worker health endpoint returned an unexpected payload");
  } else if (
    health?.compatibility?.apiVersion !== "v1"
    || typeof health?.compatibility?.appVersion !== "string"
    || typeof health?.compatibility?.schemaMigration !== "string"
  ) {
    errors.push("Worker health endpoint returned incompatible or missing version metadata");
  } else {
    checks.push(
      `Worker is reachable: API ${health.compatibility.apiVersion}, app ${health.compatibility.appVersion}, schema ${health.compatibility.schemaMigration}`,
    );
  }

  const authHealth = await fetchJSON(
    new URL("health", `${normalizeURL(authBaseURL)}/`),
    "Auth Worker health",
  );
  if (authHealth?.ok !== true || authHealth?.service !== "bellwire-auth") {
    errors.push("Auth Worker health endpoint returned an unexpected payload");
  } else checks.push("Auth Worker is reachable");

  const jwks = await fetchJSON(
    new URL("api/auth/jwks", `${normalizeURL(authBaseURL)}/`),
    "Better Auth JWKS",
  );
  if (!Array.isArray(jwks?.keys)) errors.push("Better Auth JWKS endpoint returned an unexpected payload");
  else checks.push("Better Auth JWKS endpoint is reachable");
}

async function fetchJSON(url, label) {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) {
      errors.push(`${label} returned HTTP ${response.status}`);
      return undefined;
    }
    return await response.json();
  } catch (error) {
    errors.push(`${label} failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    return undefined;
  }
}

function normalizeURL(value) {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}
