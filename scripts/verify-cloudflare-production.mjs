#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaults = Object.freeze({
  apiBaseURL: "https://api.bellwire.app",
  authBaseURL: "https://auth.bellwire.app",
  attempts: 8,
  retryDelayMs: 2_000,
  timeoutMs: 15_000,
});

const usage = `Bellwire Cloudflare production verification

Usage:
  npm run verify:production
  npm run verify:auth:production

Options:
  --auth-only  Verify only Auth health and JWKS before deploying the API Worker.
  --json       Print one machine-readable JSON result.
  --help       Show this message.
`;

export async function verifyAuthProduction(options = {}) {
  const settings = { ...defaults, ...options };
  const health = await getJSON(`${settings.authBaseURL}/health`, settings);
  assert(health.ok === true, "Auth health did not report ok=true");
  assert(health.service === "bellwire-auth", "Auth health returned the wrong service");
  assert(
    health.issuer === settings.authBaseURL,
    `Auth issuer mismatch: expected ${settings.authBaseURL}`,
  );

  const jwks = await getJSON(`${settings.authBaseURL}/api/auth/jwks`, settings);
  assert(Array.isArray(jwks.keys) && jwks.keys.length > 0, "Auth JWKS has no signing keys");
  assert(jwks.keys.every((key) => key.alg === "ES256"), "Auth JWKS contains a non-ES256 key");

  return {
    health: "ok",
    issuer: health.issuer,
    jwksKeyCount: jwks.keys.length,
    jwksAlgorithms: [...new Set(jwks.keys.map((key) => key.alg))],
  };
}

export async function verifyApiProduction(options = {}) {
  const settings = { ...defaults, ...options };
  const health = await getJSON(`${settings.apiBaseURL}/health`, settings);
  assert(health.status === "ok", "API health did not report status=ok");
  assert(health.service === "bellwire-api", "API health returned the wrong service");
  assert(
    health.compatibility?.schemaMigration === "d1-business-0001",
    "API health is not backed by the production D1 schema",
  );

  await expectStatus(`${settings.apiBaseURL}/v1/projects`, 401, {}, settings);
  await expectStatus(
    `${settings.apiBaseURL}/internal/migrations/apple-refresh-tokens`,
    404,
    { method: "POST" },
    settings,
  );

  return {
    health: "ok",
    compatibility: health.compatibility,
    unauthenticatedProjectsStatus: 401,
    legacyMigrationStatus: 404,
  };
}

export async function verifyProduction(options = {}) {
  const auth = await verifyAuthProduction(options);
  const api = await verifyApiProduction(options);
  return { ok: true, auth, api };
}

async function getJSON(url, settings) {
  const response = await requestWithRetry(url, {}, 200, settings);
  const contentType = response.headers.get("content-type") ?? "";
  assert(contentType.includes("application/json"), `${url} did not return JSON`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${url} returned invalid JSON`);
  }
}

async function expectStatus(url, expectedStatus, init, settings) {
  await requestWithRetry(url, init, expectedStatus, settings);
}

async function requestWithRetry(url, init, expectedStatus, settings) {
  const fetchImplementation = settings.fetchImplementation ?? fetch;
  let lastError;
  for (let attempt = 1; attempt <= settings.attempts; attempt += 1) {
    try {
      const response = await fetchImplementation(url, {
        ...init,
        headers: { accept: "application/json", ...init.headers },
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
      if (response.status === expectedStatus) return response;
      lastError = new Error(`${url} returned HTTP ${response.status}; expected ${expectedStatus}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < settings.attempts) await delay(settings.retryDelayMs);
  }
  throw lastError ?? new Error(`${url} verification failed`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.includes("--help")) {
    process.stdout.write(usage);
    return;
  }
  const allowed = new Set(["--auth-only", "--json"]);
  const unknown = argumentsList.find((argument) => !allowed.has(argument));
  if (unknown) throw new Error(`Unknown option: ${unknown}`);

  const result = argumentsList.includes("--auth-only")
    ? { ok: true, auth: await verifyAuthProduction() }
    : await verifyProduction();
  if (argumentsList.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Bellwire production verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
