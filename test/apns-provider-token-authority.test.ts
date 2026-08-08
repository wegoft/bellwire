// SPDX-License-Identifier: AGPL-3.0-only
import { jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  ApnsClient,
  ApnsClientPool,
  type ApnsNotification,
  type ApnsProviderToken,
} from "../src/services/apns-client";
import {
  ApnsProviderTokenAuthority,
  DurableObjectApnsProviderTokenSource,
} from "../src/services/apns-provider-token-authority";
import worker, { type Env } from "../src/index";

class MemoryDurableObjectStorage {
  readonly records = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.records.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.records.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key);
  }
}

describe("APNs provider token authority", () => {
  it("addresses one globally named Durable Object", () => {
    const idFromName = vi.fn(() => ({}) as DurableObjectId);
    const get = vi.fn(() => ({ fetch }) as DurableObjectStub);

    new DurableObjectApnsProviderTokenSource({ idFromName, get } as unknown as DurableObjectNamespace);

    expect(idFromName).toHaveBeenCalledWith("apns-provider-token-v1");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not enable Apple OAuth when only the shared encryption secret is configured", async () => {
    const response = await worker.fetch(
      new Request("https://bellwire.test/health"),
      {
        APP_ENV: "development",
        APPLE_TOKEN_ENCRYPTION_KEY: encryptionKey(7),
      } as Env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
  });

  it("signs an ES256 provider JWT inside the authority", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const storage = new MemoryDurableObjectStorage();
    const authority = new ApnsProviderTokenAuthority(stateWith(storage), {
      APNS_KEY_ID: "KEY123",
      APNS_TEAM_ID: "TEAM123",
      APNS_PRIVATE_KEY: await privateKeyPEM(keyPair.privateKey),
      APPLE_TOKEN_ENCRYPTION_KEY: encryptionKey(7),
    }, {
      now: () => Date.now(),
      randomUUID: () => "generation-signed-0001",
    });

    const providerToken = await requestProviderToken(authority);
    const verified = await jwtVerify(providerToken.value, keyPair.publicKey, {
      issuer: "TEAM123",
    });

    expect(verified.protectedHeader).toMatchObject({ alg: "ES256", kid: "KEY123" });
    expect(verified.payload.iat).toEqual(expect.any(Number));
  });

  it("shares one encrypted JWT across independent consumer pools and APNs environments", async () => {
    const now = Date.now();
    const storage = new MemoryDurableObjectStorage();
    const env = authorityEnv();
    const signProviderToken = vi.fn(async () => {
      await Promise.resolve();
      return "shared-provider-jwt";
    });
    const authority = new ApnsProviderTokenAuthority(stateWith(storage), env, {
      now: () => now,
      randomUUID: () => "generation-shared-0001",
      signProviderToken,
    });
    const firstSource = new DurableObjectApnsProviderTokenSource(namespaceFor(authority));
    const secondSource = new DurableObjectApnsProviderTokenSource(namespaceFor(authority));
    const authorizations: string[] = [];
    const apnsFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      authorizations.push(request.headers.get("authorization") ?? "");
      return new Response(null, { status: 200 });
    };
    const createClient = vi.fn((config, providerTokens) =>
      new ApnsClient(config, providerTokens, apnsFetch)
    );
    const firstPool = new ApnsClientPool(createClient);
    const secondPool = new ApnsClientPool(createClient);
    const sandbox = firstPool.get(apnsConfig("sandbox"), firstSource);
    const production = secondPool.get(apnsConfig("production"), secondSource);

    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 === 0 ? sandbox : production).send(
        `device-${index}`,
        privateNotification(index),
      )
    ));

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(signProviderToken).toHaveBeenCalledTimes(1);
    expect(authorizations).toHaveLength(12);
    expect(new Set(authorizations)).toEqual(new Set(["bearer shared-provider-jwt"]));
    expect(storage.records.size).toBe(1);
    const serializedStorage = JSON.stringify([...storage.records.entries()]);
    expect(serializedStorage).not.toContain("shared-provider-jwt");
    expect(serializedStorage).not.toContain(env.APNS_PRIVATE_KEY);
    expect(serializedStorage).not.toContain(env.APPLE_TOKEN_ENCRYPTION_KEY);
    expect(serializedStorage).not.toContain("generation-shared-0001");
    expect([...storage.records.values()][0]).toEqual(expect.objectContaining({
      version: 1,
      keyId: env.APNS_KEY_ID,
      expiresAt: now + 50 * 60 * 1_000,
      ciphertext: expect.any(String),
    }));
  });

  it("restores the encrypted JWT after a DO restart and rotates it at 50 minutes", async () => {
    let now = Date.now();
    let generation = 0;
    const storage = new MemoryDurableObjectStorage();
    const env = authorityEnv();
    const signProviderToken = vi.fn(async () => `provider-jwt-${signProviderToken.mock.calls.length}`);
    const dependencies = {
      now: () => now,
      randomUUID: () => `generation-rotate-${String(++generation).padStart(4, "0")}`,
      signProviderToken,
    };
    const firstAuthority = new ApnsProviderTokenAuthority(stateWith(storage), env, dependencies);
    const first = await requestProviderToken(firstAuthority);

    now += 49 * 60 * 1_000;
    const restartedAuthority = new ApnsProviderTokenAuthority(stateWith(storage), env, dependencies);
    const restored = await requestProviderToken(restartedAuthority);

    expect(restored).toEqual(first);
    expect(signProviderToken).toHaveBeenCalledTimes(1);

    now += 60 * 1_000;
    const rotated = await requestProviderToken(restartedAuthority);

    expect(rotated.value).not.toBe(first.value);
    expect(rotated.generation).not.toBe(first.generation);
    expect(rotated.expiresAt).toBe(now + 50 * 60 * 1_000);
    expect(signProviderToken).toHaveBeenCalledTimes(2);
  });

  it("rotates for signing credential changes and safely rebuilds an unreadable envelope", async () => {
    const now = Date.now();
    let generation = 0;
    const storage = new MemoryDurableObjectStorage();
    const env = authorityEnv();
    const signProviderToken = vi.fn(async () => `provider-jwt-${signProviderToken.mock.calls.length}`);
    const dependencies = {
      now: () => now,
      randomUUID: () => `generation-config-${String(++generation).padStart(4, "0")}`,
      signProviderToken,
    };
    const authority = new ApnsProviderTokenAuthority(stateWith(storage), env, dependencies);
    const first = await requestProviderToken(authority);

    env.APNS_PRIVATE_KEY = "rotated-private-key-material";
    const credentialRotated = await requestProviderToken(authority);

    expect(credentialRotated.value).not.toBe(first.value);
    expect(signProviderToken).toHaveBeenCalledTimes(2);

    env.APPLE_TOKEN_ENCRYPTION_KEY = encryptionKey(9);
    const encryptionRebuilt = await requestProviderToken(authority);

    expect(encryptionRebuilt.value).not.toBe(credentialRotated.value);
    expect(signProviderToken).toHaveBeenCalledTimes(3);
    expect(JSON.stringify([...storage.records.entries()])).not.toContain(encryptionRebuilt.value);
  });

  it("invalidates only the matching provider-token generation", async () => {
    const now = Date.now();
    let generation = 0;
    const storage = new MemoryDurableObjectStorage();
    const signProviderToken = vi.fn(async () => `provider-jwt-${signProviderToken.mock.calls.length}`);
    const authority = new ApnsProviderTokenAuthority(stateWith(storage), authorityEnv(), {
      now: () => now,
      randomUUID: () => `generation-cas-${String(++generation).padStart(6, "0")}`,
      signProviderToken,
    });
    const first = await requestProviderToken(authority);

    expect(await invalidateProviderToken(authority, "generation-stale-000001")).toBe(false);
    expect(await requestProviderToken(authority)).toEqual(first);
    expect(await invalidateProviderToken(authority, first.generation)).toBe(true);

    const replacement = await requestProviderToken(authority);
    expect(replacement.generation).not.toBe(first.generation);
    expect(replacement.value).not.toBe(first.value);
    expect(signProviderToken).toHaveBeenCalledTimes(2);
  });

  it("serializes source invalidation before a subsequent token read", async () => {
    const firstToken: ApnsProviderToken = {
      value: "provider-jwt-old",
      expiresAt: Date.now() + 50 * 60 * 1_000,
      generation: "generation-source-old",
    };
    const replacement: ApnsProviderToken = {
      value: "provider-jwt-new",
      expiresAt: Date.now() + 50 * 60 * 1_000,
      generation: "generation-source-new",
    };
    let current = firstToken;
    let tokenReads = 0;
    let finishInvalidation: (() => void) | undefined;
    let markInvalidationStarted: (() => void) | undefined;
    const invalidationStarted = new Promise<void>((resolve) => {
      markInvalidationStarted = resolve;
    });
    const invalidationGate = new Promise<void>((resolve) => {
      finishInvalidation = resolve;
    });
    const source = new DurableObjectApnsProviderTokenSource(namespaceForFetch(async (request) => {
      if (new URL(request.url).pathname === "/token") {
        tokenReads += 1;
        return jsonResponse(current);
      }
      markInvalidationStarted?.();
      await invalidationGate;
      current = replacement;
      return jsonResponse({ invalidated: true });
    }));
    expect(await source.getProviderToken()).toEqual(firstToken);

    const invalidation = source.invalidateProviderToken(firstToken.generation);
    await invalidationStarted;
    const nextRead = source.getProviderToken();
    await Promise.resolve();

    expect(tokenReads).toBe(1);
    finishInvalidation?.();
    await invalidation;
    await expect(nextRead).resolves.toEqual(replacement);
    expect(tokenReads).toBe(2);
  });
});

function authorityEnv() {
  return {
    APNS_KEY_ID: "KEY123",
    APNS_TEAM_ID: "TEAM123",
    APNS_PRIVATE_KEY: "private-key-material",
    APPLE_TOKEN_ENCRYPTION_KEY: encryptionKey(7),
  };
}

function encryptionKey(byte: number): string {
  return base64Url(new Uint8Array(32).fill(byte));
}

async function privateKeyPEM(privateKey: CryptoKey): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

function stateWith(storage: MemoryDurableObjectStorage): DurableObjectState {
  return { storage } as unknown as DurableObjectState;
}

function namespaceFor(authority: ApnsProviderTokenAuthority): DurableObjectNamespace {
  return namespaceForFetch((request) => authority.fetch(request));
}

function namespaceForFetch(
  handler: (request: Request) => Promise<Response>,
): DurableObjectNamespace {
  const stubFetch: typeof fetch = async (input, init) =>
    handler(new Request(input, init));
  return {
    idFromName: () => ({}) as DurableObjectId,
    get: () => ({ fetch: stubFetch }) as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

async function requestProviderToken(
  authority: ApnsProviderTokenAuthority,
): Promise<ApnsProviderToken> {
  const response = await authority.fetch(new Request(
    "https://apns-provider-token.internal/token",
    { method: "POST" },
  ));
  expect(response.status).toBe(200);
  return response.json<ApnsProviderToken>();
}

async function invalidateProviderToken(
  authority: ApnsProviderTokenAuthority,
  generation: string,
): Promise<boolean> {
  const response = await authority.fetch(new Request(
    "https://apns-provider-token.internal/invalidate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation }),
    },
  ));
  expect(response.status).toBe(200);
  return (await response.json<{ invalidated: boolean }>()).invalidated;
}

function apnsConfig(environment: "sandbox" | "production") {
  return {
    bundleId: "app.bellwire",
    urlScheme: "bellwire",
    appName: "Bellwire",
    environment,
  };
}

function privateNotification(index: number): ApnsNotification {
  return {
    signalId: `wake-${index}`,
    threadId: "private-project",
    priority: "normal",
    wakeId: `wake-${index}`,
    projectId: "private-project",
    deliveryMode: "private",
    reference: `opaque-reference-${index}`,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}
