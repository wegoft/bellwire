// SPDX-License-Identifier: AGPL-3.0-only
import { exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import worker, { type Env } from "../src/index";

describe("internal Apple authentication", () => {
  it("keeps the Apple private key in API while issuing a client secret internally", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const env = {
      APP_ENV: "production",
      AUTH_INTERNAL_SECRET: "internal-secret",
      APPLE_SIGN_IN_KEY_ID: "KEY123",
      APPLE_SIGN_IN_TEAM_ID: "TEAM123456",
      APPLE_SIGN_IN_CLIENT_ID: "app.bellwire",
      APPLE_SIGN_IN_PRIVATE_KEY: await exportPKCS8(privateKey),
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
});

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}
