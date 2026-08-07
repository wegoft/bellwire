// SPDX-License-Identifier: AGPL-3.0-only
import { createApp } from "./app";
import type { BellwireRepository } from "./repositories/bellwire-repository";
import { InMemoryBellwireRepository } from "./repositories/in-memory-bellwire-repository";
import { SupabaseBellwireRepository } from "./repositories/supabase-bellwire-repository";
import { PrincipalAuthenticator } from "./security/authenticator";
import { BellwireService } from "./services/bellwire-service";
import { AppleAuthService, AppleTokenClient } from "./services/apple-auth-service";
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
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  APPLE_SIGN_IN_KEY_ID?: string;
  APPLE_SIGN_IN_TEAM_ID?: string;
  APPLE_SIGN_IN_CLIENT_ID?: string;
  APPLE_SIGN_IN_PRIVATE_KEY?: string;
  APPLE_TOKEN_ENCRYPTION_KEY?: string;
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
    const repository = repositoryForEnv(env);
    const authenticator = new PrincipalAuthenticator(repository, {
      supabaseUrl: env.SUPABASE_URL,
      allowDevelopmentTokens: env.APP_ENV === "development" && !env.SUPABASE_URL,
    });
    const dispatcher = env.DELIVERY_QUEUE
      ? new QueueDeliveryDispatcher(env.DELIVERY_QUEUE)
      : undefined;
    const analytics = createProductAnalytics(env);
    const appleAuthService = createAppleAuthService(env, repository);
    const appleBillingService = createAppleBillingService(env, repository, analytics);
    const app = createApp({
      service: new BellwireService(
        repository,
        dispatcher,
        appleAuthService,
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
    await repositoryForEnv(env).runMaintenance(new Date().toISOString());
  },
};

function repositoryForEnv(env: Env): BellwireRepository {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseBellwireRepository(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }
  if (env.APP_ENV !== "development") {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return developmentRepository;
}

function requiredEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for delivery processing`);
  return value;
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

function createAppleAuthService(
  env: Env,
  repository: BellwireRepository,
): AppleAuthService | undefined {
  const values = [
    env.APPLE_SIGN_IN_KEY_ID,
    env.APPLE_SIGN_IN_TEAM_ID,
    env.APPLE_SIGN_IN_CLIENT_ID,
    env.APPLE_SIGN_IN_PRIVATE_KEY,
  ];
  if (values.every((value) => !value)) return undefined;
  const keyId = requiredEnv(env.APPLE_SIGN_IN_KEY_ID, "APPLE_SIGN_IN_KEY_ID");
  const teamId = requiredEnv(env.APPLE_SIGN_IN_TEAM_ID, "APPLE_SIGN_IN_TEAM_ID");
  const clientId = requiredEnv(env.APPLE_SIGN_IN_CLIENT_ID, "APPLE_SIGN_IN_CLIENT_ID");
  const privateKey = requiredEnv(env.APPLE_SIGN_IN_PRIVATE_KEY, "APPLE_SIGN_IN_PRIVATE_KEY");
  const encryptionKey = requiredEnv(
    env.APPLE_TOKEN_ENCRYPTION_KEY,
    "APPLE_TOKEN_ENCRYPTION_KEY",
  );
  return new AppleAuthService(
    repository,
    new AppleTokenClient({ keyId, teamId, clientId, privateKey }),
    encryptionKey,
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
