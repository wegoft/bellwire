// SPDX-License-Identifier: AGPL-3.0-only
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const LOCAL_XCCONFIG_PATH = "ios/Bellwire/Configuration/Local.xcconfig";
export const WRANGLER_SELF_HOST_PATH = "wrangler.self-host.toml";
export const WRANGLER_AUTH_SELF_HOST_PATH = "wrangler.auth.self-host.toml";
export const SELF_HOSTED_APP_ICON_PATH =
  "ios/Bellwire/Bellwire/Assets.xcassets/SelfHostedAppIcon.appiconset";

export function parseArguments(argv, booleanOptions = new Set(), allowedOptions) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!key) throw new Error("Empty option name");
    if (allowedOptions && !allowedOptions.has(key)) throw new Error(`Unknown option: --${key}`);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: --${key}`);
    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

export function validateBootstrapOptions(options) {
  const teamId = required(options, "team-id");
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new Error("--team-id must be a 10-character Apple Team ID");
  }

  const bundleId = required(options, "bundle-id");
  if (!validBundleId(bundleId)) throw new Error("--bundle-id is not a valid explicit App ID");

  const apiURL = httpsOrigin(required(options, "api-url"), "--api-url");
  const authURL = httpsOrigin(required(options, "auth-url"), "--auth-url");
  const appName = required(options, "app-name");
  if (appName.toLowerCase() === "bellwire" || !validXcconfigText(appName)) {
    throw new Error("--app-name must be a safe custom name other than Bellwire");
  }
  const appIcon = required(options, "app-icon");
  const supportEmail = required(options, "support-email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(supportEmail)) {
    throw new Error("--support-email must be a valid email address");
  }
  const privacyURL = httpsURL(required(options, "privacy-url"), "--privacy-url");
  const termsURL = httpsURL(required(options, "terms-url"), "--terms-url");
  const supportURL = httpsURL(required(options, "support-url"), "--support-url");

  const workerName = options["worker-name"] ?? "bellwire-self-host";
  const authWorkerName = options["auth-worker-name"] ?? `${workerName}-auth`;
  const queuePrefix = options["queue-prefix"] ?? workerName;
  if (!validCloudflareName(workerName)) throw new Error("--worker-name is not valid");
  if (!validCloudflareName(authWorkerName)) throw new Error("--auth-worker-name is not valid");
  if (!validCloudflareName(queuePrefix)) throw new Error("--queue-prefix is not valid");
  const businessD1Name = options["business-d1-name"] ?? `${workerName}-db`;
  const authD1Name = options["auth-d1-name"] ?? `${authWorkerName}-db`;
  if (!validCloudflareName(businessD1Name)) throw new Error("--business-d1-name is not valid");
  if (!validCloudflareName(authD1Name)) throw new Error("--auth-d1-name is not valid");
  const businessD1Id = cloudflareId(required(options, "business-d1-id"), "--business-d1-id");
  const authD1Id = cloudflareId(required(options, "auth-d1-id"), "--auth-d1-id");

  const urlScheme = options["url-scheme"] ?? bundleId.toLowerCase();
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/u.test(urlScheme)) {
    throw new Error("--url-scheme must follow the URI scheme syntax");
  }

  const apnsEnvironment = options["apns-environment"] ?? "sandbox";
  if (apnsEnvironment !== "sandbox" && apnsEnvironment !== "production") {
    throw new Error("--apns-environment must be sandbox or production");
  }

  const extensionBundleId = options["extension-bundle-id"] ?? `${bundleId}.NotificationService`;
  if (!validBundleId(extensionBundleId)) {
    throw new Error("--extension-bundle-id is not a valid explicit App ID");
  }
  const widgetBundleId = options["widget-bundle-id"] ?? `${bundleId}.Widgets`;
  if (!validBundleId(widgetBundleId)) {
    throw new Error("--widget-bundle-id is not a valid explicit App ID");
  }
  const appGroup = options["app-group"] ?? `group.${bundleId}.shared`;
  if (!appGroup.startsWith("group.") || !validBundleId(appGroup)) {
    throw new Error("--app-group must be a valid application group identifier");
  }

  return {
    teamId,
    bundleId,
    extensionBundleId,
    widgetBundleId,
    appGroup,
    apiURL,
    authURL,
    workerName,
    authWorkerName,
    businessD1Name,
    businessD1Id,
    authD1Name,
    authD1Id,
    queuePrefix,
    urlScheme,
    apnsEnvironment,
    appName,
    appIcon,
    supportEmail,
    privacyURL,
    termsURL,
    supportURL,
  };
}

export function renderLocalXcconfig(configuration) {
  return `// Generated by npm run self-host:bootstrap. This file is ignored by Git.

BELLWIRE_DEVELOPMENT_TEAM = ${configuration.teamId}
BELLWIRE_APP_BUNDLE_ID = ${configuration.bundleId}
BELLWIRE_EXTENSION_BUNDLE_ID = ${configuration.extensionBundleId}
BELLWIRE_WIDGET_BUNDLE_ID = ${configuration.widgetBundleId}
BELLWIRE_APP_GROUP = ${configuration.appGroup}
BELLWIRE_URL_SCHEME = ${configuration.urlScheme}
BELLWIRE_APP_DISPLAY_NAME = ${configuration.appName}
BELLWIRE_APP_ICON_NAME = SelfHostedAppIcon
BELLWIRE_BILLING_MODE = disabled
BELLWIRE_PRO_MONTHLY_PRODUCT_ID = self-hosted.disabled.monthly
BELLWIRE_PRO_YEARLY_PRODUCT_ID = self-hosted.disabled.yearly
BELLWIRE_SUPPORT_EMAIL = ${configuration.supportEmail}

// The empty $() keeps // from being parsed as an xcconfig comment.
BELLWIRE_API_BASE_URL = ${urlForXcconfig(configuration.apiURL)}
BELLWIRE_AUTH_BASE_URL = ${urlForXcconfig(configuration.authURL)}
BELLWIRE_PRIVACY_URL = ${urlForXcconfig(configuration.privacyURL)}
BELLWIRE_TERMS_URL = ${urlForXcconfig(configuration.termsURL)}
BELLWIRE_SUPPORT_URL = ${urlForXcconfig(configuration.supportURL)}
`;
}

export async function readSelfHostedAppIcon(sourcePath) {
  const source = path.resolve(sourcePath);
  const details = await lstat(source).catch(() => undefined);
  if (!details?.isFile() || details.isSymbolicLink()) {
    throw new Error("--app-icon must be a regular PNG file, not a symlink");
  }
  const image = await readFile(source);
  if (
    image.length < 24
    || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  ) {
    throw new Error("--app-icon must be a valid PNG file");
  }
  if (image.readUInt32BE(16) !== 1024 || image.readUInt32BE(20) !== 1024) {
    throw new Error("--app-icon must be exactly 1024x1024 pixels");
  }
  return image;
}

export async function writeSelfHostedAppIcon(root, image) {
  const directory = path.join(root, SELF_HOSTED_APP_ICON_PATH);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "AppIcon.png"), image, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(directory, "Contents.json"), `${JSON.stringify({
    images: [{
      filename: "AppIcon.png",
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
    }],
    info: { author: "xcode", version: 1 },
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export function renderWranglerConfiguration(configuration) {
  const deliveryQueue = `${configuration.queuePrefix}-deliveries`;
  return `name = ${JSON.stringify(configuration.workerName)}
main = "src/index.ts"
compatibility_date = "2026-07-20"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
preview_urls = true

[vars]
APP_ENV = "production"
AUTH_ISSUER = ${JSON.stringify(configuration.authURL)}
AUTH_AUDIENCE = "bellwire-api"
APNS_BUNDLE_ID = ${JSON.stringify(configuration.bundleId)}
APP_URL_SCHEME = ${JSON.stringify(configuration.urlScheme)}
APP_DISPLAY_NAME = ${JSON.stringify(configuration.appName)}
APNS_ENVIRONMENT = ${JSON.stringify(configuration.apnsEnvironment)}
ENTITLEMENT_ENFORCEMENT_MODE = "disabled"

[[d1_databases]]
binding = "DB"
database_name = ${JSON.stringify(configuration.businessD1Name)}
database_id = ${JSON.stringify(configuration.businessD1Id)}
migrations_dir = "d1/business"

[[services]]
binding = "AUTH_SERVICE"
service = ${JSON.stringify(configuration.authWorkerName)}

[triggers]
crons = ["17 * * * *"]

[[queues.producers]]
binding = "DELIVERY_QUEUE"
queue = ${JSON.stringify(deliveryQueue)}

[[queues.consumers]]
queue = ${JSON.stringify(deliveryQueue)}
max_batch_size = 10
max_batch_timeout = 5
max_retries = 3
dead_letter_queue = ${JSON.stringify(`${deliveryQueue}-dlq`)}

[[durable_objects.bindings]]
name = "APNS_PROVIDER_TOKEN_AUTHORITY"
class_name = "ApnsProviderTokenAuthority"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ApnsProviderTokenAuthority"]
`;
}

export function renderAuthWranglerConfiguration(configuration) {
  return `name = ${JSON.stringify(configuration.authWorkerName)}
main = "src/auth/index.ts"
compatibility_date = "2026-08-05"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
preview_urls = true

[vars]
AUTH_ENVIRONMENT = "production"
AUTH_ISSUER = ${JSON.stringify(configuration.authURL)}
AUTH_AUDIENCE = "bellwire-api"
APPLE_SIGN_IN_CLIENT_ID = ${JSON.stringify(configuration.bundleId)}
APPLE_APP_BUNDLE_ID = ${JSON.stringify(configuration.bundleId)}

[[d1_databases]]
binding = "AUTH_DB"
database_name = ${JSON.stringify(configuration.authD1Name)}
database_id = ${JSON.stringify(configuration.authD1Id)}
migrations_dir = "d1/auth"
`;
}

export async function writeNewFile(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(filePath) {
  return readFile(filePath, "utf8");
}

export function parseXcconfig(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match) values[match[1]] = match[2];
  }
  const resolved = {};
  const resolve = (key, stack = []) => {
    if (resolved[key] !== undefined) return resolved[key];
    if (stack.includes(key)) throw new Error(`Circular xcconfig reference: ${[...stack, key].join(" -> ")}`);
    const raw = values[key];
    if (raw === undefined) return undefined;
    const value = raw.replace(/\$\(([^)]*)\)/gu, (_match, reference) => {
      if (!reference) return "";
      return resolve(reference, [...stack, key]) ?? `$(${reference})`;
    });
    resolved[key] = value;
    return value;
  };
  for (const key of Object.keys(values)) resolve(key);
  return resolved;
}

export function parseWranglerConfiguration(source) {
  const result = {
    root: {},
    vars: {},
    producer: {},
    consumer: {},
    durableObject: {},
    migration: {},
    d1: {},
    service: {},
  };
  let section = "root";
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "").trim();
    if (!line) continue;
    if (line === "[vars]") section = "vars";
    else if (line === "[[queues.producers]]") section = "producer";
    else if (line === "[[queues.consumers]]") section = "consumer";
    else if (line === "[[durable_objects.bindings]]") section = "durableObject";
    else if (line === "[[migrations]]") section = "migration";
    else if (line === "[[d1_databases]]") section = "d1";
    else if (line === "[[services]]") section = "service";
    else if (line.startsWith("[")) section = "other";
    else {
      const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/u.exec(line);
      if (!match || section === "other") continue;
      result[section][match[1]] = parseTomlValue(match[2]);
    }
  }
  return result;
}

export function containsPlaceholder(value) {
  return typeof value === "string" && (/YOUR_/u.test(value) || /\$\([A-Z0-9_]+\)/u.test(value));
}

export function resolveRoot(value) {
  return path.resolve(value ?? process.cwd());
}

function parseTomlValue(value) {
  if (value.startsWith('"')) return JSON.parse(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/u.test(value)) return Number(value);
  return value;
}

function required(options, key) {
  const value = options[key]?.trim();
  if (!value) throw new Error(`Missing required option --${key}`);
  if (/\r|\n/u.test(value)) throw new Error(`--${key} must be a single line`);
  return value;
}

function httpsOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an HTTPS origin without credentials, query, or fragment`);
  }
  if (url.pathname !== "/") throw new Error(`${label} must not include a path`);
  return url.origin;
}

function httpsURL(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label} must be an HTTPS URL without credentials`);
  }
  return url.href;
}

function validXcconfigText(value) {
  return value.length <= 40 && !/[\r\n=#$\\/]/u.test(value);
}

function validBundleId(value) {
  return value.includes(".")
    && !value.includes("..")
    && /^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/u.test(value);
}

function validCloudflareName(value) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}

function cloudflareId(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`${label} must be a Cloudflare D1 database UUID`);
  }
  return value.toLowerCase();
}

function urlForXcconfig(value) {
  return value.replace("://", ":/$()/");
}
