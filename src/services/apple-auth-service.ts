// SPDX-License-Identifier: AGPL-3.0-only
import { SignJWT, importPKCS8 } from "jose";

export interface AppleRefreshTokenStore {
  saveAppleRefreshToken(userId: string, encryptedRefreshToken: string): Promise<void>;
  getAppleRefreshToken(userId: string): Promise<string | undefined>;
  deleteAppleRefreshToken(userId: string): Promise<void>;
}

export interface AppleOAuthClient {
  exchangeAuthorizationCode(authorizationCode: string): Promise<string>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
}

export interface AppleOAuthClientConfig {
  keyId: string;
  teamId: string;
  clientId: string;
  privateKey: string;
}

export class AppleOAuthError extends Error {
  constructor(readonly operation: "exchange" | "revoke", readonly status: number) {
    super(`Apple token ${operation} failed with status ${status}`);
    this.name = "AppleOAuthError";
  }
}

export class AppleTokenClient implements AppleOAuthClient {
  constructor(
    private readonly config: AppleOAuthClientConfig,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async exchangeAuthorizationCode(authorizationCode: string): Promise<string> {
    const response = await this.appleRequest("https://appleid.apple.com/auth/token", {
      grant_type: "authorization_code",
      code: authorizationCode,
    });
    const body = await response.json<unknown>();
    const refreshToken = readRefreshToken(body);
    if (!refreshToken) throw new AppleOAuthError("exchange", response.status);
    return refreshToken;
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    await this.appleRequest("https://appleid.apple.com/auth/revoke", {
      token: refreshToken,
      token_type_hint: "refresh_token",
    });
  }

  private async appleRequest(url: string, values: Record<string, string>): Promise<Response> {
    const body = new URLSearchParams({
      ...values,
      client_id: this.config.clientId,
      client_secret: await this.createClientSecret(),
    });
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new AppleOAuthError(url.endsWith("/revoke") ? "revoke" : "exchange", response.status);
    }
    return response;
  }

  async createClientSecret(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const key = await importPKCS8(this.config.privateKey, "ES256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setSubject(this.config.clientId)
      .setAudience("https://appleid.apple.com")
      .setIssuedAt(now)
      .setExpirationTime(now + 60 * 60 * 24 * 180)
      .sign(key);
  }
}

export class AppleAuthService {
  constructor(
    private readonly repository: AppleRefreshTokenStore,
    private readonly oauthClient: AppleOAuthClient,
    private readonly encryptionKey: string,
  ) {}

  async saveAuthorizationCode(userId: string, authorizationCode: string): Promise<void> {
    const refreshToken = await this.oauthClient.exchangeAuthorizationCode(authorizationCode);
    const encrypted = await encrypt(refreshToken, this.encryptionKey);
    await this.repository.saveAppleRefreshToken(userId, encrypted);
  }

  async revokeForUser(userId: string): Promise<void> {
    const encrypted = await this.repository.getAppleRefreshToken(userId);
    if (!encrypted) return;
    const refreshToken = await decrypt(encrypted, this.encryptionKey);
    await this.oauthClient.revokeRefreshToken(refreshToken);
    await this.repository.deleteAppleRefreshToken(userId);
  }
}

async function encrypt(value: string, keyValue: string): Promise<string> {
  const key = await importEncryptionKey(keyValue, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value),
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decrypt(value: string, keyValue: string): Promise<string> {
  const [version, ivValue, ciphertextValue] = value.split(".");
  if (version !== "v1" || !ivValue || !ciphertextValue) {
    throw new Error("Invalid Apple refresh token ciphertext");
  }
  const key = await importEncryptionKey(keyValue, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivValue) },
    key,
    fromBase64Url(ciphertextValue),
  );
  return new TextDecoder().decode(plaintext);
}

async function importEncryptionKey(
  value: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const bytes = fromBase64Url(value.trim().replace(/\+/gu, "-").replace(/\//gu, "_"));
  if (bytes.byteLength !== 32) throw new Error("APPLE_TOKEN_ENCRYPTION_KEY must contain 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages);
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

function readRefreshToken(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const token = (value as Record<string, unknown>).refresh_token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}
