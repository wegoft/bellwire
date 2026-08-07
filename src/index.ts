// SPDX-License-Identifier: AGPL-3.0-only
import { createApp } from "./app";
import type { BellwireRepository } from "./repositories/bellwire-repository";
import { D1BellwireRepository } from "./repositories/d1-bellwire-repository";
import { InMemoryBellwireRepository } from "./repositories/in-memory-bellwire-repository";
import { PrincipalAuthenticator } from "./security/authenticator";
import { BellwireService } from "./services/bellwire-service";
import { AuthAdminClient } from "./services/auth-admin-client";
import {
  AppleTokenClient,
  decryptAppleRefreshToken,
  type AppleOAuthClient,
} from "./services/apple-auth-service";
import {
  AppleBillingService,
  OfficialAppleBillingVerifier,
} from "./services/apple-billing-service";
import { ApnsClientPool } from "./services/apns-client";
import { DurableObjectApnsProviderTokenSource } from "./services/apns-provider-token-authority";
import { DeliveryProcessor } from "./services/delivery-processor";
import { ModeRequestNotificationProcessor } from "./services/mode-request-notification-processor";
import { LiveActivityProcessor } from "./services/live-activity-processor";
import { PrivateWakeProcessor } from "./services/private-wake-processor";
import {
  PostHogProductAnalytics,
  type ProductAnalytics,
} from "./services/product-analytics";
import {
  QueueDeliveryDispatcher,
  type DeliveryQueueMessage,
} from "./services/delivery-dispatcher";

export interface Env {
  APP_ENV: "development" | "staging" | "production";
  DB?: D1Database;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  AUTH_INTERNAL_SECRET?: string;
  AUTH_SERVICE?: Fetcher;
  LEGACY_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  APPLE_TOKEN_ENCRYPTION_KEY?: string;
  APPLE_TOKEN_REWRAP_SECRET?: string;
  APPLE_SIGN_IN_KEY_ID?: string;
  APPLE_SIGN_IN_TEAM_ID?: string;
  APPLE_SIGN_IN_CLIENT_ID?: string;
  APPLE_SIGN_IN_PRIVATE_KEY?: string;
  CUTOVER_WRITE_FREEZE?: "true" | "false";
  APPLE_ROOT_CERTIFICATES_BASE64?: string;
  APPLE_APP_ID?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_BUNDLE_ID?: string;
  APP_URL_SCHEME?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_ENVIRONMENT?: "sandbox" | "production";
  ENTITLEMENT_ENFORCEMENT_MODE?: "disabled" | "shadow" | "enforce";
  LIVE_ACTIVITY_AUTOMATION_ENABLED?: "true" | "false";
  POSTHOG_PROJECT_KEY?: string;
  POSTHOG_HOST?: string;
  DELIVERY_QUEUE?: Queue<DeliveryQueueMessage>;
  APNS_PROVIDER_TOKEN_AUTHORITY?: DurableObjectNamespace;
}

const developmentRepository = new InMemoryBellwireRepository();
const apnsClients = new ApnsClientPool();
let apnsProviderTokens: DurableObjectApnsProviderTokenSource | undefined;

export { ApnsProviderTokenAuthority } from "./services/apns-provider-token-authority";

export default {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST"
      && url.pathname === "/internal/migrations/apple-refresh-tokens"
    ) {
      return migrateLegacyAppleRefreshTokens(request, env);
    }
    if (
      request.method === "POST"
      && url.pathname.startsWith("/internal/auth/apple/")
    ) {
      return handleAppleAuthInternal(request, env);
    }
    if (env.CUTOVER_WRITE_FREEZE === "true" && url.pathname !== "/health") {
      return cutoverWriteFreezeResponse();
    }
    if (env.DB && request.method === "GET" && url.pathname === "/health") {
      const health = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      if (health?.ok !== 1) throw new Error("D1 health check failed");
    }
    const repository = repositoryForEnv(env);
    const authAudience = env.AUTH_ISSUER
      ? requiredEnv(env.AUTH_AUDIENCE, "AUTH_AUDIENCE")
      : undefined;
    const authenticator = new PrincipalAuthenticator(repository, {
      issuer: env.AUTH_ISSUER,
      audience: authAudience,
      allowDevelopmentTokens: env.APP_ENV === "development" && !env.AUTH_ISSUER,
      authService: env.AUTH_SERVICE,
    });
    const dispatcher = env.DELIVERY_QUEUE
      ? new QueueDeliveryDispatcher(env.DELIVERY_QUEUE)
      : undefined;
    const analytics = createProductAnalytics(env);
    const accountIdentityService = createAccountIdentityService(env);
    const appleBillingService = createAppleBillingService(env, repository, analytics);
    const app = createApp({
      service: new BellwireService(
        repository,
        dispatcher,
        accountIdentityService,
        env.ENTITLEMENT_ENFORCEMENT_MODE ?? "shadow",
        analytics,
        env.LIVE_ACTIVITY_AUTOMATION_ENABLED === "true",
      ),
      authenticator,
      appleBillingService,
    });
    return app.fetch(request, env, executionContext);
  },

  async queue(batch: MessageBatch<DeliveryQueueMessage>, env: Env): Promise<void> {
    if (env.CUTOVER_WRITE_FREEZE === "true") {
      for (const message of batch.messages) message.retry({ delaySeconds: 300 });
      return;
    }
    const repository = repositoryForEnv(env);
    const providerTokens = providerTokenSourceForEnv(env);
    const apnsForEnvironment = (environment: "sandbox" | "production") => apnsClients.get({
      bundleId: requiredEnv(env.APNS_BUNDLE_ID, "APNS_BUNDLE_ID"),
      urlScheme: env.APP_URL_SCHEME ?? "bellwire",
      environment,
    }, providerTokens);
    const processor = new DeliveryProcessor(repository, apnsForEnvironment);
    const privateWakeProcessor = new PrivateWakeProcessor(repository, apnsForEnvironment);
    const modeRequestProcessor = new ModeRequestNotificationProcessor(repository, apnsForEnvironment);
    const liveActivityProcessor = new LiveActivityProcessor(repository, apnsForEnvironment);
    await Promise.all(
      batch.messages.map(async (message) => {
        try {
          if (message.body.kind === "private_wake") {
            await privateWakeProcessor.process(message.body.wakeId);
          } else if (message.body.kind === "mode_request") {
            await modeRequestProcessor.process(message.body.requestId, message.body.userId);
          } else if (message.body.kind === "live_activity_surface") {
            if (env.LIVE_ACTIVITY_AUTOMATION_ENABLED === "true") {
              await liveActivityProcessor.process(message.body.surfaceId, message.body.userId);
            }
          } else {
            await processor.process(message.body.eventId);
          }
          message.ack();
        } catch (error) {
          console.error(
            "Delivery processing failed",
            error instanceof Error ? error.message : "Unknown error",
          );
          message.retry({ delaySeconds: Math.min(60 * 2 ** message.attempts, 900) });
        }
      }),
    );
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (env.CUTOVER_WRITE_FREEZE === "true") return;
    await repositoryForEnv(env).runMaintenance(new Date().toISOString());
  },
};

function cutoverWriteFreezeResponse(): Response {
  return Response.json({
    error: {
      code: "CUTOVER_WRITE_FREEZE",
      message: "Bellwire is completing a scheduled storage migration. Please retry shortly.",
    },
  }, {
    status: 503,
    headers: { "cache-control": "no-store", "retry-after": "120" },
  });
}

type AppleOAuthOperator = AppleOAuthClient & { createClientSecret(): Promise<string> };

export async function handleAppleAuthInternal(
  request: Request,
  env: Env,
  oauthClient?: AppleOAuthOperator,
): Promise<Response> {
  const internalSecret = requiredMigrationEnv(env.AUTH_INTERNAL_SECRET, "AUTH_INTERNAL_SECRET");
  if (!await secretsMatch(readBearer(request.headers.get("authorization")), internalSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const client = oauthClient ?? new AppleTokenClient({
    keyId: requiredMigrationEnv(env.APPLE_SIGN_IN_KEY_ID, "APPLE_SIGN_IN_KEY_ID"),
    teamId: requiredMigrationEnv(env.APPLE_SIGN_IN_TEAM_ID, "APPLE_SIGN_IN_TEAM_ID"),
    clientId: requiredMigrationEnv(env.APPLE_SIGN_IN_CLIENT_ID, "APPLE_SIGN_IN_CLIENT_ID"),
    privateKey: requiredMigrationEnv(
      env.APPLE_SIGN_IN_PRIVATE_KEY,
      "APPLE_SIGN_IN_PRIVATE_KEY",
    ),
  });
  const path = new URL(request.url).pathname;
  if (path === "/internal/auth/apple/client-secret") {
    return Response.json({ clientSecret: await client.createClientSecret() }, {
      headers: { "cache-control": "no-store" },
    });
  }
  const body: Record<string, unknown> = await request.json<Record<string, unknown>>()
    .catch(() => ({}));
  if (path === "/internal/auth/apple/exchange") {
    const authorizationCode = nonEmptyString(body.authorizationCode);
    if (!authorizationCode) return Response.json({ error: "invalid request" }, { status: 400 });
    return Response.json({
      refreshToken: await client.exchangeAuthorizationCode(authorizationCode),
    }, { headers: { "cache-control": "no-store" } });
  }
  if (path === "/internal/auth/apple/revoke") {
    const refreshToken = nonEmptyString(body.refreshToken);
    if (!refreshToken) return Response.json({ error: "invalid request" }, { status: 400 });
    await client.revokeRefreshToken(refreshToken);
    return new Response(null, { status: 204 });
  }
  return new Response("Not Found", { status: 404 });
}

interface LegacyAppleRefreshTokenRow {
  user_id?: unknown;
  refresh_token_ciphertext?: unknown;
}

export async function migrateLegacyAppleRefreshTokens(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<Response> {
  const migrationSecret = env.APPLE_TOKEN_REWRAP_SECRET?.trim();
  if (!migrationSecret) return new Response("Not Found", { status: 404 });
  if (!await secretsMatch(readBearer(request.headers.get("authorization")), migrationSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabaseUrl = requiredMigrationEnv(env.LEGACY_SUPABASE_URL, "LEGACY_SUPABASE_URL")
    .replace(/\/$/u, "");
  const serviceRoleKey = requiredMigrationEnv(
    env.SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const sourceEncryptionKey = requiredMigrationEnv(
    env.APPLE_TOKEN_ENCRYPTION_KEY,
    "APPLE_TOKEN_ENCRYPTION_KEY",
  );
  const authService = env.AUTH_SERVICE;
  if (!authService) throw new Error("AUTH_SERVICE is required for Apple token migration");

  const sourceResponse = await fetchImpl(
    `${supabaseUrl}/rest/v1/apple_auth_tokens?select=user_id,refresh_token_ciphertext&order=user_id.asc`,
    {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );
  if (!sourceResponse.ok) {
    throw new Error(`Legacy Apple token read failed with status ${sourceResponse.status}`);
  }
  const rows = await sourceResponse.json<unknown>();
  if (!Array.isArray(rows) || rows.length > 100) {
    throw new Error("Legacy Apple token source returned an invalid payload");
  }
  const tokens = await Promise.all(rows.map(async (candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Legacy Apple token source returned an invalid row");
    }
    const row = candidate as LegacyAppleRefreshTokenRow;
    if (
      typeof row.user_id !== "string" || !row.user_id
      || typeof row.refresh_token_ciphertext !== "string" || !row.refresh_token_ciphertext
    ) {
      throw new Error("Legacy Apple token source returned an incomplete row");
    }
    return {
      userId: row.user_id,
      refreshToken: await decryptAppleRefreshToken(
        row.refresh_token_ciphertext,
        sourceEncryptionKey,
      ),
    };
  }));

  const authResponse = await authService.fetch(new Request(
    new URL(
      "/internal/migrations/apple-refresh-tokens",
      requiredMigrationEnv(env.AUTH_ISSUER, "AUTH_ISSUER"),
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${migrationSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tokens }),
    },
  ));
  const result = await authResponse.json<{ migrated?: unknown; verified?: unknown }>()
    .catch(() => null);
  if (
    !authResponse.ok
    || result?.migrated !== tokens.length
    || result.verified !== tokens.length
  ) {
    throw new Error(`Auth Apple token migration failed with status ${authResponse.status}`);
  }
  return Response.json({ source: rows.length, migrated: result.migrated, verified: result.verified });
}

function repositoryForEnv(env: Env): BellwireRepository {
  if (env.DB) return new D1BellwireRepository(env.DB);
  if (env.APP_ENV !== "development") {
    throw new Error("DB is required outside development");
  }
  return developmentRepository;
}

function requiredEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for delivery processing`);
  return value;
}

function requiredMigrationEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for Apple token migration`);
  return value;
}

function readBearer(value: string | null): string {
  if (!value?.toLowerCase().startsWith("bearer ")) return "";
  return value.slice(7).trim();
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

async function secretsMatch(left: string, right: string): Promise<boolean> {
  if (!left || !right) return false;
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function providerTokenSourceForEnv(env: Env): DurableObjectApnsProviderTokenSource {
  if (apnsProviderTokens) return apnsProviderTokens;
  if (!env.APNS_PROVIDER_TOKEN_AUTHORITY) {
    throw new Error("APNS_PROVIDER_TOKEN_AUTHORITY is required for delivery processing");
  }
  apnsProviderTokens = new DurableObjectApnsProviderTokenSource(
    env.APNS_PROVIDER_TOKEN_AUTHORITY,
  );
  return apnsProviderTokens;
}

function createAccountIdentityService(env: Env): AuthAdminClient | undefined {
  if (!env.AUTH_ISSUER && !env.AUTH_INTERNAL_SECRET && !env.AUTH_SERVICE) return undefined;
  return new AuthAdminClient(
    requiredEnv(env.AUTH_ISSUER, "AUTH_ISSUER"),
    requiredEnv(env.AUTH_INTERNAL_SECRET, "AUTH_INTERNAL_SECRET"),
    env.AUTH_SERVICE,
  );
}

function createAppleBillingService(
  env: Env,
  repository: BellwireRepository,
  analytics?: ProductAnalytics,
): AppleBillingService | undefined {
  if (!env.APPLE_ROOT_CERTIFICATES_BASE64 && !env.APPLE_APP_ID) return undefined;
  const rootsRaw = requiredEnv(
    env.APPLE_ROOT_CERTIFICATES_BASE64,
    "APPLE_ROOT_CERTIFICATES_BASE64",
  );
  let rootCertificatesBase64: string[];
  try {
    const decoded: unknown = JSON.parse(rootsRaw);
    if (
      !Array.isArray(decoded) ||
      decoded.length === 0 ||
      decoded.some((value) => typeof value !== "string" || value.length < 100)
    ) {
      throw new Error("invalid certificates");
    }
    rootCertificatesBase64 = decoded;
  } catch {
    throw new Error("APPLE_ROOT_CERTIFICATES_BASE64 must be a JSON string array");
  }
  const appAppleId = Number(requiredEnv(env.APPLE_APP_ID, "APPLE_APP_ID"));
  if (!Number.isSafeInteger(appAppleId) || appAppleId <= 0) {
    throw new Error("APPLE_APP_ID must be a positive integer");
  }
  const verifier = new OfficialAppleBillingVerifier({
    rootCertificatesBase64,
    bundleId: env.APNS_BUNDLE_ID ?? "app.bellwire",
    appAppleId,
  });
  return new AppleBillingService(repository, verifier, undefined, analytics);
}

function createProductAnalytics(env: Env): ProductAnalytics | undefined {
  const key = env.POSTHOG_PROJECT_KEY?.trim();
  if (!key) return undefined;
  return new PostHogProductAnalytics(key, env.POSTHOG_HOST);
}
