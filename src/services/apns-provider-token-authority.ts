// SPDX-License-Identifier: AGPL-3.0-only
import { importPKCS8, SignJWT } from "jose";

import type {
  ApnsProviderToken,
  ApnsProviderTokenSource,
} from "./apns-client";

const authorityObjectName = "apns-provider-token-v1";
const storageKey = "provider-token";
const tokenLifetimeMs = 50 * 60 * 1_000;
const encryptionVersion = 1;

interface AuthorityEnv {
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APPLE_TOKEN_ENCRYPTION_KEY?: string;
}

interface SigningCredentials {
  keyId: string;
  teamId: string;
  privateKey: string;
}

interface StoredProviderToken {
  version: 1;
  ciphertext: string;
  expiresAt: number;
  keyId: string;
}

interface EncryptedProviderToken {
  token: string;
  generation: string;
  credentialFingerprint: string;
}

interface CachedProviderToken extends ApnsProviderToken {
  credentialFingerprint: string;
  encryptionKeyFingerprint: string;
}

interface AuthorityDependencies {
  now?: () => number;
  randomUUID?: () => string;
  signProviderToken?: (
    credentials: SigningCredentials,
    issuedAtMs: number,
  ) => Promise<string>;
}

export class DurableObjectApnsProviderTokenSource implements ApnsProviderTokenSource {
  private readonly stub: DurableObjectStub;
  private operationTail: Promise<void> = Promise.resolve();
  private cached?: ApnsProviderToken;

  constructor(namespace: DurableObjectNamespace) {
    this.stub = namespace.get(namespace.idFromName(authorityObjectName));
  }

  getProviderToken(): Promise<ApnsProviderToken> {
    return this.runExclusive(async () => {
      const now = Date.now();
      if (this.cached && this.cached.expiresAt > now) return { ...this.cached };
      const token = await this.fetchProviderToken();
      this.cached = token;
      return { ...token };
    });
  }

  invalidateProviderToken(generation: string): Promise<void> {
    if (!isGeneration(generation)) throw new Error("Invalid APNs provider token generation");
    return this.runExclusive(async () => {
      if (this.cached?.generation === generation) this.cached = undefined;
      const response = await this.stub.fetch("https://apns-provider-token.internal/invalidate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation }),
      });
      if (!response.ok) {
        throw new Error(`APNs provider token invalidation failed (${response.status})`);
      }
    });
  }

  private async fetchProviderToken(): Promise<ApnsProviderToken> {
    const response = await this.stub.fetch("https://apns-provider-token.internal/token", {
      method: "POST",
    });
    if (!response.ok) throw new Error(`APNs provider token request failed (${response.status})`);
    const body: unknown = await response.json();
    if (!isProviderToken(body) || body.expiresAt <= Date.now()) {
      throw new Error("APNs provider token authority returned invalid data");
    }
    return body;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class ApnsProviderTokenAuthority {
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly signProviderToken: (
    credentials: SigningCredentials,
    issuedAtMs: number,
  ) => Promise<string>;
  private operationTail: Promise<void> = Promise.resolve();
  private pending?: Promise<ApnsProviderToken>;
  private cached?: CachedProviderToken;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: AuthorityEnv,
    dependencies: AuthorityDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => Date.now());
    this.randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
    this.signProviderToken = dependencies.signProviderToken ?? signProviderToken;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    if (url.pathname === "/token") {
      return jsonResponse(await this.getProviderToken());
    }
    if (url.pathname === "/invalidate") {
      const body: unknown = await request.json().catch(() => undefined);
      const generation = readGeneration(body);
      if (!generation) return jsonResponse({ error: "Invalid request" }, 400);
      return jsonResponse({ invalidated: await this.invalidateProviderToken(generation) });
    }
    return jsonResponse({ error: "Not found" }, 404);
  }

  private async getProviderToken(): Promise<ApnsProviderToken> {
    if (this.pending) return { ...await this.pending };

    const pending = this.runExclusive(() => this.loadOrCreateProviderToken());
    this.pending = pending;
    try {
      return { ...await pending };
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  private invalidateProviderToken(generation: string): Promise<boolean> {
    return this.runExclusive(async () => {
      if (this.cached) {
        if (this.cached.generation !== generation) return false;
        this.cached = undefined;
        await this.state.storage.delete(storageKey);
        return true;
      }

      const stored = await this.state.storage.get<unknown>(storageKey);
      if (!isStoredProviderToken(stored)) return false;
      try {
        const encrypted = await decryptProviderToken(
          stored,
          requiredEnv(this.env.APPLE_TOKEN_ENCRYPTION_KEY, "APPLE_TOKEN_ENCRYPTION_KEY"),
        );
        if (encrypted.generation !== generation) return false;
      } catch {
        return false;
      }
      await this.state.storage.delete(storageKey);
      return true;
    });
  }

  private async loadOrCreateProviderToken(): Promise<CachedProviderToken> {
    const now = this.now();
    const credentials = readSigningCredentials(this.env);
    const credentialFingerprint = await fingerprintCredentials(credentials);
    const encryptionKey = requiredEnv(
      this.env.APPLE_TOKEN_ENCRYPTION_KEY,
      "APPLE_TOKEN_ENCRYPTION_KEY",
    );
    const encryptionKeyFingerprint = await fingerprintEncryptionKey(encryptionKey);
    if (
      this.cached &&
      this.cached.expiresAt > now &&
      this.cached.credentialFingerprint === credentialFingerprint &&
      this.cached.encryptionKeyFingerprint === encryptionKeyFingerprint
    ) {
      return this.cached;
    }

    const stored = await this.state.storage.get<unknown>(storageKey);
    if (
      isStoredProviderToken(stored) &&
      stored.keyId === credentials.keyId &&
      stored.expiresAt > now &&
      stored.expiresAt <= now + tokenLifetimeMs
    ) {
      try {
        const encrypted = await decryptProviderToken(stored, encryptionKey);
        if (encrypted.credentialFingerprint === credentialFingerprint) {
          const cached = {
            value: encrypted.token,
            expiresAt: stored.expiresAt,
            generation: encrypted.generation,
            credentialFingerprint,
            encryptionKeyFingerprint,
          };
          if (isProviderToken(cached)) {
            this.cached = cached;
            return cached;
          }
        }
      } catch {
        // An unreadable record is replaced atomically below without exposing its contents.
      }
    }

    const token = await this.signProviderToken(credentials, now);
    const generation = this.randomUUID();
    if (!token || token.length > 4_096 || !isGeneration(generation)) {
      throw new Error("APNs provider token signing failed");
    }
    const cached: CachedProviderToken = {
      value: token,
      expiresAt: now + tokenLifetimeMs,
      generation,
      credentialFingerprint,
      encryptionKeyFingerprint,
    };
    const encrypted = await encryptProviderToken({
      token: cached.value,
      generation: cached.generation,
      credentialFingerprint,
    }, {
      version: encryptionVersion,
      expiresAt: cached.expiresAt,
      keyId: credentials.keyId,
    }, encryptionKey);
    await this.state.storage.put(storageKey, {
      version: encryptionVersion,
      ciphertext: encrypted,
      expiresAt: cached.expiresAt,
      keyId: credentials.keyId,
    } satisfies StoredProviderToken);
    this.cached = cached;
    return cached;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function signProviderToken(
  credentials: SigningCredentials,
  issuedAtMs: number,
): Promise<string> {
  const signingKey = await importPKCS8(normalizePrivateKey(credentials.privateKey), "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: credentials.keyId })
    .setIssuer(credentials.teamId)
    .setIssuedAt(Math.floor(issuedAtMs / 1_000))
    .sign(signingKey);
}

async function fingerprintCredentials(credentials: SigningCredentials): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    credentials.keyId,
    credentials.teamId,
    normalizePrivateKey(credentials.privateKey),
  ]));
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function fingerprintEncryptionKey(value: string): Promise<string> {
  const bytes = decodeEncryptionKey(value);
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function encryptProviderToken(
  value: EncryptedProviderToken,
  metadata: Pick<StoredProviderToken, "version" | "expiresAt" | "keyId">,
  keyValue: string,
): Promise<string> {
  const key = await importEncryptionKey(keyValue, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: additionalData(metadata),
  }, key, new TextEncoder().encode(JSON.stringify(value)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptProviderToken(
  stored: StoredProviderToken,
  keyValue: string,
): Promise<EncryptedProviderToken> {
  const [ivValue, ciphertextValue, extra] = stored.ciphertext.split(".");
  if (!ivValue || !ciphertextValue || extra) throw new Error("Invalid encrypted APNs token");
  const key = await importEncryptionKey(keyValue, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: fromBase64Url(ivValue),
    additionalData: additionalData(stored),
  }, key, fromBase64Url(ciphertextValue));
  const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (!isEncryptedProviderToken(value)) throw new Error("Invalid encrypted APNs token");
  return value;
}

function additionalData(
  metadata: Pick<StoredProviderToken, "version" | "expiresAt" | "keyId">,
): ArrayBuffer {
  return new TextEncoder().encode(
    `bellwire:apns-provider-token:${metadata.version}:${metadata.keyId}:${metadata.expiresAt}`,
  ).buffer as ArrayBuffer;
}

async function importEncryptionKey(value: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const bytes = decodeEncryptionKey(value);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages);
}

function decodeEncryptionKey(value: string): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64Url(value.trim().replace(/\+/gu, "-").replace(/\//gu, "_"));
  if (bytes.byteLength !== 32) throw new Error("APPLE_TOKEN_ENCRYPTION_KEY must contain 32 bytes");
  return bytes;
}

function readSigningCredentials(env: AuthorityEnv): SigningCredentials {
  return {
    keyId: requiredEnv(env.APNS_KEY_ID, "APNS_KEY_ID"),
    teamId: requiredEnv(env.APNS_TEAM_ID, "APNS_TEAM_ID"),
    privateKey: requiredEnv(env.APNS_PRIVATE_KEY, "APNS_PRIVATE_KEY"),
  };
}

function requiredEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for APNs delivery`);
  return value;
}

function normalizePrivateKey(value: string): string {
  return value.replaceAll("\\n", "\n").trim();
}

function readGeneration(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const generation = (value as Record<string, unknown>).generation;
  return typeof generation === "string" && isGeneration(generation) ? generation : undefined;
}

function isProviderToken(value: unknown): value is ApnsProviderToken {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ApnsProviderToken>;
  return typeof candidate.value === "string" && candidate.value.length > 0 &&
    candidate.value.length <= 4_096 &&
    typeof candidate.expiresAt === "number" && Number.isFinite(candidate.expiresAt) &&
    typeof candidate.generation === "string" && isGeneration(candidate.generation);
}

function isStoredProviderToken(value: unknown): value is StoredProviderToken {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredProviderToken>;
  return candidate.version === encryptionVersion &&
    typeof candidate.ciphertext === "string" && candidate.ciphertext.length > 0 &&
    candidate.ciphertext.length <= 8_192 &&
    typeof candidate.expiresAt === "number" && Number.isFinite(candidate.expiresAt) &&
    typeof candidate.keyId === "string" && candidate.keyId.length > 0 &&
    candidate.keyId.length <= 256;
}

function isEncryptedProviderToken(value: unknown): value is EncryptedProviderToken {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EncryptedProviderToken>;
  return typeof candidate.token === "string" && candidate.token.length > 0 &&
    candidate.token.length <= 4_096 &&
    typeof candidate.generation === "string" && isGeneration(candidate.generation) &&
    typeof candidate.credentialFingerprint === "string" &&
    candidate.credentialFingerprint.length >= 32 &&
    candidate.credentialFingerprint.length <= 128;
}

function isGeneration(value: string): boolean {
  return value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
