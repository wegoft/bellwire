// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Supabase to D1 migration preparation", () => {
  it("generates replay-safe business and auth imports with a count report", async () => {
    const root = mkdtempSync(join(tmpdir(), "bellwire-migration-"));
    temporaryDirectories.push(root);
    const snapshotPath = join(root, "snapshot.json");
    const outputPath = join(root, "output");
    writeFileSync(snapshotPath, JSON.stringify(snapshot()));
    const result = spawnSync(process.execPath, [
      resolve("scripts/prepare-cloudflare-migration.mjs"),
      "--snapshot",
      snapshotPath,
      "--output",
      outputPath,
    ], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(outputPath, "report.json"), "utf8")))
      .toMatchObject({
        business: { projects: 1, events: 1, billing_entitlements: 1, bellwire_waitlist: 1 },
        auth: { auth_users: 1, auth_identities: 1, apple_auth_tokens: 1 },
        identityCoverage: {
          userOwnedIds: 1,
          matchedAuthUsers: 1,
          matchedAppleIdentities: 1,
        },
        gates: { productionCutover: false, supabaseRetired: false },
      });

    const miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: { DB: crypto.randomUUID(), AUTH_DB: crypto.randomUUID() },
    });
    try {
      const business = await miniflare.getD1Database("DB");
      const auth = await miniflare.getD1Database("AUTH_DB");
      await executeScript(business, readFileSync(resolve("d1/business/0001_bellwire.sql"), "utf8"));
      await executeScript(auth, readFileSync(resolve("d1/auth/0001_auth.sql"), "utf8"));
      await executeScript(business, readFileSync(join(outputPath, "business.sql"), "utf8"));
      await executeScript(auth, readFileSync(join(outputPath, "auth.sql"), "utf8"));
      await expect(business.prepare(
        "SELECT COUNT(*) AS count FROM bellwire_entities WHERE kind = 'event'",
      ).first()).resolves.toMatchObject({ count: 1 });
      await expect(business.prepare("SELECT email FROM waitlist_archive").first())
        .resolves.toMatchObject({ email: "waitlist@example.com" });
      const entitlement = await business.prepare(
        "SELECT payload FROM bellwire_entities WHERE kind = 'entitlement' AND id = 'user-1'",
      ).first<{ payload: string }>();
      expect(JSON.parse(entitlement?.payload ?? "{}"))
        .toMatchObject({ status: "expired", downgradeDeadline: "2026-08-14T10:00:00.000Z" });
      await expect(auth.prepare('SELECT email FROM "user"').first())
        .resolves.toMatchObject({ email: "user@example.com" });
      await expect(auth.prepare("SELECT encrypted_refresh_token FROM apple_auth_tokens").first())
        .resolves.toMatchObject({ encrypted_refresh_token: "v1.iv.ciphertext" });
    } finally {
      await miniflare.dispose();
    }
  });
});

async function executeScript(database: D1Database, source: string): Promise<void> {
  await database.exec(source.replace(/^--.*$/gmu, "").replace(/\s+/gu, " "));
}

function snapshot() {
  const now = "2026-08-07T10:00:00.000Z";
  return {
    projects: [{
      id: "project-1",
      user_id: "user-1",
      name: "Builds",
      slug: "builds",
      icon: "hammer",
      display_order: 0,
      category: "engineering",
      status: "active",
      delivery_mode: "hosted",
      endpoint: "https://example.com",
      created_at: now,
      updated_at: now,
    }],
    events: [{
      id: "event-1",
      project_id: "project-1",
      event_type: "build.completed",
      idempotency_key_hash: "idem-1",
      data: { branch: "main" },
      occurred_at: now,
      received_at: now,
    }],
    bellwire_waitlist: [{ id: "wait-1", email: "waitlist@example.com", source: "site", created_at: now }],
    billing_entitlements: [{
      user_id: "user-1",
      plan: "free",
      status: "expired",
      product_id: "app.bellwire.pro.monthly",
      original_transaction_id: "original-1",
      expires_at: now,
      downgrade_deadline: "2026-08-14T10:00:00.000Z",
      latest_signed_date: now,
      updated_at: now,
    }],
    auth_users: [{
      id: "user-1",
      email: "user@example.com",
      email_confirmed_at: now,
      created_at: now,
      updated_at: now,
      raw_user_meta_data: { name: "User" },
    }],
    auth_identities: [{
      id: "identity-1",
      user_id: "user-1",
      provider: "apple",
      identity_data: { sub: "apple-user-1" },
      created_at: now,
      updated_at: now,
    }],
    apple_auth_tokens: [{
      user_id: "user-1",
      refresh_token_ciphertext: "v1.iv.ciphertext",
      created_at: now,
      updated_at: now,
    }],
  };
}
