// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";

import { compatibility } from "./compatibility";
import type { AgentScope, Principal } from "./domain/models";
import { AuthenticationError, requireScope, type Authenticator } from "./security/authenticator";
import {
  ServiceError,
  type BellwireService,
  type CreateEventSchemaInput,
  type IngestEventInput,
} from "./services/bellwire-service";
import {
  AppleBillingVerificationError,
  type AppleBillingService,
} from "./services/apple-billing-service";

export function createApp(dependencies: {
  service: BellwireService;
  authenticator: Authenticator;
  appleBillingService?: AppleBillingService;
}) {
  const app = new Hono();

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "bellwire-api", compatibility }),
  );

  app.post("/v1/device-bindings", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.createDeviceBinding(
        principal,
        await readOptionalJson(context.req.raw),
      ),
      201,
    );
  });

  app.post("/v1/device-bindings/confirm", async (context) =>
    context.json(
      await dependencies.service.confirmDeviceBinding(
        await readJson(context.req.raw),
        context.req.header("cf-connecting-ip") ?? "unknown",
      ),
      201,
    ),
  );

  app.get("/v1/agent-connections", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(await dependencies.service.listAgentConnections(principal));
  });

  app.delete("/v1/agent-connections/:connectionId", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    await dependencies.service.revokeAgentConnection(
      principal,
      context.req.param("connectionId"),
    );
    return context.body(null, 204);
  });

  app.post("/v1/direct-connections", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.createDirectConnectionEnvelope(
        principal,
        await readJson(context.req.raw),
      ),
      201,
    );
  });

  app.get("/v1/direct-connections", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.listDirectConnectionEnvelopes(
        principal,
        readQueryString(context, "deviceKeyId") ?? "",
      ),
    );
  });

  app.post("/v1/direct-connections/:envelopeId/ack", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.acknowledgeDirectConnectionEnvelope(
        principal,
        context.req.param("envelopeId"),
        await readJson(context.req.raw),
      ),
    );
  });

  app.post("/v1/projects/:projectId/direct-connection-recovery", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.requestDirectConnectionRecovery(
        principal,
        context.req.param("projectId"),
        await readLimitedJson(context.req.raw, 2_048),
      ),
      202,
    );
  });

  app.get("/v1/direct-connection-recoveries", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "config:read");
    return context.json(
      await dependencies.service.listDirectConnectionRecoveryRequests(principal),
    );
  });

  app.post("/v1/device-keys", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.registerDeviceKey(
        principal,
        await readLimitedJson(context.req.raw, 2_048),
      ),
      201,
    );
  });

  app.post("/v1/devices", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.registerDevice(principal, await readJson(context.req.raw)),
      201,
    );
  });

  app.get("/v1/devices", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(await dependencies.service.listDevices(principal));
  });

  app.put("/v1/devices/live-activity-capability", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.registerDeviceLiveActivityCapability(
        principal,
        await readLimitedJson(context.req.raw, 4_096),
      ),
    );
  });

  app.put("/v1/live-activities/:activityId", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.registerLiveActivity(
        principal,
        context.req.param("activityId"),
        await readLimitedJson(context.req.raw, 4_096),
      ),
    );
  });

  app.delete("/v1/live-activities/:activityId", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    await dependencies.service.deleteLiveActivityRegistration(
      principal,
      context.req.param("activityId"),
    );
    return context.body(null, 204);
  });

  app.get("/v1/account/entitlement", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(await dependencies.service.getAccountEntitlement(principal));
  });

  app.post("/v1/analytics/events", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    await dependencies.service.captureProductEvent(
      principal,
      await readLimitedJson(context.req.raw, 2_048),
    );
    return context.body(null, 204);
  });

  app.post("/v1/billing/apple/transactions", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    const billing = requireAppleBillingService(dependencies.appleBillingService);
    const body = asJsonRecord(await readLimitedJson(context.req.raw, 100_000));
    try {
      return context.json(
        await billing.submitTransaction(
          principal,
          body.signedTransactionInfo,
          body.source,
        ),
      );
    } catch (error) {
      throw purchaseError(error);
    }
  });

  app.post("/v1/billing/apple/notifications", async (context) => {
    const billing = requireAppleBillingService(dependencies.appleBillingService);
    const body = asJsonRecord(await readLimitedJson(context.req.raw, 100_000));
    try {
      return context.json(
        await billing.processNotification(body.signedPayload),
      );
    } catch (error) {
      throw purchaseError(error);
    }
  });

  app.delete("/v1/devices/:deviceId", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    await dependencies.service.deleteDevice(principal, context.req.param("deviceId"));
    return context.body(null, 204);
  });

  app.delete("/v1/account", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    await dependencies.service.deleteAccount(principal);
    return context.body(null, 204);
  });

  app.post("/v1/demo", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    const result = await dependencies.service.createDemoExperience(principal);
    return context.json(result, result.created ? 201 : 200);
  });

  app.post("/v1/projects", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:write");
    const project = await dependencies.service.createProject(principal, await readJson(context.req.raw));
    return context.json(project, 201);
  });

  app.get("/v1/projects", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:read");
    return context.json(await dependencies.service.listProjects(principal));
  });

  app.get("/v1/projects/:projectId", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:read");
    return context.json(
      await dependencies.service.getProjectOverview(principal, context.req.param("projectId")),
    );
  });

  app.patch("/v1/projects/:projectId", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:write");
    return context.json(
      await dependencies.service.updateProject(
        principal,
        context.req.param("projectId"),
        (await readJson(context.req.raw)) as Record<string, unknown>,
      ),
    );
  });

  app.patch("/v1/projects/:projectId/order", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:write");
    return context.json(
      await dependencies.service.updateProjectDisplayOrder(
        principal,
        context.req.param("projectId"),
        await readJson(context.req.raw),
      ),
    );
  });

  app.delete("/v1/projects/:projectId", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:write");
    await dependencies.service.deleteProject(principal, context.req.param("projectId"));
    return context.body(null, 204);
  });

  app.post("/v1/projects/:projectId/delivery-mode-requests", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:write");
    return context.json(
      await dependencies.service.createDeliveryModeChangeRequest(
        principal,
        context.req.param("projectId"),
        await readJson(context.req.raw),
      ),
      201,
    );
  });

  app.get("/v1/delivery-mode-requests", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.listDeliveryModeChangeRequests(
        principal,
        readQueryString(context, "status"),
      ),
    );
  });

  app.post("/v1/delivery-mode-requests/:requestId/approve", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.resolveDeliveryModeChangeRequest(
        principal,
        context.req.param("requestId"),
        true,
      ),
    );
  });

  app.post("/v1/delivery-mode-requests/:requestId/reject", async (context) => {
    const principal = await authenticate(context, dependencies.authenticator);
    return context.json(
      await dependencies.service.resolveDeliveryModeChangeRequest(
        principal,
        context.req.param("requestId"),
        false,
      ),
    );
  });

  app.post("/v1/projects/:projectId/event-schemas", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "config:write");
    const schema = await dependencies.service.createEventSchema(
      principal,
      context.req.param("projectId"),
      (await readJson(context.req.raw)) as CreateEventSchemaInput,
    );
    return context.json(schema, 201);
  });

  app.post("/v1/projects/:projectId/notification-surfaces", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "config:write");
    return context.json(
      await dependencies.service.createNotificationSurface(
        principal,
        context.req.param("projectId"),
        (await readJson(context.req.raw)) as Record<string, unknown>,
      ),
      201,
    );
  });

  app.get("/v1/surfaces", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "config:read");
    return context.json(await dependencies.service.listLiveSurfaces(principal));
  });

  app.get("/v1/projects/:projectId/surfaces", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "config:read");
    return context.json(
      await dependencies.service.listLiveSurfaces(principal, context.req.param("projectId")),
    );
  });

  app.put("/v1/projects/:projectId/surfaces/:surfaceKey", async (context) => {
    const authorization = context.req.header("authorization");
    if (/^Bearer\s+bw_live_/iu.test(authorization ?? "")) {
      return context.json(
        await dependencies.service.upsertLiveSurfaceFromIngestToken(
          context.req.param("projectId"),
          authorization,
          context.req.param("surfaceKey"),
          await readLimitedJson(context.req.raw, 32_768),
        ),
      );
    }
    const principal = await scopedPrincipal(context, dependencies.authenticator, "config:write");
    return context.json(
      await dependencies.service.upsertLiveSurface(
        principal,
        context.req.param("projectId"),
        context.req.param("surfaceKey"),
        await readLimitedJson(context.req.raw, 32_768),
      ),
    );
  });

  app.patch("/v1/projects/:projectId/surfaces/:surfaceKey/order", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "config:write");
    return context.json(
      await dependencies.service.updateLiveSurfaceDisplayOrder(
        principal,
        context.req.param("projectId"),
        context.req.param("surfaceKey"),
        await readJson(context.req.raw),
      ),
    );
  });

  app.delete("/v1/projects/:projectId/surfaces/:surfaceKey", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "config:write");
    await dependencies.service.deleteLiveSurface(
      principal,
      context.req.param("projectId"),
      context.req.param("surfaceKey"),
    );
    return context.body(null, 204);
  });

  app.post("/v1/projects/:projectId/ingest-tokens", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:write");
    const token = await dependencies.service.createIngestToken(
      principal,
      context.req.param("projectId"),
      await readJson(context.req.raw),
    );
    return context.json(token, 201);
  });

  app.delete("/v1/projects/:projectId/ingest-tokens/:tokenId", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:write");
    await dependencies.service.revokeIngestToken(
      principal,
      context.req.param("projectId"),
      context.req.param("tokenId"),
    );
    return context.body(null, 204);
  });

  app.post("/v1/projects/:projectId/wake-tokens", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:write");
    return context.json(
      await dependencies.service.createPrivateWakeToken(
        principal,
        context.req.param("projectId"),
        await readJson(context.req.raw),
      ),
      201,
    );
  });

  app.delete("/v1/projects/:projectId/wake-tokens/:tokenId", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:write");
    await dependencies.service.revokePrivateWakeToken(
      principal,
      context.req.param("projectId"),
      context.req.param("tokenId"),
    );
    return context.body(null, 204);
  });

  app.post("/v1/projects/:projectId/private-wakes", async (context) => {
    const accepted = await dependencies.service.ingestPrivateWake(
      context.req.param("projectId"),
      context.req.header("authorization"),
      context.req.header("idempotency-key"),
      await readLimitedJson(context.req.raw, 512, 2_048),
    );
    setUsageHeaders(context, accepted.usage);
    return context.json(accepted, accepted.deduplicated ? 200 : 201);
  });

  app.post("/v1/events/:projectId", async (context) => {
    const accepted = await dependencies.service.ingestEvent(
      context.req.param("projectId"),
      context.req.header("authorization"),
      context.req.header("idempotency-key"),
      (await readLimitedJson(context.req.raw, 16_384)) as IngestEventInput,
    );
    if (accepted.usage) setUsageHeaders(context, accepted.usage);
    return context.json(accepted, accepted.deduplicated ? 200 : 201);
  });

  app.post("/v1/projects/:projectId/events/test", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "event:test");
    return context.json(
      await dependencies.service.sendTestEvent(
        principal,
        context.req.param("projectId"),
        (await readLimitedJson(context.req.raw, 16_384)) as IngestEventInput,
      ),
      201,
    );
  });

  app.get("/v1/projects/:projectId/events", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:read");
    return context.json(
      await dependencies.service.listEvents(principal, context.req.param("projectId"), {
        cursor: readQueryString(context, "cursor"),
        eventType: readQueryString(context, "eventType"),
        limit: readLimit(context),
        unreadOnly: context.req.query("unread") === "true",
      }),
    );
  });

  app.get("/v1/inbox", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:read");
    return context.json(
      await dependencies.service.listInbox(principal, {
        limit: readLimit(context),
        unreadOnly: context.req.query("unread") === "true",
      }),
    );
  });

  app.get("/v1/events/:eventId", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:read");
    return context.json(
      await dependencies.service.getEventDetail(principal, context.req.param("eventId")),
    );
  });

  app.post("/v1/inbox/read-all", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:read");
    return context.json(await dependencies.service.markAllEventsRead(principal));
  });

  app.post("/v1/events/:eventId/read", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:read");
    return context.json(
      await dependencies.service.markEventRead(principal, context.req.param("eventId")),
    );
  });

  app.get("/v1/events/:eventId/deliveries", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "delivery:read");
    return context.json(
      await dependencies.service.getDeliveries(principal, context.req.param("eventId")),
    );
  });

  app.get("/v1/projects/:projectId/delivery-health", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "delivery:read");
    return context.json(
      await dependencies.service.getDeliveryHealth(principal, context.req.param("projectId")),
    );
  });

  app.get("/v1/projects/:projectId/export", async (context) => {
    const principal = await scopedPrincipal(context, dependencies.authenticator, "project:read");
    return context.json(
      await dependencies.service.exportHostedProject(
        principal,
        context.req.param("projectId"),
      ),
    );
  });

  app.notFound((context) =>
    context.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404),
  );

  app.onError((error, context) => {
    if (error instanceof ServiceError || error instanceof AuthenticationError) {
      if (
        error instanceof ServiceError &&
        error.code === "MONTHLY_SIGNAL_LIMIT_REACHED" &&
        typeof error.metadata?.resetAt === "string"
      ) {
        const retryAfter = Math.max(
          1,
          Math.ceil((Date.parse(error.metadata.resetAt) - Date.now()) / 1_000),
        );
        context.header("Retry-After", String(retryAfter));
      }
      return context.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error instanceof ServiceError && error.details ? { details: error.details } : {}),
            ...(error instanceof ServiceError && error.metadata ? error.metadata : {}),
          },
        },
        error.status,
      );
    }
    console.error("Unhandled request error", error instanceof Error ? error.message : "Unknown error");
    return context.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      500,
    );
  });

  return app;
}

async function authenticate(context: Context, authenticator: Authenticator): Promise<Principal> {
  return authenticator.authenticate(context.req.header("authorization"));
}

async function scopedPrincipal(
  context: Context,
  authenticator: Authenticator,
  scope: AgentScope,
): Promise<Principal> {
  const principal = await authenticate(context, authenticator);
  requireScope(principal, scope);
  return principal;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ServiceError(400, "INVALID_REQUEST", "A valid JSON body is required");
  }
}

async function readLimitedJson(
  request: Request,
  maximumBytes: number,
  maximumRequestBytes?: number,
): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ServiceError(413, "PAYLOAD_TOO_LARGE", `Body must not exceed ${maximumBytes} bytes`);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new ServiceError(413, "PAYLOAD_TOO_LARGE", `Body must not exceed ${maximumBytes} bytes`);
  }
  if (maximumRequestBytes !== undefined) {
    let estimatedBytes = new TextEncoder().encode(request.method + request.url).byteLength
      + bytes.byteLength;
    for (const key of ["authorization", "idempotency-key", "content-type"]) {
      const value = request.headers.get(key);
      if (value) estimatedBytes += new TextEncoder().encode(key + value).byteLength + 4;
    }
    if (estimatedBytes > maximumRequestBytes) {
      throw new ServiceError(
        413,
        "PAYLOAD_TOO_LARGE",
        `Request must not exceed ${maximumRequestBytes} bytes`,
      );
    }
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ServiceError(400, "INVALID_REQUEST", "A valid UTF-8 JSON body is required");
  }
}

function setUsageHeaders(
  context: Context,
  usage: {
    plan?: "free" | "pro";
    used: number;
    limit: number;
    courtesyLimit: number;
    resetAt: string;
  },
): void {
  if (usage.plan) context.header("X-Bellwire-Plan", usage.plan);
  context.header("X-Bellwire-Signals-Used", String(usage.used));
  context.header("X-Bellwire-Signals-Limit", String(usage.limit));
  context.header(
    "X-Bellwire-Signals-Remaining",
    String(Math.max(0, usage.limit - usage.used)),
  );
  context.header("X-Bellwire-Signals-Courtesy-Limit", String(usage.courtesyLimit));
  context.header("X-Bellwire-Signals-Reset", usage.resetAt);
}

function requireAppleBillingService(
  service: AppleBillingService | undefined,
): AppleBillingService {
  if (!service) {
    throw new ServiceError(503, "BILLING_UNAVAILABLE", "Apple billing is not configured");
  }
  return service;
}

function purchaseError(error: unknown): Error {
  return error instanceof AppleBillingVerificationError
    ? new ServiceError(400, "PURCHASE_INVALID", error.message)
    : error instanceof Error
      ? error
      : new Error("Apple billing failed");
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(400, "INVALID_REQUEST", "A JSON object is required");
  }
  return value as Record<string, unknown>;
}

async function readOptionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError(400, "INVALID_REQUEST", "A valid JSON body is required");
  }
}

function readQueryString(context: Context, key: string): string | undefined {
  const value = context.req.query(key)?.trim();
  return value ? value : undefined;
}

function readLimit(context: Context): number | undefined {
  const raw = context.req.query("limit");
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ServiceError(400, "INVALID_REQUEST", "limit must be a positive integer");
  }
  return value;
}
