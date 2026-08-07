// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Miniflare } from "miniflare";
import { serializeSignedCookie } from "better-call";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import authWorker, {
  createBellwireAuth,
  ServiceBoundAppleOAuthClient,
  type AuthEnv,
} from "../src/auth/index";
import { InMemoryBellwireRepository } from "../src/repositories/in-memory-bellwire-repository";
import { PrincipalAuthenticator } from "../src/security/authenticator";
import {
  AppleTokenClient,
  decryptAppleRefreshToken,
} from "../src/services/apple-auth-service";

let miniflare: Miniflare;
let database: D1Database;
let applePrivateKey: string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  applePrivateKey = await exportPKCS8(privateKey);
});

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { AUTH_DB: crypto.randomUUID() },
  });
  database = await miniflare.getD1Database("AUTH_DB") as unknown as D1Database;
  await database.exec(readFileSync(resolve("d1/auth/0001_auth.sql"), "utf8")
    .replace(/^--.*$/gmu, "")
    .replace(/\s+/gu, " "));
});

afterEach(async () => {
  await miniflare.dispose();
});

describe("Bellwire Auth Worker", () => {
  it("reports D1 health and rejects incomplete native Apple requests", async () => {
    const env = authEnv();
    const health = await authWorker.fetch(
      new Request("https://auth.bellwire.app/health"),
      env,
      executionContext(),
    );
    await expect(health.json()).resolves.toMatchObject({ ok: true, service: "bellwire-auth" });

    const invalid = await authWorker.fetch(
      new Request("https://auth.bellwire.app/v1/native/apple/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
      executionContext(),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "AUTH_INVALID_REQUEST" },
    });
  });

  it("keeps health and JWKS available while blocking sign-in during cutover", async () => {
    const env = { ...authEnv(), CUTOVER_WRITE_FREEZE: "true" as const };
    const health = await authWorker.fetch(
      new Request("https://auth.bellwire.app/health"),
      env,
      executionContext(),
    );
    expect(health.status).toBe(200);
    const jwks = await authWorker.fetch(
      new Request("https://auth.bellwire.app/api/auth/jwks"),
      env,
      executionContext(),
    );
    expect(jwks.status).toBe(200);
    const blocked = await authWorker.fetch(
      new Request("https://auth.bellwire.app/v1/native/apple/sign-in", { method: "POST" }),
      env,
      executionContext(),
    );
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("120");
  });

  it("obtains the Apple client secret over a service binding without a local private key", async () => {
    const env = authEnv();
    const clientSecret = await new AppleTokenClient({
      keyId: env.APPLE_SIGN_IN_KEY_ID!,
      teamId: env.APPLE_SIGN_IN_TEAM_ID!,
      clientId: env.APPLE_SIGN_IN_CLIENT_ID,
      privateKey: env.APPLE_SIGN_IN_PRIVATE_KEY!,
    }).createClientSecret();
    const serviceFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(new URL(request.url).pathname).toBe("/internal/auth/apple/client-secret");
      expect(request.headers.get("authorization"))
        .toBe(`Bearer ${env.AUTH_INTERNAL_SECRET}`);
      return Response.json({ clientSecret });
    });
    const remoteEnv: AuthEnv = {
      ...env,
      APPLE_SIGN_IN_KEY_ID: undefined,
      APPLE_SIGN_IN_TEAM_ID: undefined,
      APPLE_SIGN_IN_PRIVATE_KEY: undefined,
      APPLE_AUTH_SERVICE: { fetch: serviceFetch } as unknown as Fetcher,
    };

    const auth = await createBellwireAuth(remoteEnv);
    const response = await auth.handler(new Request(
      "https://auth.bellwire.app/api/auth/jwks",
    ));
    expect(response.status).toBe(200);
    expect(serviceFetch).toHaveBeenCalledTimes(1);
  });

  it("exchanges and revokes Apple tokens through the API service binding", async () => {
    const requests: Request[] = [];
    const service = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        return request.url.endsWith("/exchange")
          ? Response.json({ refreshToken: "remote-refresh-token" })
          : new Response(null, { status: 204 });
      },
    } as unknown as Fetcher;
    const client = new ServiceBoundAppleOAuthClient(
      service,
      "internal-secret",
      "https://auth.bellwire.app",
    );

    await expect(client.exchangeAuthorizationCode("authorization-code"))
      .resolves.toBe("remote-refresh-token");
    await client.revokeRefreshToken("remote-refresh-token");
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/auth/apple/exchange",
      "/internal/auth/apple/revoke",
    ]);
    await expect(requests[0]!.json()).resolves.toEqual({
      authorizationCode: "authorization-code",
    });
    await expect(requests[1]!.json()).resolves.toEqual({
      refreshToken: "remote-refresh-token",
    });
  });

  it("protects internal deletion and cascades Better Auth sessions", async () => {
    const now = "2026-08-07T10:00:00.000Z";
    await database.batch([
      database.prepare(`
        INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES (?, ?, ?, 1, ?, ?)
      `).bind("user-1", "Bellwire User", "user@example.com", now, now),
      database.prepare(`
        INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind("session-1", "2026-09-07T10:00:00.000Z", "session-token", now, now, "user-1"),
    ]);
    const env = authEnv();
    const unauthorized = await authWorker.fetch(
      new Request("https://auth.bellwire.app/internal/users/user-1", { method: "DELETE" }),
      env,
      executionContext(),
    );
    expect(unauthorized.status).toBe(401);

    const deleted = await authWorker.fetch(
      new Request("https://auth.bellwire.app/internal/users/user-1", {
        method: "DELETE",
        headers: { authorization: `Bearer ${env.AUTH_INTERNAL_SECRET}` },
      }),
      env,
      executionContext(),
    );
    expect(deleted.status).toBe(204);
    await expect(database.prepare('SELECT id FROM "user" WHERE id = ?').bind("user-1").first())
      .resolves.toBeNull();
    await expect(database.prepare('SELECT id FROM "session" WHERE id = ?').bind("session-1").first())
      .resolves.toBeNull();
  });

  it("keeps Apple token rewrap disabled by default and verifies migrated ciphertext", async () => {
    const now = "2026-08-08T10:00:00.000Z";
    await database.prepare(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES (?, ?, ?, 1, ?, ?)
    `).bind("user-rewrap", "Rewrap User", "rewrap@example.com", now, now).run();
    const baseEnv = authEnv();
    const request = (authorization?: string) => new Request(
      "https://auth.bellwire.app/internal/migrations/apple-refresh-tokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({
          tokens: [{ userId: "user-rewrap", refreshToken: "legacy-refresh-token" }],
        }),
      },
    );

    const disabled = await authWorker.fetch(request(), baseEnv, executionContext());
    expect(disabled.status).toBe(404);

    const env = { ...baseEnv, APPLE_TOKEN_REWRAP_SECRET: "one-time-rewrap-secret" };
    const unauthorized = await authWorker.fetch(request("Bearer wrong"), env, executionContext());
    expect(unauthorized.status).toBe(401);

    const migrated = await authWorker.fetch(
      request(`Bearer ${env.APPLE_TOKEN_REWRAP_SECRET}`),
      env,
      executionContext(),
    );
    expect(migrated.status).toBe(200);
    await expect(migrated.json()).resolves.toEqual({ migrated: 1, verified: 1 });
    const stored = await database.prepare(`
      SELECT encrypted_refresh_token FROM apple_auth_tokens WHERE user_id = ?
    `).bind("user-rewrap").first<{ encrypted_refresh_token: string }>();
    expect(stored?.encrypted_refresh_token).toMatch(/^v1\./u);
    expect(stored?.encrypted_refresh_token).not.toContain("legacy-refresh-token");
    await expect(decryptAppleRefreshToken(
      stored!.encrypted_refresh_token,
      env.APPLE_TOKEN_ENCRYPTION_KEY,
    )).resolves.toBe("legacy-refresh-token");
  });

  it("publishes an ES256 JWKS for Bellwire API access tokens", async () => {
    const response = await authWorker.fetch(
      new Request("https://auth.bellwire.app/api/auth/jwks"),
      authEnv(),
      executionContext(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      keys: [{ alg: "ES256", kty: "EC", crv: "P-256" }],
    });
  });

  it("refreshes and revokes a native Better Auth bearer session", async () => {
    const now = new Date().toISOString();
    await database.batch([
      database.prepare(`
        INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES (?, ?, ?, 1, ?, ?)
      `).bind("user-native", "Native User", "native@example.com", now, now),
      database.prepare(`
        INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        "session-native",
        new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
        "native-refresh-token",
        now,
        now,
        "user-native",
      ),
    ]);
    const env = authEnv();
    const bearerToken = (await serializeSignedCookie(
      "",
      "native-refresh-token",
      env.BETTER_AUTH_SECRET,
    )).replace("=", "");
    const refreshed = await authWorker.fetch(
      new Request("https://auth.bellwire.app/v1/native/session/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: bearerToken }),
      }),
      env,
      executionContext(),
    );
    expect(refreshed.status).toBe(200);
    const refreshedBody = await refreshed.json<{
      accessToken: string;
      refreshToken: string;
      user: { id: string };
    }>();
    expect(refreshedBody).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: { id: "user-native" },
    });
    let serviceFetches = 0;
    const authService = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        serviceFetches += 1;
        const request = input instanceof Request ? input : new Request(input, init);
        return authWorker.fetch(request, env, executionContext());
      },
    } as unknown as Fetcher;
    const authenticator = new PrincipalAuthenticator(new InMemoryBellwireRepository(), {
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      authService,
    });
    await expect(authenticator.authenticate(`Bearer ${refreshedBody.accessToken}`))
      .resolves.toMatchObject({ kind: "user", userId: "user-native" });
    await expect(authenticator.authenticate(`Bearer ${refreshedBody.accessToken}`))
      .resolves.toMatchObject({ kind: "user", userId: "user-native" });
    expect(serviceFetches).toBe(1);

    const revoked = await authWorker.fetch(
      new Request("https://auth.bellwire.app/v1/native/session/revoke", {
        method: "POST",
        headers: { authorization: `Bearer ${refreshedBody.refreshToken}` },
      }),
      env,
      executionContext(),
    );
    expect(revoked.status).toBe(204);
    await expect(database.prepare('SELECT id FROM "session" WHERE id = ?')
      .bind("session-native").first()).resolves.toBeNull();
  });
});

function authEnv(): AuthEnv {
  return {
    AUTH_DB: database,
    AUTH_ENVIRONMENT: "development",
    AUTH_ISSUER: "https://auth.bellwire.app",
    AUTH_AUDIENCE: "bellwire-api",
    BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    AUTH_INTERNAL_SECRET: "internal-secret-that-is-at-least-32-characters",
    APPLE_SIGN_IN_KEY_ID: "ABC123DEFG",
    APPLE_SIGN_IN_TEAM_ID: "ABC123DEFG",
    APPLE_SIGN_IN_CLIENT_ID: "app.bellwire",
    APPLE_APP_BUNDLE_ID: "app.bellwire",
    APPLE_SIGN_IN_PRIVATE_KEY: applePrivateKey,
    APPLE_TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
}

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}
