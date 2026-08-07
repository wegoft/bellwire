// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";

import worker, { type Env } from "../src/index";
import { encryptAppleRefreshToken } from "../src/services/apple-auth-service";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("legacy Apple refresh token migration", () => {
  it("serves health but blocks application requests during the cutover freeze", async () => {
    const env = {
      APP_ENV: "production",
      CUTOVER_WRITE_FREEZE: "true",
      DB: {
        prepare: () => ({ first: async () => ({ ok: 1 }) }),
      } as unknown as D1Database,
    } as Env;

    const health = await worker.fetch(
      new Request("https://api.bellwire.app/health"),
      env,
      executionContext(),
    );
    expect(health.status).toBe(200);

    const blocked = await worker.fetch(
      new Request("https://api.bellwire.app/v1/projects"),
      env,
      executionContext(),
    );
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("120");
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "CUTOVER_WRITE_FREEZE" },
    });
  });

  it("keeps the Apple private key in API while issuing a client secret internally", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const env = {
      APP_ENV: "production",
      AUTH_INTERNAL_SECRET: "internal-secret",
      APPLE_SIGN_IN_KEY_ID: "KEY123",
      APPLE_SIGN_IN_TEAM_ID: "TEAM123456",
      APPLE_SIGN_IN_CLIENT_ID: "app.bellwire",
      APPLE_SIGN_IN_PRIVATE_KEY: await exportPKCS8(privateKey),
      CUTOVER_WRITE_FREEZE: "true",
    } as Env;
    const unauthorized = await worker.fetch(
      new Request("https://api.bellwire.app/internal/auth/apple/client-secret", {
        method: "POST",
      }),
      env,
      executionContext(),
    );
    expect(unauthorized.status).toBe(401);
    const response = await worker.fetch(
      new Request("https://api.bellwire.app/internal/auth/apple/client-secret", {
        method: "POST",
        headers: { authorization: `Bearer ${env.AUTH_INTERNAL_SECRET}` },
      }),
      env,
      executionContext(),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ clientSecret: string }>();
    expect(body.clientSecret.split(".")).toHaveLength(3);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("is unavailable without the one-time secret and rejects a wrong secret", async () => {
    const sourceFetch = vi.fn();
    vi.stubGlobal("fetch", sourceFetch);
    const baseEnv = { APP_ENV: "production" } as Env;

    const disabled = await worker.fetch(
      migrationRequest("secret"),
      baseEnv,
      executionContext(),
    );
    expect(disabled.status).toBe(404);

    const unauthorized = await worker.fetch(
      migrationRequest("wrong"),
      { ...baseEnv, APPLE_TOKEN_REWRAP_SECRET: "secret" },
      executionContext(),
    );
    expect(unauthorized.status).toBe(401);
    expect(sourceFetch).not.toHaveBeenCalled();
  });

  it("decrypts only inside the API Worker and sends plaintext over the Auth service binding", async () => {
    const oldEncryptionKey = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const ciphertext = await encryptAppleRefreshToken("legacy-refresh-token", oldEncryptionKey);
    const sourceFetch = vi.fn<typeof fetch>(async () => Response.json([{
      user_id: "user-one",
      refresh_token_ciphertext: ciphertext,
    }]));
    vi.stubGlobal("fetch", sourceFetch);
    const authFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(new URL(request.url).pathname)
        .toBe("/internal/migrations/apple-refresh-tokens");
      expect(request.headers.get("authorization")).toBe("Bearer one-time-secret");
      await expect(request.json()).resolves.toEqual({
        tokens: [{ userId: "user-one", refreshToken: "legacy-refresh-token" }],
      });
      return Response.json({ migrated: 1, verified: 1 });
    });
    const env = {
      APP_ENV: "production",
      AUTH_ISSUER: "https://auth.bellwire.app",
      AUTH_SERVICE: { fetch: authFetch } as unknown as Fetcher,
      LEGACY_SUPABASE_URL: "https://legacy.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
      APPLE_TOKEN_ENCRYPTION_KEY: oldEncryptionKey,
      APPLE_TOKEN_REWRAP_SECRET: "one-time-secret",
    } as Env;

    const response = await worker.fetch(
      migrationRequest("one-time-secret"),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual({ source: 1, migrated: 1, verified: 1 });
    expect(responseText).not.toContain("legacy-refresh-token");
    expect(sourceFetch).toHaveBeenCalledTimes(1);
    const [sourceUrl, sourceInit] = sourceFetch.mock.calls[0]!;
    expect(String(sourceUrl)).toBe(
      "https://legacy.supabase.co/rest/v1/apple_auth_tokens"
      + "?select=user_id,refresh_token_ciphertext&order=user_id.asc",
    );
    expect(sourceInit?.headers).toMatchObject({
      apikey: "service-role-secret",
      authorization: "Bearer service-role-secret",
    });
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});

function migrationRequest(secret: string): Request {
  return new Request("https://api.bellwire.app/internal/migrations/apple-refresh-tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
}

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}
