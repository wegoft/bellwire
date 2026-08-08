// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  verifyApiProduction,
  verifyAuthProduction,
  verifyProduction,
} from "../scripts/verify-cloudflare-production.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("Cloudflare production verification", () => {
  it("accepts the expected Auth, JWKS, API, authorization, and migration boundaries", async () => {
    const fetchImplementation = routeFetch({
      "GET https://auth.example/health": json(200, {
        ok: true,
        service: "bellwire-auth",
        issuer: "https://auth.example",
      }),
      "GET https://auth.example/api/auth/jwks": json(200, {
        keys: [{ alg: "ES256", kid: "current" }],
      }),
      "GET https://api.example/health": json(200, {
        status: "ok",
        service: "bellwire-api",
        compatibility: {
          appVersion: "1.0.1",
          apiVersion: "v1",
          schemaMigration: "d1-business-0001",
        },
      }),
      "GET https://api.example/v1/projects": json(401, { error: "unauthorized" }),
      "POST https://api.example/internal/migrations/apple-refresh-tokens": json(404, {
        error: "not found",
      }),
    });

    await expect(verifyProduction(settings(fetchImplementation))).resolves.toMatchObject({
      ok: true,
      auth: { health: "ok", jwksAlgorithms: ["ES256"] },
      api: {
        health: "ok",
        unauthenticatedProjectsStatus: 401,
        legacyMigrationStatus: 404,
      },
    });
  });

  it("fails closed when Auth publishes an unexpected signing algorithm", async () => {
    const fetchImplementation = routeFetch({
      "GET https://auth.example/health": json(200, {
        ok: true,
        service: "bellwire-auth",
        issuer: "https://auth.example",
      }),
      "GET https://auth.example/api/auth/jwks": json(200, {
        keys: [{ alg: "HS256" }],
      }),
    });

    await expect(verifyAuthProduction(settings(fetchImplementation))).rejects.toThrow("non-ES256");
  });

  it("fails closed when an unauthenticated business read becomes accessible", async () => {
    const fetchImplementation = routeFetch({
      "GET https://api.example/health": json(200, {
        status: "ok",
        service: "bellwire-api",
        compatibility: { schemaMigration: "d1-business-0001" },
      }),
      "GET https://api.example/v1/projects": json(200, []),
    });

    await expect(verifyApiProduction(settings(fetchImplementation))).rejects.toThrow(
      "returned HTTP 200; expected 401",
    );
  });

  it("keeps the production workflow ordered and free of Supabase runtime dependencies", () => {
    const workflow = read(".github/workflows/deploy-production.yml");
    const authConfig = read("wrangler.auth.production.toml");
    const apiConfig = read("wrangler.production.toml");

    const orderedSteps = [
      "Apply Auth D1 migrations",
      "Deploy Auth Worker",
      "Verify Auth production boundary",
      "Apply business D1 migrations",
      "Deploy API Worker",
      "Verify complete production boundary",
    ];
    const positions = orderedSteps.map((step) => workflow.indexOf(step));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("Roll back deployed Worker versions after failure");
    expect(`${authConfig}\n${apiConfig}`).not.toMatch(/SUPABASE|LEGACY_SUPABASE|REWRAP/u);
  });
});

function settings(fetchImplementation) {
  return {
    apiBaseURL: "https://api.example",
    authBaseURL: "https://auth.example",
    attempts: 1,
    retryDelayMs: 0,
    timeoutMs: 1_000,
    fetchImplementation,
  };
}

function routeFetch(routes) {
  return async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    const response = routes[key];
    if (!response) throw new Error(`Unexpected request: ${key}`);
    return response.clone();
  };
}

function json(status, body) {
  return new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function read(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}
