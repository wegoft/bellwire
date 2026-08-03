// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { Principal } from "../src/domain/models";
import { InMemoryBellwireRepository } from "../src/repositories/in-memory-bellwire-repository";
import { PrincipalAuthenticator, StaticAuthenticator } from "../src/security/authenticator";
import { hashSecret } from "../src/security/tokens";
import { BellwireService } from "../src/services/bellwire-service";
import type { DeliveryDispatcher } from "../src/services/delivery-dispatcher";

const userPrincipal: Principal = {
  kind: "user",
  userId: "user-one",
  scopes: ["project:read", "project:write", "config:read", "config:write", "event:test", "delivery:read"],
};

const eventSchema = {
  eventType: "payment.success",
  fields: {
    orderId: { type: "string", required: true },
    amount: { type: "number", required: true },
    currency: { type: "enum", required: true, values: ["CNY", "USD"] },
    customer: { type: "string", sensitive: true },
    paidAt: { type: "datetime" },
  },
  notification: {
    title: "Payment received",
    body: "{{ currency }} {{ amount }}",
  },
};

const validEvent = {
  type: "payment.success",
  data: {
    orderId: "ord_123",
    amount: 28,
    currency: "CNY",
    customer: "Ada Secret",
  },
  occurredAt: "2026-07-20T09:30:00Z",
};

class CapturingDispatcher implements DeliveryDispatcher {
  readonly eventIds: string[] = [];
  readonly wakeIds: string[] = [];
  readonly modeRequestIds: string[] = [];

  async enqueue(event: { id: string }): Promise<void> {
    this.eventIds.push(event.id);
  }

  async enqueuePrivateWake(wake: { id: string }): Promise<void> {
    this.wakeIds.push(wake.id);
  }

  async enqueueModeRequest(request: { id: string }): Promise<void> {
    this.modeRequestIds.push(request.id);
  }
}

class FailingDispatcher implements DeliveryDispatcher {
  async enqueue(): Promise<void> {
    throw new Error("Queue quota exceeded");
  }

  async enqueuePrivateWake(): Promise<void> {
    throw new Error("Queue quota exceeded");
  }

  async enqueueModeRequest(): Promise<void> {
    throw new Error("Queue quota exceeded");
  }
}

describe("Bellwire MVP API", () => {
  let repository: InMemoryBellwireRepository;
  let dispatcher: CapturingDispatcher;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    repository = new InMemoryBellwireRepository();
    dispatcher = new CapturingDispatcher();
    app = createApp({
      service: new BellwireService(repository, dispatcher),
      authenticator: new StaticAuthenticator(userPrincipal),
    });
  });

  async function createProject(targetApp = app): Promise<string> {
    const response = await targetApp.request("/v1/projects", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ name: "VideoSays" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json<{ id: string }>();
    return body.id;
  }

  async function configureProject(projectId: string): Promise<string> {
    await makeHosted(projectId);
    const schemaResponse = await app.request(`/v1/projects/${projectId}/event-schemas`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify(eventSchema),
    });
    expect(schemaResponse.status).toBe(201);

    const tokenResponse = await app.request(`/v1/projects/${projectId}/ingest-tokens`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ name: "production" }),
    });
    expect(tokenResponse.status).toBe(201);
    const body = await tokenResponse.json<{ token: string }>();
    return body.token;
  }

  async function makeHosted(projectId: string): Promise<void> {
    const privateProject = await repository.getProject(projectId);
    if (!privateProject) throw new Error("Project missing");
    await repository.updateProject({ ...privateProject, deliveryMode: "hosted" });
  }

  async function registerDevice(
    installationId = "11111111-1111-4111-8111-111111111111",
  ): Promise<void> {
    await repository.saveDevice({
      id: crypto.randomUUID(),
      userId: userPrincipal.userId,
      installationId,
      name: "Test iPhone",
      platform: "ios",
      apnsToken: "a".repeat(64),
      apnsEnvironment: "sandbox",
      appVersion: "1.0",
      lastActiveAt: new Date().toISOString(),
      pushEnabled: true,
      createdAt: new Date().toISOString(),
    });
  }

  it("reports App, API, and database compatibility on the health endpoint", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "bellwire-api",
      compatibility: {
        appVersion: "1.0.1",
        apiVersion: "v1",
        schemaMigration: "202608030001",
      },
    });
  });

  it("creates a project, schema, surface, and one-time ingest token while storing only its hash", async () => {
    const projectId = await createProject();
    const token = await configureProject(projectId);
    expect(token).toMatch(/^bw_live_[A-Za-z0-9_-]+$/u);

    const project = await repository.getProject(projectId);
    expect(project).toMatchObject({
      userId: userPrincipal.userId,
      name: "VideoSays",
      endpoint: `/v1/events/${projectId}`,
      status: "active",
    });
    expect(await repository.getEventSchema(projectId, "payment.success")).toMatchObject({ version: 1 });
    expect(await repository.getNotificationSurface(projectId, "payment.success")).toMatchObject({
      bodyTemplate: "{{ currency }} {{ amount }}",
      version: 1,
    });

    const storedTokens = await repository.listIngestTokens(projectId);
    expect(storedTokens).toHaveLength(1);
    expect(storedTokens[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(storedTokens[0]?.tokenHash).not.toBe(token);
    expect(storedTokens[0]).not.toHaveProperty("token");
  });

  it("creates new projects in Private mode and strictly isolates mode-specific writes", async () => {
    const projectId = await createProject();
    expect(await repository.getProject(projectId)).toMatchObject({ deliveryMode: "private" });

    const hostedToken = await app.request(`/v1/projects/${projectId}/ingest-tokens`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ name: "must-fail" }),
    });
    expect(hostedToken.status).toBe(409);
    expect(await hostedToken.json()).toMatchObject({ error: { code: "PROJECT_PRIVATE_MODE" } });

    await makeHosted(projectId);
    const wakeToken = await app.request(`/v1/projects/${projectId}/wake-tokens`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ name: "must-fail" }),
    });
    expect(wakeToken.status).toBe(409);
    expect(await wakeToken.json()).toMatchObject({ error: { code: "PROJECT_HOSTED_MODE" } });
  });

  it("accepts one strictly shaped Private wake and stores only idempotency hash", async () => {
    const projectId = await createProject();
    await registerDevice();
    const tokenResponse = await app.request(`/v1/projects/${projectId}/wake-tokens`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ name: "production" }),
    });
    const { token } = await tokenResponse.json<{ token: string }>();
    expect(token).toMatch(/^bw_wake_/u);

    const send = (body: Record<string, unknown>, key = "source-operation-123") =>
      app.request(`/v1/projects/${projectId}/private-wakes`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      });
    const reference = "N8Y1uFfPnM6J6q3O2gEmDA";
    const first = await send({ reference, priority: "normal" });
    expect(first.status).toBe(201);
    const accepted = await first.json<{ wakeId: string; deduplicated: boolean }>();
    expect(accepted.deduplicated).toBe(false);
    expect(dispatcher.wakeIds).toEqual([accepted.wakeId]);

    const duplicate = await send({ reference, priority: "normal" });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      wakeId: accepted.wakeId,
      deduplicated: true,
    });
    expect(dispatcher.wakeIds).toEqual([accepted.wakeId]);
    expect(await repository.getPrivateWake(accepted.wakeId)).toMatchObject({
      idempotencyKeyHash: await hashSecret("source-operation-123"),
      reference,
    });
    expect(JSON.stringify(await repository.getPrivateWake(accepted.wakeId)))
      .not.toContain("source-operation-123");

    const unknown = await send({ reference, priority: "normal", title: "must not reach cloud" }, "other");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    const shortReference = await send({ reference: "order_123", priority: "normal" }, "third");
    expect(shortReference.status).toBe(400);

    const oversized = await send(
      { reference, priority: "normal", padding: "x".repeat(600) },
      "oversized",
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("applies the Hosted Event payload limit to authenticated test sends", async () => {
    const projectId = await createProject();
    await makeHosted(projectId);
    const response = await app.request(`/v1/projects/${projectId}/events/test`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        type: "payment.success",
        data: { padding: "x".repeat(17_000) },
      }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("requires an Agent request and user approval before Hosted mode, then revokes wake tokens", async () => {
    const projectId = await createProject();
    const wakeTokenResponse = await app.request(`/v1/projects/${projectId}/wake-tokens`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ name: "production" }),
    });
    expect(wakeTokenResponse.status).toBe(201);

    const directUserRequest = await app.request(`/v1/projects/${projectId}/delivery-mode-requests`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ toMode: "hosted" }),
    });
    expect(directUserRequest.status).toBe(403);

    const agentApp = createApp({
      service: new BellwireService(repository, dispatcher),
      authenticator: new StaticAuthenticator({
        ...userPrincipal,
        kind: "agent",
        tokenId: "11111111-1111-4111-8111-111111111119",
      }),
    });
    const requested = await agentApp.request(`/v1/projects/${projectId}/delivery-mode-requests`, {
      method: "POST",
      headers: { authorization: "Bearer agent", "content-type": "application/json" },
      body: JSON.stringify({ toMode: "hosted" }),
    });
    expect(requested.status).toBe(201);
    const request = await requested.json<{ id: string }>();
    expect(dispatcher.modeRequestIds).toEqual([request.id]);

    const approved = await app.request(`/v1/delivery-mode-requests/${request.id}/approve`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: "{}",
    });
    expect(approved.status).toBe(200);
    expect(await repository.getProject(projectId)).toMatchObject({ deliveryMode: "hosted" });
    expect(await repository.listPrivateWakeTokens(projectId)).toEqual([
      expect.objectContaining({ revokedAt: expect.any(String) }),
    ]);
  });

  it("stores a public HTTPS project logo and allows clearing it", async () => {
    const create = await app.request("/v1/projects", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ name: "Logo project", logoUrl: "https://cdn.example.com/logo.png" }),
    });
    expect(create.status).toBe(201);
    const project = await create.json<{ id: string; logoUrl?: string }>();
    expect(project.logoUrl).toBe("https://cdn.example.com/logo.png");

    const clear = await app.request(`/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ logoUrl: null }),
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).not.toHaveProperty("logoUrl");

    const invalid = await app.request(`/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ logoUrl: "http://example.com/logo.png" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("deletes the signed-in account and all account-owned data", async () => {
    const projectId = await createProject();
    await registerDevice();

    const response = await app.request("/v1/account", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });

    expect(response.status).toBe(204);
    expect(await repository.getProject(projectId)).toBeUndefined();
    expect(await repository.listProjects(userPrincipal.userId)).toEqual([]);
    expect(await repository.listDevices(userPrincipal.userId)).toEqual([]);
  });

  it("creates an idempotent demo experience for App Review", async () => {
    const first = await app.request("/v1/demo", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    expect(first.status).toBe(201);
    const demo = await first.json<{ projectId: string; created: boolean }>();
    expect(demo.created).toBe(true);
    expect(await repository.getProject(demo.projectId)).toMatchObject({
      name: "Bellwire Demo",
      category: "demo",
    });
    expect(await repository.listLiveSurfaces(demo.projectId)).toHaveLength(1);
    expect((await repository.listEvents(demo.projectId, { limit: 10 })).events).toHaveLength(1);

    const second = await app.request("/v1/demo", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ projectId: demo.projectId, created: false });
    expect(await repository.listProjects(userPrincipal.userId)).toHaveLength(1);
  });

  it("deletes an owned project and all of its project-scoped data", async () => {
    const projectId = await createProject();
    const token = await configureProject(projectId);
    const surfaceResponse = await app.request(`/v1/projects/${projectId}/surfaces/revenue-today`, {
      method: "PUT",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        type: "stats",
        title: "Revenue today",
        metrics: [{ label: "Revenue", value: "¥28" }],
      }),
    });
    expect(surfaceResponse.status).toBe(200);
    const eventResponse = await app.request(`/v1/events/${projectId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "project-delete-event",
      },
      body: JSON.stringify(validEvent),
    });
    expect(eventResponse.status).toBe(201);

    const response = await app.request(`/v1/projects/${projectId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });

    expect(response.status).toBe(204);
    expect(await repository.getProject(projectId)).toBeUndefined();
    expect(await repository.listEventSchemas(projectId)).toEqual([]);
    expect(await repository.listNotificationSurfaces(projectId)).toEqual([]);
    expect(await repository.listLiveSurfaces(projectId)).toEqual([]);
    expect(await repository.listIngestTokens(projectId)).toEqual([]);
    expect((await repository.listEvents(projectId, { limit: 100 })).events).toEqual([]);
  });

  it("does not let one user delete another user's project", async () => {
    const projectId = await createProject();
    const otherApp = createApp({
      service: new BellwireService(repository),
      authenticator: new StaticAuthenticator({ ...userPrincipal, userId: "user-two" }),
    });

    const response = await otherApp.request(`/v1/projects/${projectId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });

    expect(response.status).toBe(404);
    expect(await repository.getProject(projectId)).toBeDefined();
  });

  it("requires a stable installation ID and rotates APNs tokens without duplicating a device", async () => {
    const headers = { authorization: "Bearer test", "content-type": "application/json" };
    const installationId = "11111111-1111-4111-8111-111111111111";
    const withoutInstallation = await app.request("/v1/devices", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "iPhone", apnsToken: "a".repeat(64), appVersion: "0.1.0" }),
    });
    expect(withoutInstallation.status).toBe(400);

    const first = await app.request("/v1/devices", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "iPhone",
        apnsToken: "a".repeat(64),
        appVersion: "0.1.0",
        installationId,
      }),
    });
    expect(first.status).toBe(201);
    const firstDevice = await first.json<{ id: string; apnsEnvironment: string }>();
    expect(firstDevice.apnsEnvironment).toBe("production");

    const rotated = await app.request("/v1/devices", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "iPhone",
        apnsToken: "b".repeat(64),
        apnsEnvironment: "sandbox",
        appVersion: "0.1.1",
        buildNumber: "11",
        notificationAuthorization: "provisional",
        installationId,
      }),
    });
    expect(rotated.status).toBe(201);
    const rotatedDevice = await rotated.json<{
      id: string;
      apnsToken: string;
      apnsEnvironment: string;
      appVersion: string;
      buildNumber: string;
      notificationAuthorization: string;
    }>();
    expect(rotatedDevice.id).toBe(firstDevice.id);
    expect(rotatedDevice.apnsToken).toBe("b".repeat(64));
    expect(rotatedDevice.apnsEnvironment).toBe("sandbox");
    expect(rotatedDevice.appVersion).toBe("0.1.1");
    expect(rotatedDevice.buildNumber).toBe("11");
    expect(rotatedDevice.notificationAuthorization).toBe("provisional");
    expect(await repository.listDevices(userPrincipal.userId)).toHaveLength(1);

    const invalidEnvironment = await app.request("/v1/devices", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "iPhone",
        apnsToken: "c".repeat(64),
        apnsEnvironment: "preview",
        appVersion: "0.1.1",
        installationId,
      }),
    });
    expect(invalidEnvironment.status).toBe(400);
  });

  it("upserts a typed live Surface by stable key and exposes only the latest state", async () => {
    const projectId = await createProject();
    await makeHosted(projectId);
    const endpoint = `/v1/projects/${projectId}/surfaces/sales-today`;
    const first = await app.request(endpoint, {
      method: "PUT",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        type: "stats",
        title: "Sales",
        subtitle: "Today",
        metrics: [
          { label: "Revenue", value: "¥2,430", color: "green" },
          { label: "Orders", value: 37, color: "blue" },
        ],
        action: { type: "open_url", title: "Open dashboard", url: "https://example.com/sales" },
      }),
    });
    expect(first.status).toBe(200);
    const firstSurface = await first.json<{ id: string; [key: string]: unknown }>();
    expect(firstSurface).toMatchObject({
      surfaceKey: "sales-today",
      type: "stats",
      version: 1,
      content: { metrics: [{ label: "Revenue", value: "¥2,430" }, { label: "Orders", value: 37 }] },
    });

    const unchanged = await app.request(endpoint, {
      method: "PUT",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        type: "stats",
        title: "Sales",
        subtitle: "Today",
        metrics: [
          { label: "Revenue", value: "¥2,430", color: "green" },
          { label: "Orders", value: 37, color: "blue" },
        ],
        action: { type: "open_url", title: "Open dashboard", url: "https://example.com/sales" },
      }),
    });
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({ id: firstSurface.id, version: 1 });

    const updated = await app.request(endpoint, {
      method: "PUT",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        type: "progress",
        title: "Monthly goal",
        percentage: 68,
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      surfaceKey: "sales-today",
      type: "progress",
      version: 2,
      content: { percentage: 68 },
    });

    const list = await app.request("/v1/surfaces", {
      headers: { authorization: "Bearer test" },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      surfaces: [{
        surfaceKey: "sales-today",
        version: 2,
        project: { id: projectId, name: "VideoSays" },
      }],
    });

    const invalid = await app.request(`/v1/projects/${projectId}/surfaces/bad-progress`, {
      method: "PUT",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ type: "progress", title: "Bad", percentage: 120 }),
    });
    expect(invalid.status).toBe(400);

    const removed = await app.request(endpoint, {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(removed.status).toBe(204);
    expect((await repository.listLiveSurfaces(projectId))).toEqual([]);
  });

  it("treats JSON object key order changes from storage as an unchanged Surface", async () => {
    const projectId = await createProject();
    await makeHosted(projectId);
    const timestamp = "2026-07-23T02:22:20.000Z";
    await repository.saveLiveSurface({
      id: "stored-surface",
      projectId,
      surfaceKey: "revenue-today",
      type: "stats",
      title: "Today · VideoSays",
      subtitle: "Shanghai time",
      content: {
        metrics: [{ color: "orange", label: "CNY", value: "¥8.00" }],
      },
      action: {
        url: "https://videosays.com/admin/orders",
        type: "open_url",
        title: "Open orders",
      },
      displayOrder: 0,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const response = await app.request(`/v1/projects/${projectId}/surfaces/revenue-today`, {
      method: "PUT",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        type: "stats",
        title: "Today · VideoSays",
        subtitle: "Shanghai time",
        metrics: [{ label: "CNY", value: "¥8.00", color: "orange" }],
        action: {
          type: "open_url",
          title: "Open orders",
          url: "https://videosays.com/admin/orders",
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "stored-surface", version: 1 });
  });

  it("keeps project and Surface positions stable across content updates", async () => {
    const firstProjectId = await createProject();
    const secondProjectId = await createProject();
    await makeHosted(firstProjectId);
    await makeHosted(secondProjectId);

    const moveFirstProject = await app.request(`/v1/projects/${firstProjectId}/order`, {
      method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ displayOrder: 20 }),
    });
    expect(moveFirstProject.status).toBe(200);

    const projects = await app.request("/v1/projects", {
      headers: { authorization: "Bearer test" },
    });
    expect((await projects.json<{ projects: Array<{ id: string }> }>()).projects.map(({ id }) => id))
      .toEqual([secondProjectId, firstProjectId]);

    const upsert = async (key: string, value: string) => app.request(
      `/v1/projects/${firstProjectId}/surfaces/${key}`,
      {
        method: "PUT",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          type: "stats",
          title: key,
          metrics: [{ label: "Revenue", value }],
        }),
      },
    );

    expect((await upsert("revenue-today", "¥10")).status).toBe(200);
    expect((await upsert("revenue-30d", "¥300")).status).toBe(200);
    expect((await upsert("revenue-today", "¥20")).status).toBe(200);

    let surfaces = await repository.listLiveSurfaces(firstProjectId);
    expect(surfaces.map(({ surfaceKey }) => surfaceKey))
      .toEqual(["revenue-today", "revenue-30d"]);
    expect(surfaces.map(({ displayOrder }) => displayOrder)).toEqual([0, 1]);

    const moveToday = await app.request(
      `/v1/projects/${firstProjectId}/surfaces/revenue-today/order`,
      {
        method: "PATCH",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({ displayOrder: 20 }),
      },
    );
    expect(moveToday.status).toBe(200);
    surfaces = await repository.listLiveSurfaces(firstProjectId);
    expect(surfaces.map(({ surfaceKey }) => surfaceKey))
      .toEqual(["revenue-30d", "revenue-today"]);
  });

  it("lets a project-scoped Ingest Token update only that project's live Surfaces", async () => {
    const projectId = await createProject();
    const token = await configureProject(projectId);
    const endpoint = `/v1/projects/${projectId}/surfaces/revenue-today`;
    const response = await app.request(endpoint, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "stats",
        title: "Today",
        metrics: [{ label: "Revenue", value: "¥86.00", color: "orange" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectId,
      surfaceKey: "revenue-today",
      version: 1,
      content: { metrics: [{ label: "Revenue", value: "¥86.00" }] },
    });

    const otherProjectId = await createProject();
    await makeHosted(otherProjectId);
    const crossProject = await app.request(`/v1/projects/${otherProjectId}/surfaces/revenue-today`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "stats", title: "Today", metrics: [{ label: "Orders", value: 1 }] }),
    });
    expect(crossProject.status).toBe(401);
    expect((await repository.listLiveSurfaces(otherProjectId))).toEqual([]);
  });

  it("creates a one-time pairing code and exchanges it for an authenticated Agent token", async () => {
    const bindingResponse = await app.request("/v1/device-bindings", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    expect(bindingResponse.status).toBe(201);
    const binding = await bindingResponse.json<{ code: string }>();
    expect(binding.code).toMatch(/^\d{6}$/u);

    const confirm = () =>
      app.request("/v1/device-bindings/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: binding.code, name: "Codex on Mac" }),
      });
    const first = await confirm();
    expect(first.status).toBe(201);
    const token = await first.json<{ token: string }>();
    expect(token.token).toMatch(/^bw_agent_[A-Za-z0-9_-]+$/u);
    const principal = await new PrincipalAuthenticator(repository, {}).authenticate(
      `Bearer ${token.token}`,
    );
    expect(principal).toMatchObject({ kind: "agent", userId: userPrincipal.userId });

    const connections = await app.request("/v1/agent-connections", {
      headers: { authorization: "Bearer test" },
    });
    expect(connections.status).toBe(200);
    const connectionBody = await connections.json<{
      connections: Array<{ id: string; name: string; tokenHash?: string; token?: string }>;
    }>();
    expect(connectionBody.connections).toHaveLength(1);
    expect(connectionBody.connections[0]).toMatchObject({ name: "Codex on Mac" });
    expect(connectionBody.connections[0]).not.toHaveProperty("token");
    expect(connectionBody.connections[0]).not.toHaveProperty("tokenHash");

    const revoke = await app.request(
      `/v1/agent-connections/${connectionBody.connections[0]?.id}`,
      { method: "DELETE", headers: { authorization: "Bearer test" } },
    );
    expect(revoke.status).toBe(204);
    await expect(new PrincipalAuthenticator(repository, {}).authenticate(
      `Bearer ${token.token}`,
    )).rejects.toMatchObject({ status: 401 });
    expect(await (await app.request("/v1/agent-connections", {
      headers: { authorization: "Bearer test" },
    })).json()).toEqual({ connections: [] });
    expect((await confirm()).status).toBe(400);
  });

  it("does not let an Agent enumerate, revoke, or create Agent connections", async () => {
    const agentApp = createApp({
      service: new BellwireService(repository, dispatcher),
      authenticator: new StaticAuthenticator({
        ...userPrincipal,
        kind: "agent",
        tokenId: "agent-token",
      }),
    });

    expect((await agentApp.request("/v1/agent-connections", {
      headers: { authorization: "Bearer agent" },
    })).status).toBe(403);
    expect((await agentApp.request("/v1/agent-connections/agent-token", {
      method: "DELETE",
      headers: { authorization: "Bearer agent" },
    })).status).toBe(403);
    expect((await agentApp.request("/v1/device-bindings", {
      method: "POST",
      headers: { authorization: "Bearer agent" },
    })).status).toBe(403);
    expect((await agentApp.request("/v1/device-keys", {
      method: "POST",
      headers: { authorization: "Bearer agent", "content-type": "application/json" },
      body: JSON.stringify({}),
    })).status).toBe(403);
  });

  it("bootstraps an opaque direct connection without exposing its plaintext manifest", async () => {
    const projectId = await createProject();
    const deviceKeyId = "11111111-1111-4111-8111-111111111111";
    const installationId = "22222222-2222-4222-8222-222222222222";
    const publicKey = btoa(String.fromCharCode(4, ...new Array(64).fill(7)));
    const bindingResponse = await app.request("/v1/device-bindings", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        deviceKey: {
          id: deviceKeyId,
          installationId,
          agreementPublicKey: publicKey,
          signingPublicKey: publicKey,
          algorithm: "p256",
        },
      }),
    });
    expect(bindingResponse.status).toBe(201);
    const binding = await bindingResponse.json<{ code: string }>();
    const confirmation = await app.request("/v1/device-bindings/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: binding.code, name: "Private Agent" }),
    });
    expect(confirmation.status).toBe(201);
    const connected = await confirmation.json<{
      token: string;
      deviceKey: {
        id: string;
        agreementPublicKey: string;
        signingPublicKey: string;
      };
    }>();
    expect(connected.deviceKey).toMatchObject({
      id: deviceKeyId,
      agreementPublicKey: publicKey,
      signingPublicKey: publicKey,
    });

    const agentApp = createApp({
      service: new BellwireService(repository, dispatcher),
      authenticator: new PrincipalAuthenticator(repository, {}),
    });
    const ephemeralPublicKey = btoa(String.fromCharCode(4, ...new Array(64).fill(9)));
    const sealedBox = btoa(String.fromCharCode(...new Array(48).fill(11)));
    const published = await agentApp.request("/v1/direct-connections", {
      method: "POST",
      headers: {
        authorization: `Bearer ${connected.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        manifestVersion: 2,
        deviceKeyId,
        algorithm: "p256-hkdf-sha256-aes-gcm",
        ephemeralPublicKey,
        sealedBox,
      }),
    });
    expect(published.status).toBe(201);
    const envelope = await published.json<{ id: string; userId?: string }>();
    expect(envelope).not.toHaveProperty("userId");
    expect(JSON.stringify(envelope)).not.toContain("videosays.com");

    const pending = await app.request(
      `/v1/direct-connections?deviceKeyId=${deviceKeyId}`,
      { headers: { authorization: "Bearer test" } },
    );
    expect(await pending.json()).toMatchObject({
      envelopes: [{
        id: envelope.id,
        deviceKeyId,
        projectId,
        manifestVersion: 2,
        ephemeralPublicKey,
        sealedBox,
      }],
    });
    expect((await app.request(`/v1/direct-connections/${envelope.id}/ack`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ deviceKeyId }),
    })).status).toBe(200);
    expect(await (await app.request(
      `/v1/direct-connections?deviceKeyId=${deviceKeyId}`,
      { headers: { authorization: "Bearer test" } },
    )).json()).toEqual({ envelopes: [] });

    const recoveryDeviceKeyId = "55555555-5555-4555-8555-555555555555";
    const recoveryPublicKey = btoa(String.fromCharCode(4, ...new Array(64).fill(8)));
    const currentKeyRegistration = await app.request("/v1/device-keys", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        id: recoveryDeviceKeyId,
        installationId,
        agreementPublicKey: recoveryPublicKey,
        signingPublicKey: recoveryPublicKey,
        algorithm: "p256",
      }),
    });
    expect(currentKeyRegistration.status).toBe(201);
    expect(await currentKeyRegistration.json()).toEqual({
      id: recoveryDeviceKeyId,
      installationId,
      agreementPublicKey: recoveryPublicKey,
      signingPublicKey: recoveryPublicKey,
      algorithm: "p256",
    });
    expect(await repository.getDeviceKey(deviceKeyId, userPrincipal.userId)).toBeDefined();

    const recoveryBody = {
      deviceKeyId: recoveryDeviceKeyId,
      installationId,
      appVersion: "1.0.0",
      buildNumber: "11",
      notificationAuthorization: "denied",
    };
    const firstRecovery = await app.request(
      `/v1/projects/${projectId}/direct-connection-recovery`,
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify(recoveryBody),
      },
    );
    expect(firstRecovery.status).toBe(202);
    const recovery = await firstRecovery.json<{
      projectId: string;
      deviceKeyId: string;
      requestedAt: string;
      status: string;
    }>();
    expect(recovery).toMatchObject({
      projectId,
      deviceKeyId: recoveryDeviceKeyId,
      status: "pending",
    });
    expect(recovery).not.toHaveProperty("userId");
    expect(JSON.stringify(recovery)).not.toContain("videosays.com");

    const repeatedRecovery = await app.request(
      `/v1/projects/${projectId}/direct-connection-recovery`,
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify(recoveryBody),
      },
    );
    expect(repeatedRecovery.status).toBe(202);
    expect(await repeatedRecovery.json()).toEqual(recovery);

    const recoveries = await agentApp.request("/v1/direct-connection-recoveries", {
      headers: { authorization: `Bearer ${connected.token}` },
    });
    expect(recoveries.status).toBe(200);
    const recoveriesBody = await recoveries.json();
    expect(recoveriesBody).toEqual({
      requests: [{
        projectId,
        deviceKey: {
          id: recoveryDeviceKeyId,
          installationId,
          agreementPublicKey: recoveryPublicKey,
          signingPublicKey: recoveryPublicKey,
          algorithm: "p256",
        },
        requestedAt: recovery.requestedAt,
      }],
    });
    expect(JSON.stringify(recoveriesBody).includes(deviceKeyId)).toBe(false);

    const recoveredEnvelope = await agentApp.request("/v1/direct-connections", {
      method: "POST",
      headers: {
        authorization: `Bearer ${connected.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        manifestVersion: 2,
        deviceKeyId: recoveryDeviceKeyId,
        algorithm: "p256-hkdf-sha256-aes-gcm",
        ephemeralPublicKey,
        sealedBox,
      }),
    });
    expect(recoveredEnvelope.status).toBe(201);
    expect(await (await agentApp.request("/v1/direct-connection-recoveries", {
      headers: { authorization: `Bearer ${connected.token}` },
    })).json()).toEqual({ requests: [] });

    const wrongInstallation = await app.request(
      `/v1/projects/${projectId}/direct-connection-recovery`,
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          ...recoveryBody,
          installationId: "33333333-3333-4333-8333-333333333333",
        }),
      },
    );
    expect(wrongInstallation.status).toBe(400);

    const unrelatedInstallationId = "33333333-3333-4333-8333-333333333333";
    const unrelatedDeviceKeyId = "66666666-6666-4666-8666-666666666666";
    expect((await app.request("/v1/device-keys", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        id: unrelatedDeviceKeyId,
        installationId: unrelatedInstallationId,
        agreementPublicKey: recoveryPublicKey,
        signingPublicKey: recoveryPublicKey,
        algorithm: "p256",
      }),
    })).status).toBe(201);
    const unrelatedInstallationRecovery = await app.request(
      `/v1/projects/${projectId}/direct-connection-recovery`,
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          ...recoveryBody,
          deviceKeyId: unrelatedDeviceKeyId,
          installationId: unrelatedInstallationId,
        }),
      },
    );
    expect(unrelatedInstallationRecovery.status).toBe(409);
    expect(await unrelatedInstallationRecovery.json()).toMatchObject({
      error: { code: "PRIVATE_READINESS_REQUIRED" },
    });

    const otherUserApp = createApp({
      service: new BellwireService(repository, dispatcher),
      authenticator: new StaticAuthenticator({
        ...userPrincipal,
        userId: "user-two",
      }),
    });
    expect((await otherUserApp.request(
      `/v1/projects/${projectId}/direct-connection-recovery`,
      {
        method: "POST",
        headers: { authorization: "Bearer other", "content-type": "application/json" },
        body: JSON.stringify(recoveryBody),
      },
    )).status).toBe(404);

    for (let recoveryAttempt = 0; recoveryAttempt < 2; recoveryAttempt += 1) {
      expect((await app.request(
        `/v1/projects/${projectId}/direct-connection-recovery`,
        {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify(recoveryBody),
        },
      )).status).toBe(202);
      expect((await agentApp.request("/v1/direct-connections", {
        method: "POST",
        headers: {
          authorization: `Bearer ${connected.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId,
          manifestVersion: 2,
          deviceKeyId: recoveryDeviceKeyId,
          algorithm: "p256-hkdf-sha256-aes-gcm",
          ephemeralPublicKey,
          sealedBox,
        }),
      })).status).toBe(201);
    }
    const rotatedDeviceKeyId = "77777777-7777-4777-8777-777777777777";
    expect((await app.request("/v1/device-keys", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        id: rotatedDeviceKeyId,
        installationId,
        agreementPublicKey: recoveryPublicKey,
        signingPublicKey: recoveryPublicKey,
        algorithm: "p256",
      }),
    })).status).toBe(201);
    const rateLimitedRecovery = await app.request(
      `/v1/projects/${projectId}/direct-connection-recovery`,
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({ ...recoveryBody, deviceKeyId: rotatedDeviceKeyId }),
      },
    );
    expect(rateLimitedRecovery.status).toBe(429);
    expect(await rateLimitedRecovery.json()).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });

    await registerDevice(installationId);
    await makeHosted(projectId);
    const privateModeRequest = await agentApp.request(
      `/v1/projects/${projectId}/delivery-mode-requests`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${connected.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ toMode: "private" }),
      },
    );
    expect(privateModeRequest.status).toBe(201);
    const modeRequest = await privateModeRequest.json<{ id: string }>();

    const hostedWithoutRequest = await createProject();
    await makeHosted(hostedWithoutRequest);
    expect((await agentApp.request("/v1/direct-connections", {
      method: "POST",
      headers: {
        authorization: `Bearer ${connected.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: hostedWithoutRequest,
        manifestVersion: 2,
        deviceKeyId,
        algorithm: "p256-hkdf-sha256-aes-gcm",
        ephemeralPublicKey,
        sealedBox,
      }),
    })).status).toBe(409);

    const replacementEnvelope = await agentApp.request("/v1/direct-connections", {
      method: "POST",
      headers: {
        authorization: `Bearer ${connected.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        manifestVersion: 2,
        deviceKeyId,
        algorithm: "p256-hkdf-sha256-aes-gcm",
        ephemeralPublicKey,
        sealedBox,
      }),
    });
    expect(replacementEnvelope.status).toBe(201);

    const approved = await app.request(
      `/v1/delivery-mode-requests/${modeRequest.id}/approve`,
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(approved.status).toBe(200);
    expect(await repository.getProject(projectId)).toMatchObject({ deliveryMode: "private" });
  });

  it("reports delivery health from the last 24 hours instead of all history", async () => {
    const projectId = await createProject();
    const privateProject = await repository.getProject(projectId);
    if (!privateProject) throw new Error("Project missing");
    await repository.updateProject({ ...privateProject, deliveryMode: "hosted" });
    await repository.acceptHostedEvent({
      id: "health-event",
      projectId,
      eventType: "health.check",
      idempotencyKeyHash: await hashSecret("health-event"),
      data: {},
      sensitiveFields: [],
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      status: "accepted",
    }, "disabled");
    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString();
    await repository.createDeliveryIfAbsent({
      id: "old-failure",
      eventId: "health-event",
      deviceId: "device-old",
      channel: "apns",
      status: "failed",
      attemptCount: 3,
      queuedAt: oldTimestamp,
      updatedAt: oldTimestamp,
    });
    const recentTimestamp = new Date().toISOString();
    await repository.createDeliveryIfAbsent({
      id: "recent-accepted",
      eventId: "health-event",
      deviceId: "device-current",
      channel: "apns",
      status: "accepted_by_apns",
      attemptCount: 1,
      queuedAt: recentTimestamp,
      sentAt: recentTimestamp,
      updatedAt: recentTimestamp,
    });

    const response = await app.request(`/v1/projects/${projectId}/delivery-health`, {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      queued: 0,
      accepted: 1,
      failed: 0,
      status: "healthy",
    });
  });

  it("atomically exchanges a pairing code only once under concurrent confirmation", async () => {
    const bindingResponse = await app.request("/v1/device-bindings", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    const binding = await bindingResponse.json<{ code: string }>();
    const confirm = () => app.request("/v1/device-bindings/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      body: JSON.stringify({ code: binding.code, name: "Concurrent Codex" }),
    });

    const responses = await Promise.all([confirm(), confirm()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400]);
    const successful = responses.find((response) => response.status === 201);
    const issued = await successful?.json<{ token: string }>();
    await expect(new PrincipalAuthenticator(repository, {}).authenticate(
      `Bearer ${issued?.token}`,
    )).resolves.toMatchObject({ userId: userPrincipal.userId });
  });

  it("does not consume a valid binding when transactional token storage fails", async () => {
    const code = "654321";
    const now = new Date();
    await repository.saveDeviceBinding({
      id: "binding-token-conflict",
      userId: userPrincipal.userId,
      codeHash: await hashSecret(code),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      createdAt: now.toISOString(),
    });
    const conflictingToken = {
      id: "existing-token",
      userId: userPrincipal.userId,
      name: "Existing",
      tokenHash: "a".repeat(64),
      scopes: ["project:read" as const],
      createdAt: now.toISOString(),
    };
    await repository.saveAgentToken(conflictingToken);

    await expect(repository.claimDeviceBinding(await hashSecret(code), {
      id: conflictingToken.id,
      name: conflictingToken.name,
      tokenHash: conflictingToken.tokenHash,
      scopes: conflictingToken.scopes,
      createdAt: conflictingToken.createdAt,
    }, now.toISOString())).rejects.toThrow("Agent token conflict");

    const confirmed = await app.request("/v1/device-bindings/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" },
      body: JSON.stringify({ code }),
    });
    expect(confirmed.status).toBe(201);
  });

  it("rate limits pairing-code guesses by code and IP without consuming another valid code", async () => {
    const bindingResponse = await app.request("/v1/device-bindings", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    const binding = await bindingResponse.json<{ code: string }>();
    const wrongCode = binding.code === "000000" ? "000001" : "000000";
    const request = (code: string, ip = "203.0.113.20") =>
      app.request("/v1/device-bindings/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ code }),
      });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request(wrongCode)).status).toBe(400);
    }
    const codeLimited = await request(wrongCode);
    expect(codeLimited.status).toBe(429);
    expect(await codeLimited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect((await request(binding.code)).status).toBe(201);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = String(100000 + attempt).padStart(6, "0");
      expect((await request(code, "203.0.113.30")).status).toBe(400);
    }
    expect((await request("200000", "203.0.113.30")).status).toBe(429);
  });

  it("accepts a valid event and exposes it through authenticated history and detail", async () => {
    const projectId = await createProject();
    const token = await configureProject(projectId);
    await registerDevice();
    const ingestResponse = await app.request(`/v1/events/${projectId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "payment-ord_123",
      },
      body: JSON.stringify(validEvent),
    });
    expect(ingestResponse.status).toBe(201);
    const accepted = await ingestResponse.json<{ eventId: string; deduplicated: boolean }>();
    expect(accepted.deduplicated).toBe(false);
    expect(dispatcher.eventIds).toEqual([accepted.eventId]);

    const listResponse = await app.request(`/v1/projects/${projectId}/events`, {
      headers: { authorization: "Bearer test" },
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json<{
      events: Array<{ id: string; data: Record<string, unknown>; sensitiveFields: string[] }>;
    }>();
    expect(list.events.map((event) => event.id)).toEqual([accepted.eventId]);
    expect(list.events[0]).toMatchObject({
      data: { orderId: "ord_123", amount: 28, currency: "CNY" },
      sensitiveFields: ["customer"],
    });
    expect(JSON.stringify(list)).not.toContain("Ada Secret");

    const inboxResponse = await app.request("/v1/inbox", {
      headers: { authorization: "Bearer test" },
    });
    expect(inboxResponse.status).toBe(200);
    const inbox = await inboxResponse.json();
    expect(inbox).toMatchObject({ events: [{ sensitiveFields: ["customer"] }] });
    expect(JSON.stringify(inbox)).not.toContain("Ada Secret");

    const detailResponse = await app.request(`/v1/events/${accepted.eventId}`, {
      headers: { authorization: "Bearer test" },
    });
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      id: accepted.eventId,
      projectId,
      data: validEvent.data,
      sensitiveFields: ["customer"],
      project: { name: "VideoSays" },
    });
  });

  it("marks every unread event in the authenticated inbox as read in one request", async () => {
    const projectId = await createProject();
    const token = await configureProject(projectId);
    for (const key of ["read-all-1", "read-all-2"]) {
      const response = await app.request(`/v1/events/${projectId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(validEvent),
      });
      expect(response.status).toBe(201);
    }

    const markAll = await app.request("/v1/inbox/read-all", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    expect(markAll.status).toBe(200);
    const result = await markAll.json<{ readAt: string; updatedCount: number }>();
    expect(result.updatedCount).toBe(2);
    expect(result.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    const page = await repository.listEvents(projectId, { limit: 10 });
    expect(page.events).toHaveLength(2);
    expect(page.events.every((event) => event.readAt === result.readAt)).toBe(true);

    const repeated = await app.request("/v1/inbox/read-all", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    expect(await repeated.json()).toMatchObject({ updatedCount: 0 });
  });

  it("keeps the event's sensitive-field snapshot after a later schema relaxes classification", async () => {
    const projectId = await createProject();
    const token = await configureProject(projectId);
    const ingest = await app.request(`/v1/events/${projectId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "immutable-sensitive-snapshot",
      },
      body: JSON.stringify(validEvent),
    });
    const accepted = await ingest.json<{ eventId: string }>();

    const relaxedSchema = await app.request(`/v1/projects/${projectId}/event-schemas`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        ...eventSchema,
        fields: {
          ...eventSchema.fields,
          customer: { type: "string" },
        },
      }),
    });
    expect(relaxedSchema.status).toBe(201);

    const list = await app.request(`/v1/projects/${projectId}/events`, {
      headers: { authorization: "Bearer test" },
    });
    const listBody = await list.json<{
      events: Array<{ data: Record<string, unknown>; sensitiveFields: string[] }>;
    }>();
    expect(listBody.events[0]).toMatchObject({ sensitiveFields: ["customer"] });
    expect(JSON.stringify(listBody)).not.toContain("Ada Secret");

    const detail = await app.request(`/v1/events/${accepted.eventId}`, {
      headers: { authorization: "Bearer test" },
    });
    expect(await detail.json()).toMatchObject({ sensitiveFields: ["customer"] });
  });

  it("fails closed when reading a legacy event without a sensitive-field snapshot", async () => {
    const projectId = await createProject();
    const privateProject = await repository.getProject(projectId);
    if (!privateProject) throw new Error("Project missing");
    await repository.updateProject({ ...privateProject, deliveryMode: "hosted" });
    await repository.acceptHostedEvent({
      id: "legacy-event",
      projectId,
      eventType: "legacy.received",
      idempotencyKeyHash: await hashSecret("legacy-event"),
      data: { publicAtTheTime: "unknown", secret: "must stay hidden" },
      occurredAt: "2026-07-19T10:00:00.000Z",
      receivedAt: "2026-07-19T10:00:00.000Z",
      status: "accepted",
    }, "disabled");

    const list = await app.request(`/v1/projects/${projectId}/events`, {
      headers: { authorization: "Bearer test" },
    });
    expect(await list.json()).toMatchObject({
      events: [{ data: {}, sensitiveFields: ["publicAtTheTime", "secret"] }],
    });

    const detail = await app.request("/v1/events/legacy-event", {
      headers: { authorization: "Bearer test" },
    });
    expect(await detail.json()).toMatchObject({
      sensitiveFields: ["publicAtTheTime", "secret"],
    });
  });

  it("uses the latest notification Surface version even when it is disabled", async () => {
    const projectId = await createProject();
    await configureProject(projectId);
    const createSurface = (enabled: boolean) =>
      app.request(`/v1/projects/${projectId}/notification-surfaces`, {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          eventType: "payment.success",
          title: "Payment received",
          body: "{{ currency }} {{ amount }}",
          enabled,
        }),
      });

    const disabled = await createSurface(false);
    expect(disabled.status).toBe(201);
    expect(await disabled.json()).toMatchObject({ enabled: false, version: 2 });
    expect(await repository.getNotificationSurface(projectId, "payment.success"))
      .toMatchObject({ enabled: false, version: 2 });
    expect(await repository.listNotificationSurfaces(projectId)).toEqual([]);

    const reenabled = await createSurface(true);
    expect(reenabled.status).toBe(201);
    expect(await reenabled.json()).toMatchObject({ enabled: true, version: 3 });
  });

  it("rejects an invalid bearer token", async () => {
    const projectId = await createProject();
    await configureProject(projectId);
    const response = await app.request(`/v1/events/${projectId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer bw_live_invalid",
        "content-type": "application/json",
        "idempotency-key": "bad-token-attempt",
      },
      body: JSON.stringify(validEvent),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_TOKEN" } });
  });

  it("rejects data that violates or exceeds the active schema", async () => {
    const projectId = await createProject();
    const token = await configureProject(projectId);
    const response = await app.request(`/v1/events/${projectId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "invalid-payload",
      },
      body: JSON.stringify({
        ...validEvent,
        data: { orderId: "ord_123", amount: "28", currency: "EUR", extra: true },
      }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: "SCHEMA_VALIDATION_FAILED",
        details: expect.arrayContaining([
          expect.objectContaining({ field: "amount" }),
          expect.objectContaining({ field: "currency" }),
          expect.objectContaining({ field: "extra" }),
        ]),
      },
    });
  });

  it("deduplicates storage and downstream delivery by event ID", async () => {
    const projectId = await createProject();
    const token = await configureProject(projectId);
    await registerDevice();
    const request = () =>
      app.request(`/v1/events/${projectId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": "payment-ord_123",
        },
        body: JSON.stringify(validEvent),
      });
    const first = await request();
    const firstBody = await first.json<{ eventId: string }>();
    const duplicate = await request();
    const duplicateBody = await duplicate.json<{ eventId: string; deduplicated: boolean }>();
    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(200);
    expect(duplicateBody).toMatchObject({ eventId: firstBody.eventId, deduplicated: true });
    expect((await repository.listEvents(projectId, { limit: 100 })).events).toHaveLength(1);
    expect(new Set(dispatcher.eventIds)).toEqual(new Set([firstBody.eventId]));
  });

  it("prevents one user from reading another user's project", async () => {
    const projectId = await createProject();
    const otherApp = createApp({
      service: new BellwireService(repository),
      authenticator: new StaticAuthenticator({ ...userPrincipal, userId: "user-two" }),
    });
    const response = await otherApp.request(`/v1/projects/${projectId}`, {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(404);
  });

  it("does not let templates expose sensitive fields", async () => {
    const projectId = await createProject();
    await makeHosted(projectId);
    const schemaResponse = await app.request(`/v1/projects/${projectId}/event-schemas`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ ...eventSchema, notification: undefined }),
    });
    expect(schemaResponse.status).toBe(201);
    const response = await app.request(`/v1/projects/${projectId}/notification-surfaces`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({
        eventType: "payment.success",
        title: "Payment received",
        body: "Customer {{ customer }}",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects paused-project events without dispatching a notification", async () => {
    const projectId = await createProject();
    const token = await configureProject(projectId);
    await registerDevice();
    const pause = await app.request(`/v1/projects/${projectId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(pause.status).toBe(200);
    const response = await app.request(`/v1/events/${projectId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "paused-event",
      },
      body: JSON.stringify(validEvent),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "PROJECT_PAUSED" } });
    expect(dispatcher.eventIds).toHaveLength(0);
  });

  it("keeps an accepted event durable and records degradation when the queue is unavailable", async () => {
    const projectId = await createProject();
    const token = await configureProject(projectId);
    await registerDevice();
    const failingApp = createApp({
      service: new BellwireService(repository, new FailingDispatcher()),
      authenticator: new StaticAuthenticator(userPrincipal),
    });
    const response = await failingApp.request(`/v1/events/${projectId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "queue-unavailable",
      },
      body: JSON.stringify(validEvent),
    });

    expect(response.status).toBe(201);
    const accepted = await response.json<{ eventId: string; deliveryQueued: boolean }>();
    expect(accepted.deliveryQueued).toBe(false);
    expect(await repository.getEvent(accepted.eventId)).toBeDefined();
    expect(await repository.listDeliveries(accepted.eventId)).toMatchObject([{
      status: "failed",
      errorCode: "retryable:QueueUnavailable",
    }]);
  });

  it("exports Hosted Event and delivery records only for a server-authoritative Pro account", async () => {
    const projectId = await createProject();
    await makeHosted(projectId);
    const eventId = "55555555-5555-4555-8555-555555555555";
    const occurredAt = new Date().toISOString();
    await repository.acceptHostedEvent({
      id: eventId,
      projectId,
      eventType: "payment.success",
      idempotencyKeyHash: await hashSecret("export-event"),
      data: { amount: 28 },
      sensitiveFields: [],
      occurredAt,
      receivedAt: occurredAt,
      status: "accepted",
    }, "disabled");
    await repository.createDeliveryIfAbsent({
      id: "66666666-6666-4666-8666-666666666666",
      eventId,
      deviceId: "77777777-7777-4777-8777-777777777777",
      channel: "apns",
      status: "accepted_by_apns",
      attemptCount: 1,
      queuedAt: occurredAt,
      sentAt: occurredAt,
      updatedAt: occurredAt,
    });

    expect((await app.request(`/v1/projects/${projectId}/export`, {
      headers: { authorization: "Bearer test" },
    })).status).toBe(409);

    await repository.saveAppleTransaction({
      transactionId: "transaction-export",
      originalTransactionId: "original-export",
      userId: userPrincipal.userId,
      productId: "app.bellwire.pro.monthly",
      environment: "Sandbox",
      purchaseDate: occurredAt,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      status: "active",
      signedDate: occurredAt,
      updatedAt: occurredAt,
    });
    const response = await app.request(`/v1/projects/${projectId}/export`, {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 1,
      project: { id: projectId, deliveryMode: "hosted" },
      events: [{
        id: eventId,
        data: { amount: 28 },
        deliveries: [{ status: "accepted_by_apns", attemptCount: 1 }],
      }],
    });
  });
});
