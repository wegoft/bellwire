#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseArguments } from "./self-host-config.mjs";

const usage = `Bellwire Supabase to Cloudflare migration preparation

Usage:
  npm run migration:prepare -- --snapshot /secure/bellwire-snapshot.json --output /secure/bellwire-d1-import

The snapshot is a JSON object with top-level arrays named after Supabase tables,
plus auth_users and auth_identities arrays whenever user-owned rows exist. Output
is deterministic D1 SQL for the business and Auth databases, together with a reconciliation report.
The output directory must not already exist.
`;

const options = parseArguments(
  process.argv.slice(2),
  new Set(["help"]),
  new Set(["snapshot", "output", "help"]),
);

if (options.help) {
  process.stdout.write(usage);
  process.exit(0);
}

async function main() {
  try {
    const snapshotPath = path.resolve(required(options.snapshot, "--snapshot"));
    const outputDirectory = path.resolve(required(options.output, "--output"));
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("snapshot root must be a JSON object");
    }
    const identityCoverage = validateIdentityCoverage(snapshot);

    const preparedAt = new Date().toISOString();
    const business = prepareBusiness(snapshot, preparedAt);
    const auth = prepareAuth(snapshot, preparedAt);
    const report = {
      source: "supabase",
      preparedAt,
      snapshotSha256: sha256(JSON.stringify(snapshot)),
      business: business.counts,
      auth: auth.counts,
      identityCoverage,
      gates: {
        sourceSnapshotRequired: true,
        applyBusinessD1: false,
        applyAuthD1: false,
        reconcileCounts: false,
        productionCutover: false,
        supabaseRetired: false,
      },
    };

    await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
    await Promise.all([
      writeFile(path.join(outputDirectory, "business.sql"), business.sql, { flag: "wx", mode: 0o600 }),
      writeFile(path.join(outputDirectory, "auth.sql"), auth.sql, { flag: "wx", mode: 0o600 }),
      writeFile(
        path.join(outputDirectory, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      ),
    ]);
    process.stdout.write(`${JSON.stringify({ ok: true, outputDirectory, ...report }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Bellwire migration preparation: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exit(1);
  }
}

const entityTables = {
  projects: descriptor("project", (row) => row.id, (row) => ({
    ownerId: row.user_id,
    alternateKey: row.slug,
    state: row.status,
    timestamp: row.created_at,
    displayOrder: row.display_order,
  })),
  devices: descriptor("device", (row) => row.id, (row) => ({
    ownerId: row.user_id,
    alternateKey: row.apns_token,
    secondaryKey: row.installation_id,
    state: row.push_enabled ? "active" : "disabled",
    timestamp: row.last_active_at,
  })),
  device_live_activity_capabilities: descriptor(
    "device_live_activity_capability",
    (row) => row.device_id,
    (row) => ({ ownerId: row.user_id, parentId: row.device_id, timestamp: row.updated_at }),
  ),
  live_activity_registrations: descriptor(
    "live_activity_registration",
    (row) => row.activity_id,
    (row) => ({
      ownerId: row.user_id,
      parentId: row.device_id,
      alternateKey: compoundId(row.project_id, row.session_id),
      timestamp: row.updated_at,
      expiresAt: row.expires_at,
    }),
  ),
  live_activity_start_requests: descriptor(
    "live_activity_start_request",
    (row) => compoundId(row.device_id, row.project_id, row.session_id),
    (row) => ({
      parentId: row.device_id,
      alternateKey: row.project_id,
      secondaryKey: row.session_id,
      timestamp: row.created_at,
    }),
  ),
  device_bindings: descriptor("device_binding", (row) => row.id, (row) => ({
    ownerId: row.user_id,
    alternateKey: row.code_hash,
    secondaryKey: row.device_key_id,
    state: row.consumed_at ? "consumed" : "pending",
    timestamp: row.consumed_at ?? row.created_at,
    expiresAt: row.expires_at,
  })),
  agent_tokens: descriptor("agent_token", (row) => row.id, tokenMeta("user_id")),
  device_keys: descriptor("device_key", (row) => row.id, (row) => ({
    ownerId: row.user_id,
    alternateKey: row.installation_id,
    state: row.revoked_at ? "revoked" : "active",
    timestamp: row.last_active_at,
  })),
  direct_connection_envelopes: descriptor("direct_connection_envelope", (row) => row.id, (row) => ({
    ownerId: row.user_id,
    parentId: row.project_id,
    alternateKey: row.device_key_id,
    timestamp: row.created_at,
    expiresAt: row.expires_at,
  })),
  private_connection_readiness: descriptor(
    "private_connection_readiness",
    (row) => compoundId(row.project_id, row.device_key_id),
    (row) => ({
      ownerId: row.user_id,
      parentId: row.project_id,
      alternateKey: row.device_key_id,
      state: "ready",
      timestamp: row.last_verified_at,
    }),
  ),
  direct_connection_recovery_requests: descriptor(
    "direct_connection_recovery_request",
    (row) => compoundId(row.project_id, row.device_key_id),
    (row) => ({
      ownerId: row.user_id,
      parentId: row.project_id,
      alternateKey: row.device_key_id,
      timestamp: row.requested_at,
    }),
  ),
  delivery_mode_change_requests: descriptor(
    "delivery_mode_change_request",
    (row) => row.id,
    (row) => ({
      ownerId: row.user_id,
      parentId: row.project_id,
      state: row.status,
      timestamp: row.created_at,
      expiresAt: row.expires_at,
    }),
  ),
  event_schemas: descriptor("event_schema", (row) => row.id, versionMeta),
  notification_surfaces: descriptor("notification_surface", (row) => row.id, versionMeta),
  live_surfaces: descriptor("live_surface", (row) => row.id, (row) => ({
    parentId: row.project_id,
    alternateKey: row.surface_key,
    state: "active",
    timestamp: row.updated_at,
    displayOrder: row.display_order,
    revision: row.version,
  })),
  ingest_tokens: descriptor("ingest_token", (row) => row.id, tokenMeta("project_id")),
  private_wake_tokens: descriptor("private_wake_token", (row) => row.id, tokenMeta("project_id")),
  events: descriptor("event", (row) => row.id, (row) => ({
    parentId: row.project_id,
    alternateKey: row.idempotency_key_hash,
    secondaryKey: row.event_type,
    state: row.read_at ? "read" : "unread",
    timestamp: row.received_at,
  })),
  private_wakes: descriptor("private_wake", (row) => row.id, (row) => ({
    parentId: row.project_id,
    alternateKey: row.idempotency_key_hash,
    timestamp: row.received_at,
  })),
  deliveries: descriptor("delivery", (row) => row.id, deliveryMeta("event_id")),
  private_wake_deliveries: descriptor(
    "private_wake_delivery",
    (row) => row.id,
    deliveryMeta("wake_id"),
  ),
  apple_transactions: descriptor("apple_transaction", (row) => row.transaction_id, (row) => ({
    ownerId: row.user_id,
    alternateKey: row.original_transaction_id,
    state: row.status,
    timestamp: row.signed_date,
    expiresAt: row.expires_at,
  })),
};

function prepareBusiness(snapshot, preparedAt) {
  const lines = ["-- Generated by scripts/prepare-cloudflare-migration.mjs", "PRAGMA foreign_keys = ON;"];
  const counts = {};
  const latestEntitlement = new Map();
  for (const [table, config] of Object.entries(entityTables)) {
    const rows = rowsFor(snapshot, table);
    counts[table] = rows.length;
    for (const row of rows) {
      const id = required(config.id(row), `${table} row id`);
      const payload = normalizePayload(table, row);
      lines.push(entityInsert(config.kind, id, payload, config.meta(row)));
      lines.push(ledgerInsert(table, id, row.updated_at ?? row.created_at, row, preparedAt));
      if (table === "apple_transactions") {
        const current = latestEntitlement.get(row.user_id);
        if (!current || String(current.signed_date) <= String(row.signed_date)) {
          latestEntitlement.set(row.user_id, {
            row,
            payload: entitlementFromTransaction(payload),
          });
        }
      }
    }
  }
  const billingEntitlements = rowsFor(snapshot, "billing_entitlements");
  counts.billing_entitlements = billingEntitlements.length;
  for (const row of billingEntitlements) {
    const userId = required(row.user_id, "billing_entitlements user_id");
    const originalTransactionId = required(
      row.original_transaction_id,
      `billing_entitlements ${userId} original_transaction_id`,
    );
    const signedDate = required(row.latest_signed_date, `billing_entitlements ${userId} latest_signed_date`);
    const current = latestEntitlement.get(userId);
    if (!current || String(current.row.signed_date ?? current.row.latest_signed_date) <= signedDate) {
      latestEntitlement.set(userId, {
        row: { ...row, signed_date: signedDate },
        payload: {
          status: row.status,
          productId: row.product_id,
          expiresAt: row.expires_at,
          downgradeDeadline: row.downgrade_deadline,
          originalTransactionId,
          signedDate,
          updatedAt: row.updated_at,
        },
      });
    }
  }
  for (const [userId, { row, payload }] of latestEntitlement) {
    lines.push(entityInsert("entitlement", userId, payload, {
      ownerId: userId,
      alternateKey: row.original_transaction_id,
      state: row.status,
      timestamp: row.signed_date,
      expiresAt: row.expires_at,
    }));
  }
  for (const row of rowsFor(snapshot, "monthly_signal_usage")) {
    lines.push(`INSERT INTO signal_usage (user_id, period_start, accepted_signals) VALUES (${sql(required(row.user_id, "monthly_signal_usage user_id"))}, ${sql(monthStart(required(row.month_start, "monthly_signal_usage month_start")))}, ${integer(row.accepted_signals)}) ON CONFLICT (user_id, period_start) DO UPDATE SET accepted_signals = excluded.accepted_signals;`);
  }
  counts.monthly_signal_usage = rowsFor(snapshot, "monthly_signal_usage").length;
  for (const row of rowsFor(snapshot, "apple_notification_receipts")) {
    lines.push(`INSERT OR IGNORE INTO apple_notification_receipts (notification_uuid, notification_type, subtype, signed_date, received_at) VALUES (${sql(required(row.notification_uuid, "apple_notification_receipts notification_uuid"))}, ${sql(required(row.notification_type, "apple_notification_receipts notification_type"))}, ${sql(row.subtype)}, ${sql(required(row.signed_date, "apple_notification_receipts signed_date"))}, ${sql(row.processed_at ?? row.created_at ?? row.signed_date)});`);
  }
  counts.apple_notification_receipts = rowsFor(snapshot, "apple_notification_receipts").length;
  for (const row of rowsFor(snapshot, "bellwire_waitlist")) {
    const email = required(row.email, "bellwire_waitlist email");
    const createdAt = required(row.created_at, `bellwire_waitlist ${email} created_at`);
    const id = String(row.id ?? sha256(`${email}:${createdAt}`));
    lines.push(`INSERT OR IGNORE INTO waitlist_archive (id, email, source, created_at, source_payload) VALUES (${sql(id)}, ${sql(email)}, ${sql(row.source)}, ${sql(createdAt)}, ${sql(JSON.stringify(row))});`);
  }
  counts.bellwire_waitlist = rowsFor(snapshot, "bellwire_waitlist").length;
  return { sql: `${lines.join("\n")}\n`, counts };
}

function prepareAuth(snapshot, preparedAt) {
  const lines = ["-- Generated by scripts/prepare-cloudflare-migration.mjs", "PRAGMA foreign_keys = ON;"];
  const users = rowsFor(snapshot, "auth_users");
  const identities = rowsFor(snapshot, "auth_identities");
  const appleTokens = rowsFor(snapshot, "apple_auth_tokens");
  for (const row of users) {
    const userId = required(row.id, "auth_users id");
    const email = required(row.email, `auth_users ${userId} email`);
    const createdAt = row.created_at ?? new Date(0).toISOString();
    const updatedAt = row.updated_at ?? createdAt;
    const name = row.raw_user_meta_data?.full_name ?? row.raw_user_meta_data?.name ?? "Bellwire User";
    lines.push(`INSERT OR IGNORE INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt") VALUES (${sql(userId)}, ${sql(name)}, ${sql(email)}, ${row.email_confirmed_at ? 1 : 0}, ${sql(row.raw_user_meta_data?.avatar_url)}, ${sql(createdAt)}, ${sql(updatedAt)});`);
    lines.push(`INSERT OR REPLACE INTO auth_migration_ledger (source, source_user_id, source_updated_at, checksum, imported_at) VALUES ('supabase', ${sql(userId)}, ${sql(updatedAt)}, ${sql(sha256(JSON.stringify(row)))}, ${sql(preparedAt)});`);
  }
  for (const row of identities.filter((identity) => identity.provider === "apple")) {
    const identityId = required(row.id, "auth_identities id");
    const userId = required(row.user_id, `auth_identities ${identityId} user_id`);
    const providerAccountId = row.identity_data?.sub ?? row.provider_id ?? row.id;
    const createdAt = row.created_at ?? new Date(0).toISOString();
    lines.push(`INSERT OR IGNORE INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (${sql(identityId)}, ${sql(required(providerAccountId, `auth_identities ${identityId} Apple subject`))}, 'apple', ${sql(userId)}, ${sql(createdAt)}, ${sql(row.updated_at ?? createdAt)});`);
  }
  for (const row of appleTokens) {
    const userId = required(row.user_id, "apple_auth_tokens user_id");
    const encryptedRefreshToken = row.encrypted_refresh_token ?? row.refresh_token_ciphertext;
    lines.push(`INSERT OR REPLACE INTO apple_auth_tokens (user_id, encrypted_refresh_token, updated_at) VALUES (${sql(userId)}, ${sql(required(encryptedRefreshToken, `apple_auth_tokens ${userId} encrypted refresh token`))}, ${sql(required(row.updated_at, `apple_auth_tokens ${userId} updated_at`))});`);
  }
  return {
    sql: `${lines.join("\n")}\n`,
    counts: { auth_users: users.length, auth_identities: identities.length, apple_auth_tokens: appleTokens.length },
  };
}

function descriptor(kind, id, meta) {
  return { kind, id, meta };
}

function tokenMeta(ownerField) {
  return (row) => ({
    ...(ownerField === "user_id" ? { ownerId: row[ownerField] } : { parentId: row[ownerField] }),
    alternateKey: row.token_hash,
    state: row.revoked_at ? "revoked" : "active",
    timestamp: row.created_at,
    expiresAt: row.expires_at,
  });
}

function versionMeta(row) {
  return {
    parentId: row.project_id,
    alternateKey: row.event_type,
    state: row.enabled === false ? "disabled" : "active",
    timestamp: row.created_at,
    revision: row.version,
  };
}

function deliveryMeta(parentField) {
  return (row) => ({
    parentId: row[parentField],
    alternateKey: row.device_id,
    state: row.status,
    timestamp: row.updated_at,
    attemptCount: row.attempt_count,
  });
}

function normalizePayload(table, row) {
  const payload = {};
  for (const [key, value] of Object.entries(row)) {
    if (value == null) continue;
    payload[snakeToCamel(key)] = value;
  }
  if (table === "notification_surfaces") {
    payload.group = row.group_name;
    delete payload.groupName;
  }
  if (table === "events") payload.status = "accepted";
  if (table === "event_schemas") payload.status = "active";
  if (table === "devices") payload.platform = "ios";
  if (table === "device_keys") payload.algorithm = "p256";
  if (table === "direct_connection_envelopes") {
    payload.manifestVersion = 2;
    payload.algorithm = "p256-hkdf-sha256-aes-gcm";
  }
  if (table === "private_connection_readiness") payload.manifestVersion = 2;
  if (table === "notification_surfaces") payload.type = "notification";
  if (table === "ingest_tokens") payload.scope = "event:ingest";
  if (table === "private_wake_tokens") payload.scope = "wake:send";
  if (table === "deliveries" || table === "private_wake_deliveries") payload.channel = "apns";
  return payload;
}

function entitlementFromTransaction(transaction) {
  const expired = transaction.status === "expired" || transaction.status === "revoked";
  const updatedAt = transaction.updatedAt;
  return {
    status: transaction.status,
    productId: transaction.productId,
    expiresAt: transaction.expiresAt,
    downgradeDeadline: expired && updatedAt
      ? new Date(Date.parse(updatedAt) + 7 * 24 * 60 * 60 * 1_000).toISOString()
      : undefined,
    originalTransactionId: transaction.originalTransactionId,
    signedDate: transaction.signedDate,
    updatedAt,
  };
}

function entityInsert(kind, id, payload, meta) {
  const values = [
    kind, id, meta.ownerId, meta.parentId, meta.alternateKey, meta.secondaryKey,
    meta.state, meta.timestamp, meta.expiresAt, meta.displayOrder, meta.revision,
    meta.attemptCount, JSON.stringify(payload),
  ].map(sql).join(", ");
  return `INSERT INTO bellwire_entities (kind, id, owner_id, parent_id, alternate_key, secondary_key, state, timestamp, expires_at, display_order, revision, attempt_count, payload) VALUES (${values}) ON CONFLICT (kind, id) DO UPDATE SET owner_id = excluded.owner_id, parent_id = excluded.parent_id, alternate_key = excluded.alternate_key, secondary_key = excluded.secondary_key, state = excluded.state, timestamp = excluded.timestamp, expires_at = excluded.expires_at, display_order = excluded.display_order, revision = excluded.revision, attempt_count = excluded.attempt_count, payload = excluded.payload;`;
}

function ledgerInsert(table, id, updatedAt, row, preparedAt) {
  return `INSERT OR REPLACE INTO migration_ledger (source_table, source_id, source_updated_at, checksum, imported_at) VALUES (${sql(table)}, ${sql(id)}, ${sql(updatedAt)}, ${sql(sha256(JSON.stringify(row)))}, ${sql(preparedAt)});`;
}

function rowsFor(snapshot, table) {
  const value = snapshot[table] ?? [];
  if (!Array.isArray(value)) throw new Error(`${table} must be an array`);
  return value;
}

function validateIdentityCoverage(snapshot) {
  const ownerIds = new Set(rowsFor(snapshot, "profiles").map((row) => required(row.id, "profiles id")));
  for (const table of [
    "projects",
    "devices",
    "device_bindings",
    "agent_tokens",
    "device_keys",
    "direct_connection_envelopes",
    "private_connection_readiness",
    "direct_connection_recovery_requests",
    "delivery_mode_change_requests",
    "device_live_activity_capabilities",
    "live_activity_registrations",
    "apple_transactions",
    "billing_entitlements",
    "monthly_signal_usage",
    "apple_auth_tokens",
  ]) {
    for (const row of rowsFor(snapshot, table)) {
      if (row.user_id != null) ownerIds.add(required(row.user_id, `${table} user_id`));
    }
  }
  const authUserIds = new Set(rowsFor(snapshot, "auth_users")
    .map((row) => required(row.id, "auth_users id")));
  const appleUserIds = new Set(rowsFor(snapshot, "auth_identities")
    .filter((row) => row.provider === "apple")
    .map((row) => required(row.user_id, "auth_identities Apple user_id")));
  const missingAuthUsers = [...ownerIds].filter((id) => !authUserIds.has(id));
  const missingAppleIdentities = [...ownerIds].filter((id) => !appleUserIds.has(id));
  if (missingAuthUsers.length || missingAppleIdentities.length) {
    const details = [
      missingAuthUsers.length
        ? `missing auth_users for ${missingAuthUsers.slice(0, 5).join(", ")}`
        : undefined,
      missingAppleIdentities.length
        ? `missing Apple auth_identities for ${missingAppleIdentities.slice(0, 5).join(", ")}`
        : undefined,
    ].filter(Boolean).join("; ");
    throw new Error(`identity coverage is incomplete: ${details}`);
  }
  return {
    userOwnedIds: ownerIds.size,
    matchedAuthUsers: ownerIds.size,
    matchedAppleIdentities: ownerIds.size,
  };
}

function sql(value) {
  if (value == null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function integer(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("expected a non-negative integer");
  return parsed;
}

function monthStart(value) {
  const text = String(value);
  return text.includes("T") ? text : new Date(`${text}T00:00:00.000Z`).toISOString();
}

function compoundId(...values) {
  return values.map((value) => `${String(value).length}:${value}`).join(":");
}

function snakeToCamel(value) {
  return value.replace(/_([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

await main();
