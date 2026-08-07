// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type {
  AgentToken,
  Delivery,
  Device,
  EventSchema,
  LiveSurface,
  NotificationSurface,
  Project,
} from "../src/domain/models";
import { SupabaseBellwireRepository } from "../src/repositories/supabase-bellwire-repository";

describe("SupabaseBellwireRepository", () => {
  it("maps a null Surface limit from Postgres to an unlimited Pro entitlement", async () => {
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async () => Response.json([{
        plan: "pro",
        status: "active",
        product_id: "app.bellwire.pro.monthly",
        expires_at: "2026-09-04T00:00:00.000Z",
        downgrade_deadline: null,
        active_projects: 1,
        active_devices: 1,
        month_start: "2026-08-01",
        month_end: "2026-09-01T00:00:00.000Z",
        accepted_signals: 12,
        active_project_limit: 20,
        active_device_limit: 3,
        monthly_signal_limit: 50_000,
        courtesy_signal_limit: 55_000,
        ingest_per_minute: 300,
        hosted_retention_days: 90,
        surfaces_per_project: null,
      }]),
    );

    const entitlement = await repository.getAccountEntitlement(
      "user-1",
      "2026-08-04T00:00:00.000Z",
    );

    expect(entitlement.limits).toMatchObject({
      activeProjects: 20,
      surfacesPerProject: null,
    });
  });

  it("upserts and reads an encrypted Apple refresh token through the private table", async () => {
    const requests: Request[] = [];
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return request.method === "GET"
          ? Response.json([{ refresh_token_ciphertext: "v1.iv.ciphertext" }])
          : new Response(null, { status: 204 });
      },
    );

    await repository.saveAppleRefreshToken("user-1", "v1.iv.ciphertext");
    expect(await repository.getAppleRefreshToken("user-1")).toBe("v1.iv.ciphertext");

    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toContain("/apple_auth_tokens?on_conflict=user_id");
    expect(requests[0]?.headers.get("prefer")).toBe("resolution=merge-duplicates,return=minimal");
    expect(await requests[0]?.json()).toMatchObject({
      user_id: "user-1",
      refresh_token_ciphertext: "v1.iv.ciphertext",
    });
    expect(requests[1]?.url).toContain("user_id=eq.user-1");
    expect(requests[1]?.url).toContain("select=refresh_token_ciphertext");
  });

  it("deletes the authenticated account through the Supabase Auth admin API", async () => {
    let request: Request | undefined;
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co/",
      "service-role-key",
      async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 204 });
      },
    );

    await repository.deleteAccount("user/with-special-character");

    expect(request?.method).toBe("DELETE");
    expect(request?.url).toBe(
      "https://example.supabase.co/auth/v1/admin/users/user%2Fwith-special-character",
    );
    expect(request?.headers.get("apikey")).toBe("service-role-key");
    expect(request?.headers.get("authorization")).toBe("Bearer service-role-key");
  });

  it("deletes a project through its exact primary-key filter", async () => {
    let request: Request | undefined;
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 204 });
      },
    );

    await repository.deleteProject("project-1");

    expect(request?.method).toBe("DELETE");
    expect(request?.url).toBe("https://example.supabase.co/rest/v1/projects?id=eq.project-1");
  });

  it("atomically reuses a project through its account-scoped unique slug", async () => {
    const requests: Request[] = [];
    const storedRow = {
      id: "stored-project-id",
      user_id: "user-1",
      name: "Bellwire Demo",
      slug: "bellwire-system-demo-v1",
      icon: "bell.and.waves.left.and.right",
      logo_url: null,
      display_order: 0,
      category: "demo",
      status: "active",
      delivery_mode: "hosted",
      endpoint: "/v1/events/stored-project-id",
      created_at: "2026-08-04T00:00:00.000Z",
      updated_at: "2026-08-04T00:00:00.000Z",
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json(request.method === "POST" ? [] : [storedRow]);
      },
    );
    const candidate: Project = {
      id: "new-project-id",
      userId: "user-1",
      name: "Bellwire Demo",
      slug: "bellwire-system-demo-v1",
      icon: "bell.and.waves.left.and.right",
      displayOrder: 0,
      category: "demo",
      status: "active",
      deliveryMode: "hosted",
      endpoint: "/v1/events/new-project-id",
      createdAt: "2026-08-04T00:00:01.000Z",
      updatedAt: "2026-08-04T00:00:01.000Z",
    };

    const result = await repository.createProjectIfAbsent(candidate);

    expect(result).toMatchObject({ created: false, project: { id: "stored-project-id" } });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toContain("/projects?on_conflict=user_id,slug");
    expect(requests[0]?.headers.get("prefer"))
      .toBe("resolution=ignore-duplicates,return=representation");
    expect(requests[1]?.url).toContain("user_id=eq.user-1");
    expect(requests[1]?.url).toContain("slug=eq.bellwire-system-demo-v1");
  });

  it("marks unread events across owned projects in one filtered update", async () => {
    let request: Request | undefined;
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        request = new Request(input, init);
        return Response.json([{ id: "event-1" }, { id: "event-2" }]);
      },
    );

    const updated = await repository.markAllEventsRead(
      ["project-1", "project-2"],
      "2026-07-21T14:00:00.000Z",
    );

    expect(updated).toBe(2);
    expect(request?.method).toBe("PATCH");
    const url = new URL(request?.url ?? "https://invalid.example");
    expect(url.searchParams.get("project_id")).toBe("in.(project-1,project-2)");
    expect(url.searchParams.get("read_at")).toBe("is.null");
    expect(url.searchParams.get("select")).toBe("id");
    expect(request?.headers.get("prefer")).toBe("return=representation");
    expect(await request?.json()).toEqual({ read_at: "2026-07-21T14:00:00.000Z" });
  });

  it("lets Postgres preserve a device primary key when an APNs token is re-registered", async () => {
    let request: Request | undefined;
    const storedRow = {
      id: "stored-device-id",
      user_id: "user-1",
      installation_id: "11111111-1111-4111-8111-111111111111",
      name: "Updated iPhone",
      platform: "ios",
      apns_token: "a".repeat(64),
      apns_environment: "sandbox",
      app_version: "1.1",
      build_number: "11",
      notification_authorization: "provisional",
      last_active_at: "2026-07-20T12:00:00.000Z",
      push_enabled: true,
      created_at: "2026-07-19T12:00:00.000Z",
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json([storedRow]);
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      fetchImpl,
    );
    const input: Device = {
      id: "new-random-id",
      userId: "user-1",
      installationId: "11111111-1111-4111-8111-111111111111",
      name: "Updated iPhone",
      platform: "ios",
      apnsToken: "a".repeat(64),
      apnsEnvironment: "sandbox",
      appVersion: "1.1",
      buildNumber: "11",
      notificationAuthorization: "provisional",
      lastActiveAt: "2026-07-20T12:00:00.000Z",
      pushEnabled: true,
      createdAt: "2026-07-20T12:00:00.000Z",
    };

    const saved = await repository.saveDevice(input);
    const body = await request?.json();

    expect(body).toMatchObject({
      p_id: input.id,
      p_user_id: input.userId,
      p_installation_id: input.installationId,
      p_apns_token: input.apnsToken,
      p_apns_environment: input.apnsEnvironment,
      p_app_version: input.appVersion,
      p_build_number: input.buildNumber,
      p_notification_authorization: input.notificationAuthorization,
      p_name: input.name,
    });
    expect(saved).toMatchObject({
      id: "stored-device-id",
      apnsEnvironment: "sandbox",
      buildNumber: "11",
      notificationAuthorization: "provisional",
      createdAt: storedRow.created_at,
    });
    expect(request?.url).toContain("/rpc/register_device");
  });

  it("saves a live Surface through the atomic version RPC", async () => {
    let request: Request | undefined;
    const storedRow = {
      id: "surface-id",
      project_id: "project-id",
      surface_key: "prod-api",
      type: "metrics",
      title: "API health",
      subtitle: "Production",
      content: { metrics: [{ label: "CPU", value: 18, unit: "%" }] },
      action: null,
      display_order: 0,
      version: 2,
      created_at: "2026-07-21T00:00:00.000Z",
      updated_at: "2026-07-21T00:05:00.000Z",
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json([storedRow]);
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      fetchImpl,
    );
    const input: LiveSurface = {
      id: "surface-id",
      projectId: "project-id",
      surfaceKey: "prod-api",
      type: "metrics",
      title: "API health",
      subtitle: "Production",
      content: { metrics: [{ label: "CPU", value: 18, unit: "%" }] },
      displayOrder: 0,
      version: 2,
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:05:00.000Z",
    };

    const saved = await repository.saveLiveSurface(input);
    const body = await request?.json();
    expect(request?.url).toBe("https://example.supabase.co/rest/v1/rpc/save_live_surface_version");
    expect(body).toMatchObject({
      p_project_id: "project-id",
      p_surface_key: "prod-api",
      p_content: input.content,
    });
    expect(body).not.toHaveProperty("p_version");
    expect(saved).toMatchObject(input);
  });

  it("saves event schema and notification Surface versions through transaction RPCs", async () => {
    const requests: Request[] = [];
    const schemaRow = {
      id: "schema-id",
      project_id: "project-id",
      event_type: "payment.success",
      fields: { amount: { type: "number" } },
      version: 4,
      status: "active",
      created_at: "2026-07-21T00:00:00.000Z",
    };
    const surfaceRow = {
      id: "surface-id",
      project_id: "project-id",
      event_type: "payment.success",
      type: "notification",
      title_template: "Payment",
      body_template: "Received",
      subtitle_template: null,
      sound: "default",
      group_name: "payment",
      priority: "normal",
      enabled: true,
      version: 5,
      created_at: "2026-07-21T00:01:00.000Z",
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json(request.url.endsWith("save_event_schema_version")
          ? [schemaRow]
          : [surfaceRow]);
      },
    );
    const schema: EventSchema = {
      id: "schema-id",
      projectId: "project-id",
      eventType: "payment.success",
      fields: { amount: { type: "number" } },
      version: 1,
      status: "active",
      createdAt: schemaRow.created_at,
    };
    const surface: NotificationSurface = {
      id: "surface-id",
      projectId: "project-id",
      eventType: "payment.success",
      type: "notification",
      titleTemplate: "Payment",
      bodyTemplate: "Received",
      sound: "default",
      group: "payment",
      priority: "normal",
      enabled: true,
      version: 1,
      createdAt: surfaceRow.created_at,
    };

    const [savedSchema, savedSurface] = await Promise.all([
      repository.saveEventSchema(schema),
      repository.saveNotificationSurface(surface),
    ]);

    expect(requests.map((request) => request.url)).toEqual(expect.arrayContaining([
      "https://example.supabase.co/rest/v1/rpc/save_event_schema_version",
      "https://example.supabase.co/rest/v1/rpc/save_notification_surface_version",
    ]));
    for (const request of requests) expect(await request.json()).not.toHaveProperty("p_version");
    expect(savedSchema.version).toBe(4);
    expect(savedSurface.version).toBe(5);
  });

  it("ensures initial demo schema and notification Surface with version-one constraints", async () => {
    const requests: Request[] = [];
    const schemaRow = {
      id: "schema-id",
      project_id: "project-id",
      event_type: "deployment.completed",
      fields: { deployment: { type: "string", required: true } },
      version: 1,
      status: "active",
      created_at: "2026-08-04T00:00:00.000Z",
    };
    const surfaceRow = {
      id: "surface-id",
      project_id: "project-id",
      event_type: "deployment.completed",
      type: "notification",
      title_template: "Deployment completed",
      body_template: "{{ deployment }} completed",
      subtitle_template: null,
      sound: "default",
      group_name: "deployment",
      priority: "normal",
      enabled: true,
      version: 1,
      created_at: "2026-08-04T00:00:00.000Z",
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") return Response.json([]);
        return Response.json(request.url.includes("event_schemas") ? [schemaRow] : [surfaceRow]);
      },
    );
    const schema: EventSchema = {
      id: "schema-id",
      projectId: "project-id",
      eventType: "deployment.completed",
      fields: { deployment: { type: "string", required: true } },
      version: 1,
      status: "active",
      createdAt: schemaRow.created_at,
    };
    const surface: NotificationSurface = {
      id: "surface-id",
      projectId: "project-id",
      eventType: "deployment.completed",
      type: "notification",
      titleTemplate: "Deployment completed",
      bodyTemplate: "{{ deployment }} completed",
      sound: "default",
      group: "deployment",
      priority: "normal",
      enabled: true,
      version: 1,
      createdAt: surfaceRow.created_at,
    };

    const ensured = await repository.ensureEventSchemaAndNotificationSurface(schema, surface);

    expect(ensured).toMatchObject({ schema: { version: 1 }, surface: { version: 1 } });
    expect(requests.map((request) => request.url)).toEqual(expect.arrayContaining([
      "https://example.supabase.co/rest/v1/event_schemas?on_conflict=project_id,event_type,version",
      "https://example.supabase.co/rest/v1/notification_surfaces?on_conflict=project_id,event_type,version",
    ]));
    for (const request of requests.filter((candidate) => candidate.method === "POST")) {
      expect(request.headers.get("prefer"))
        .toBe("resolution=ignore-duplicates,return=representation");
    }
  });

  it("gets and conditionally adopts an Event through its exact idempotency hash", async () => {
    const requests: Request[] = [];
    const oldHash = "a".repeat(64);
    const fixedHash = "b".repeat(64);
    const eventRow = {
      id: "event-id",
      project_id: "project-id",
      event_type: "deployment.completed",
      idempotency_key_hash: fixedHash,
      data: { deployment: "Bellwire 1.0" },
      sensitive_fields: [],
      occurred_at: "2026-08-04T00:00:00.000Z",
      received_at: "2026-08-04T00:00:00.000Z",
      status: "accepted",
      read_at: null,
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json([eventRow]);
      },
    );

    const found = await repository.getEventByIdempotencyHash("project-id", fixedHash);
    const adopted = await repository.replaceEventIdempotencyHash(
      "event-id",
      oldHash,
      fixedHash,
    );

    expect(found).toMatchObject({ id: "event-id", idempotencyKeyHash: fixedHash });
    expect(adopted).toMatchObject({ id: "event-id", idempotencyKeyHash: fixedHash });
    const getUrl = new URL(requests[0]!.url);
    expect(getUrl.searchParams.get("project_id")).toBe("eq.project-id");
    expect(getUrl.searchParams.get("idempotency_key_hash")).toBe(`eq.${fixedHash}`);
    const patchUrl = new URL(requests[1]!.url);
    expect(requests[1]?.method).toBe("PATCH");
    expect(patchUrl.searchParams.get("id")).toBe("eq.event-id");
    expect(patchUrl.searchParams.get("idempotency_key_hash")).toBe(`eq.${oldHash}`);
    expect(await requests[1]?.json()).toEqual({ idempotency_key_hash: fixedHash });
  });

  it("claims a binding and stores its Agent token through one transactional RPC", async () => {
    let request: Request | undefined;
    const storedRow = {
      id: "token-id",
      user_id: "user-id",
      name: "Codex",
      token_hash: "a".repeat(64),
      scopes: ["project:read"],
      created_at: "2026-07-21T01:00:00.000Z",
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        request = new Request(input, init);
        return Response.json([storedRow]);
      },
    );
    const token: Omit<AgentToken, "userId"> = {
      id: "token-id",
      name: "Codex",
      tokenHash: "a".repeat(64),
      scopes: ["project:read"],
      createdAt: "2026-07-21T01:00:00.000Z",
    };

    const claimed = await repository.claimDeviceBinding(
      "b".repeat(64),
      token,
      "2026-07-21T01:00:00.000Z",
    );

    expect(request?.url).toBe("https://example.supabase.co/rest/v1/rpc/claim_device_binding");
    expect(await request?.json()).toMatchObject({
      p_code_hash: "b".repeat(64),
      p_token_id: "token-id",
      p_token_hash: "a".repeat(64),
    });
    expect(claimed).toMatchObject({ id: "token-id", userId: "user-id" });
  });

  it("lists active Agent connections and revokes one within its owning user", async () => {
    const requests: Request[] = [];
    const storedRow = {
      id: "token-id",
      user_id: "user-id",
      name: "Codex on Mac",
      token_hash: "a".repeat(64),
      scopes: ["project:read"],
      created_at: "2026-07-21T01:00:00.000Z",
      last_used_at: "2026-07-22T01:00:00.000Z",
      expires_at: null,
      revoked_at: null,
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return request.method === "GET"
          ? Response.json([storedRow])
          : new Response(null, { status: 204 });
      },
    );

    expect(await repository.listAgentTokens("user-id")).toMatchObject([
      { id: "token-id", userId: "user-id", name: "Codex on Mac" },
    ]);
    await repository.revokeAgentToken(
      "token-id",
      "user-id",
      "2026-07-23T01:00:00.000Z",
    );

    expect(requests[0]?.url).toContain("user_id=eq.user-id");
    expect(requests[0]?.url).toContain("revoked_at=is.null");
    expect(requests[1]?.method).toBe("PATCH");
    expect(requests[1]?.url).toContain("id=eq.token-id");
    expect(requests[1]?.url).toContain("user_id=eq.user-id");
    expect(await requests[1]?.json()).toEqual({
      revoked_at: "2026-07-23T01:00:00.000Z",
    });
  });

  it("stores device public keys and opaque direct connection envelopes", async () => {
    const requests: Request[] = [];
    const deviceKeyRow = {
      id: "11111111-1111-4111-8111-111111111111",
      user_id: "user-id",
      installation_id: "22222222-2222-4222-8222-222222222222",
      agreement_public_key: "agreement-key",
      signing_public_key: "signing-key",
      algorithm: "p256",
      created_at: "2026-07-23T01:00:00.000Z",
      last_active_at: "2026-07-23T01:00:00.000Z",
      revoked_at: null,
    };
    const envelopeRow = {
      id: "33333333-3333-4333-8333-333333333333",
      user_id: "user-id",
      device_key_id: deviceKeyRow.id,
      project_id: "44444444-4444-4444-8444-444444444444",
      manifest_version: 2,
      algorithm: "p256-hkdf-sha256-aes-gcm",
      ephemeral_public_key: "ephemeral-key",
      sealed_box: "opaque-ciphertext",
      created_at: "2026-07-23T01:00:00.000Z",
      expires_at: "2026-07-24T01:00:00.000Z",
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.includes("/rpc/ack_direct_connection_envelope")) {
          return Response.json(envelopeRow.project_id);
        }
        if (request.url.includes("/device_keys")) return Response.json([deviceKeyRow]);
        return Response.json([envelopeRow]);
      },
    );

    await repository.saveDeviceKey({
      id: deviceKeyRow.id,
      userId: "user-id",
      installationId: deviceKeyRow.installation_id,
      agreementPublicKey: deviceKeyRow.agreement_public_key,
      signingPublicKey: deviceKeyRow.signing_public_key,
      algorithm: "p256",
      createdAt: deviceKeyRow.created_at,
      lastActiveAt: deviceKeyRow.last_active_at,
    });
    await repository.saveDirectConnectionEnvelope({
      id: envelopeRow.id,
      userId: "user-id",
      deviceKeyId: deviceKeyRow.id,
      projectId: envelopeRow.project_id,
      manifestVersion: 2,
      algorithm: "p256-hkdf-sha256-aes-gcm",
      ephemeralPublicKey: envelopeRow.ephemeral_public_key,
      sealedBox: envelopeRow.sealed_box,
      createdAt: envelopeRow.created_at,
      expiresAt: envelopeRow.expires_at,
    });
    expect(await repository.listDirectConnectionEnvelopes(
      "user-id",
      deviceKeyRow.id,
      "2026-07-23T12:00:00.000Z",
    )).toMatchObject([{ id: envelopeRow.id, sealedBox: "opaque-ciphertext" }]);
    expect(await repository.acknowledgeDirectConnectionEnvelope(
      envelopeRow.id,
      "user-id",
      deviceKeyRow.id,
      "2026-07-23T12:05:00.000Z",
    )).toBe(envelopeRow.project_id);

    expect(requests[0]?.url).toContain("/device_keys?on_conflict=user_id,id");
    expect(requests[1]?.url).toContain("/direct_connection_envelopes");
    expect(requests[2]?.url).toContain("expires_at=gt.2026-07-23T12%3A00%3A00.000Z");
    expect(requests[3]?.method).toBe("POST");
    expect(requests[3]?.url).toContain("/rpc/ack_direct_connection_envelope");
  });

  it("creates, lists, and resolves one opaque Direct recovery request", async () => {
    const requests: Request[] = [];
    const row = {
      user_id: "user-id",
      project_id: "44444444-4444-4444-8444-444444444444",
      device_key_id: "11111111-1111-4111-8111-111111111111",
      installation_id: "22222222-2222-4222-8222-222222222222",
      app_version: "1.0.0",
      build_number: "11",
      notification_authorization: "denied",
      requested_at: "2026-08-03T01:00:00.000Z",
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json([row]);
      },
    );

    const saved = await repository.saveDirectConnectionRecoveryRequestIfAbsent({
      userId: row.user_id,
      projectId: row.project_id,
      deviceKeyId: row.device_key_id,
      installationId: row.installation_id,
      appVersion: row.app_version,
      buildNumber: row.build_number,
      notificationAuthorization: "denied",
      requestedAt: row.requested_at,
    });
    expect(saved).toMatchObject({
      created: true,
      request: {
        projectId: row.project_id,
        deviceKeyId: row.device_key_id,
        buildNumber: "11",
        notificationAuthorization: "denied",
      },
    });
    expect(await repository.listDirectConnectionRecoveryRequests(row.user_id))
      .toHaveLength(1);
    await repository.deleteDirectConnectionRecoveryRequest(
      row.project_id,
      row.device_key_id,
    );

    expect(requests[0]?.url).toContain(
      "/direct_connection_recovery_requests?on_conflict=project_id,device_key_id",
    );
    expect(requests[0]?.headers.get("prefer"))
      .toBe("resolution=ignore-duplicates,return=representation");
    expect(JSON.stringify(await requests[0]?.json())).not.toContain("sealed_box");
    expect(requests[1]?.url).toContain("user_id=eq.user-id");
    expect(requests[2]?.method).toBe("DELETE");
  });

  it("fetches the latest notification Surface before evaluating enabled", async () => {
    let request: Request | undefined;
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        request = new Request(input, init);
        return Response.json([{
          id: "surface-2",
          project_id: "project-id",
          event_type: "payment.success",
          type: "notification",
          title_template: "Payment",
          body_template: "Received",
          subtitle_template: null,
          sound: "default",
          group_name: "payment",
          priority: "normal",
          enabled: false,
          version: 2,
          created_at: "2026-07-21T01:00:00.000Z",
        }]);
      },
    );

    const latest = await repository.getNotificationSurface("project-id", "payment.success");

    expect(latest).toMatchObject({ enabled: false, version: 2 });
    expect(request?.url).toContain("order=version.desc");
    expect(request?.url).not.toContain("enabled=eq.true");
  });

  it("claims a delivery lease with an atomic repository RPC", async () => {
    let request: Request | undefined;
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        request = new Request(input, init);
        return Response.json([{
          id: "delivery-id",
          event_id: "event-id",
          device_id: "device-id",
          channel: "apns",
          status: "queued",
          attempt_count: 2,
          provider_message_id: null,
          error_code: null,
          error_message: null,
          queued_at: "2026-07-21T01:00:00.000Z",
          sent_at: null,
          updated_at: "2026-07-21T01:02:00.000Z",
        }]);
      },
    );

    const claimed = await repository.claimDelivery(
      "delivery-id",
      "2026-07-21T01:02:00.000Z",
      60,
      3,
    );

    expect(request?.url).toBe("https://example.supabase.co/rest/v1/rpc/claim_delivery");
    expect(await request?.json()).toEqual({
      p_delivery_id: "delivery-id",
      p_claimed_at: "2026-07-21T01:02:00.000Z",
      p_lease_seconds: 60,
      p_max_attempts: 3,
    });
    expect(claimed).toMatchObject({ status: "queued", attemptCount: 2 });
  });

  it("completes a delivery only for the current claimed attempt", async () => {
    let request: Request | undefined;
    const row = {
      id: "delivery-id",
      event_id: "event-id",
      device_id: "device-id",
      channel: "apns",
      status: "accepted_by_apns",
      attempt_count: 2,
      provider_message_id: "apns-id",
      error_code: null,
      error_message: null,
      queued_at: "2026-07-21T01:00:00.000Z",
      sent_at: "2026-07-21T01:02:01.000Z",
      updated_at: "2026-07-21T01:02:01.000Z",
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        request = new Request(input, init);
        return Response.json([row]);
      },
    );

    await repository.completeClaimedDelivery({
      id: "delivery-id",
      eventId: "event-id",
      deviceId: "device-id",
      channel: "apns",
      status: "accepted_by_apns",
      attemptCount: 2,
      providerMessageId: "apns-id",
      queuedAt: "2026-07-21T01:00:00.000Z",
      sentAt: "2026-07-21T01:02:01.000Z",
      updatedAt: "2026-07-21T01:02:01.000Z",
    });

    expect(request?.url).toContain("status=eq.queued");
    expect(request?.url).toContain("attempt_count=eq.2");
    expect(request?.headers.get("prefer")).toBe("return=representation");
  });

  it("records QueueUnavailable through a status, attempt, and timestamp CAS RPC", async () => {
    let request: Request | undefined;
    const expected: Delivery = {
      id: "delivery-id",
      eventId: "event-id",
      deviceId: "device-id",
      channel: "apns",
      status: "queued",
      attemptCount: 0,
      queuedAt: "2026-07-21T01:00:00.000Z",
      updatedAt: "2026-07-21T01:00:00.000Z",
    };
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        request = new Request(input, init);
        return Response.json([]);
      },
    );

    const saved = await repository.recordQueueUnavailable(
      expected,
      "2026-07-21T01:00:01.000Z",
      "Queue unavailable",
    );

    expect(saved).toBeUndefined();
    expect(request?.url).toBe("https://example.supabase.co/rest/v1/rpc/record_queue_unavailable");
    expect(await request?.json()).toEqual({
      p_delivery_id: "delivery-id",
      p_expected_status: "queued",
      p_expected_attempt_count: 0,
      p_expected_updated_at: "2026-07-21T01:00:00.000Z",
      p_failed_at: "2026-07-21T01:00:01.000Z",
      p_error_message: "Queue unavailable",
    });
  });

  it("limits delivery health to records updated inside the requested window", async () => {
    const requests: Request[] = [];
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.includes("/projects?")) {
          return Response.json([{
            id: "project-id",
            user_id: "user-id",
            name: "Hosted",
            slug: "hosted",
            icon: "bell",
            display_order: 0,
            category: "automation",
            status: "active",
            delivery_mode: "hosted",
            endpoint: "https://api.example.com",
            created_at: "2026-07-21T01:00:00.000Z",
            updated_at: "2026-07-21T01:00:00.000Z",
          }]);
        }
        return Response.json([{ status: "accepted_by_apns" }]);
      },
    );
    const health = await repository.getDeliveryHealth(
      "project-id",
      "2026-07-22T01:00:00.000Z",
    );

    expect(health).toEqual({ queued: 0, accepted: 1, failed: 0, status: "healthy" });
    expect(requests[1]?.url).toContain("events.project_id=eq.project-id");
    expect(requests[1]?.url).toContain(
      "updated_at=gte.2026-07-22T01%3A00%3A00.000Z",
    );
  });

  it("reads Private delivery health from wake deliveries rather than Hosted events", async () => {
    const requests: Request[] = [];
    const repository = new SupabaseBellwireRepository(
      "https://example.supabase.co",
      "service-role-key",
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.includes("/projects?")) {
          return Response.json([{
            id: "private-project",
            user_id: "user-id",
            name: "Private",
            slug: "private",
            icon: "lock",
            display_order: 0,
            category: "automation",
            status: "active",
            delivery_mode: "private",
            endpoint: "https://api.example.com",
            created_at: "2026-07-21T01:00:00.000Z",
            updated_at: "2026-07-21T01:00:00.000Z",
          }]);
        }
        return Response.json([
          { status: "queued" },
          { status: "failed" },
        ]);
      },
    );

    const health = await repository.getDeliveryHealth(
      "private-project",
      "2026-07-22T01:00:00.000Z",
    );

    expect(health).toEqual({ queued: 1, accepted: 0, failed: 1, status: "degraded" });
    expect(requests[1]?.url).toContain("/private_wake_deliveries?");
    expect(requests[1]?.url).toContain("private_wakes.project_id=eq.private-project");
    expect(requests[1]?.url).not.toContain("events.project_id");
  });
});
