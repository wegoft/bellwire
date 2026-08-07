// SPDX-License-Identifier: AGPL-3.0-only
import { exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import { InMemoryBellwireRepository } from "../src/repositories/in-memory-bellwire-repository";
import {
  AppleAuthService,
  AppleTokenClient,
  type AppleOAuthClient,
} from "../src/services/apple-auth-service";
const userId = "user-one";

class CapturingAppleClient implements AppleOAuthClient {
  readonly authorizationCodes: string[] = [];
  readonly revokedTokens: string[] = [];

  async exchangeAuthorizationCode(authorizationCode: string): Promise<string> {
    this.authorizationCodes.push(authorizationCode);
    return "apple-refresh-token";
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    this.revokedTokens.push(refreshToken);
  }
}

describe("Apple authentication lifecycle", () => {
  it("exchanges, encrypts, stores, and revokes the Apple refresh token before account deletion", async () => {
    const repository = new InMemoryBellwireRepository();
    const appleClient = new CapturingAppleClient();
    const encryptionKey = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const appleAuth = new AppleAuthService(repository, appleClient, encryptionKey);
    await appleAuth.saveAuthorizationCode(userId, "one-time-code");

    expect(appleClient.authorizationCodes).toEqual(["one-time-code"]);
    const stored = await repository.getAppleRefreshToken(userId);
    expect(stored).toMatch(/^v1\./u);
    expect(stored).not.toContain("apple-refresh-token");

    await appleAuth.revokeForUser(userId);
    await repository.deleteAccount(userId);

    expect(appleClient.revokedTokens).toEqual(["apple-refresh-token"]);
    expect(await repository.getAppleRefreshToken(userId)).toBeUndefined();
  });

  it("uses Apple's token and revocation endpoints with a signed client secret", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const requests: Request[] = [];
    const client = new AppleTokenClient(
      {
        keyId: "KEY123",
        teamId: "TEAM123",
        clientId: "app.bellwire",
        privateKey: await exportPKCS8(privateKey),
      },
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return request.url.endsWith("/token")
          ? Response.json({ refresh_token: "refresh-from-apple" })
          : new Response(null, { status: 200 });
      },
    );

    expect(await client.exchangeAuthorizationCode("authorization-code")).toBe("refresh-from-apple");
    await client.revokeRefreshToken("refresh-from-apple");

    expect(requests.map((request) => request.url)).toEqual([
      "https://appleid.apple.com/auth/token",
      "https://appleid.apple.com/auth/revoke",
    ]);
    const exchangeBody = new URLSearchParams(await requests[0]!.text());
    expect(exchangeBody.get("grant_type")).toBe("authorization_code");
    expect(exchangeBody.get("code")).toBe("authorization-code");
    expect(exchangeBody.get("client_id")).toBe("app.bellwire");
    expect(exchangeBody.get("client_secret")?.split(".")).toHaveLength(3);
    const revokeBody = new URLSearchParams(await requests[1]!.text());
    expect(revokeBody.get("token")).toBe("refresh-from-apple");
    expect(revokeBody.get("token_type_hint")).toBe("refresh_token");
  });
});

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}
