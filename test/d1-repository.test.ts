// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AppleTransactionRecord,
  BellwireEvent,
  Delivery,
  Device,
  LiveSurface,
  Project,
} from "../src/domain/models";
import { D1BellwireRepository } from "../src/repositories/d1-bellwire-repository";

let miniflare: Miniflare;
let repository: D1BellwireRepository;

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: crypto.randomUUID() },
  });
  const database = await miniflare.getD1Database("DB");
  await database.exec(readFileSync(resolve("d1/business/0001_bellwire.sql"), "utf8")
    .replace(/^--.*$/gmu, "")
    .replace(/\s+/gu, " "));
  repository = new D1BellwireRepository(database as unknown as D1Database);
});

afterEach(async () => {
  await miniflare.dispose();
});

describe("D1BellwireRepository", () => {
  it("persists ownership, uniqueness, versioning, metering, and delivery claims", async () => {
    const project = hostedProject();
    await expect(repository.createProject(project)).resolves.toEqual(project);
    await expect(repository.createProject({ ...project, id: "project-2" }))
      .rejects.toThrow("Project slug already exists");

    const schema = await repository.saveEventSchema({
      id: "schema-1",
      projectId: project.id,
      eventType: "build.completed",
      fields: { branch: { type: "string", required: true } },
      version: 99,
      status: "active",
      createdAt: "2026-08-07T10:00:00.000Z",
    });
    const schemaV2 = await repository.saveEventSchema({
      ...schema,
      id: "schema-2",
      fields: { branch: { type: "string" } },
    });
    expect(schemaV2.version).toBe(2);
    await expect(repository.getEventSchema(project.id, schema.eventType))
      .resolves.toEqual(schemaV2);

    const event = hostedEvent(project.id);
    await expect(repository.acceptHostedEvent(event, "enforce")).resolves.toMatchObject({
      created: true,
      acceptedSignals: 1,
    });
    await expect(repository.acceptHostedEvent(event, "enforce")).resolves.toMatchObject({
      created: false,
      quotaExceeded: false,
      acceptedSignals: 1,
    });
    await expect(repository.listEvents(project.id, { limit: 20, unreadOnly: true }))
      .resolves.toMatchObject({ events: [{ id: event.id }] });
    await expect(repository.markAllEventsRead([project.id], "2026-08-07T10:00:03.000Z"))
      .resolves.toBe(1);
    await expect(repository.listEvents(project.id, { limit: 20, unreadOnly: true }))
      .resolves.toMatchObject({ events: [] });

    const delivery = queuedDelivery(event.id);
    await expect(repository.createDeliveryIfAbsent(delivery)).resolves.toMatchObject({
      created: true,
    });
    const claimed = await repository.claimDelivery(
      delivery.id,
      "2026-08-07T10:01:00.000Z",
      30,
      3,
    );
    expect(claimed).toMatchObject({ attemptCount: 1, status: "queued" });
    if (!claimed) throw new Error("Expected delivery claim");
    const completed = { ...claimed, status: "accepted_by_apns" as const };
    await expect(repository.completeClaimedDelivery(completed)).resolves.toEqual(completed);
    await expect(repository.completeClaimedDelivery(completed)).resolves.toBeUndefined();

    await expect(repository.getAccountEntitlement(project.userId, event.receivedAt))
      .resolves.toMatchObject({ usage: { acceptedSignals: 1 }, activeProjects: 1 });
    await repository.deleteProject(project.id);
    await expect(repository.listDeliveries(event.id)).resolves.toEqual([]);
  });

  it("atomically consumes a device binding once", async () => {
    await repository.saveDeviceBinding({
      id: "binding-1",
      userId: "user-1",
      codeHash: "code-hash",
      expiresAt: "2026-08-08T00:00:00.000Z",
      createdAt: "2026-08-07T00:00:00.000Z",
    });
    const token = {
      id: "token-1",
      name: "Mac",
      tokenHash: "token-hash",
      scopes: ["project:read" as const],
      createdAt: "2026-08-07T00:01:00.000Z",
    };
    await expect(repository.claimDeviceBinding(
      "code-hash",
      token,
      "2026-08-07T00:01:00.000Z",
    )).resolves.toMatchObject({ id: token.id, userId: "user-1" });
    await expect(repository.claimDeviceBinding(
      "code-hash",
      { ...token, id: "token-2", tokenHash: "token-hash-2" },
      "2026-08-07T00:02:00.000Z",
    )).resolves.toBeUndefined();
  });

  it("versions recurring Surface content and releases its acceptance ledger on deletion", async () => {
    const project = hostedProject();
    await repository.createProject(project);
    const first = liveSurface(project.id, "Healthy", "2026-08-07T10:00:00.000Z");
    const second = liveSurface(project.id, "Degraded", "2026-08-07T10:01:00.000Z");
    const recurring = liveSurface(project.id, "Healthy", "2026-08-07T10:02:00.000Z");

    await expect(repository.acceptHostedSurface(first, "enforce"))
      .resolves.toMatchObject({ created: true, surface: { version: 1 } });
    await expect(repository.acceptHostedSurface(second, "enforce"))
      .resolves.toMatchObject({ created: true, surface: { version: 2 } });
    await expect(repository.acceptHostedSurface(recurring, "enforce"))
      .resolves.toMatchObject({ created: true, surface: { version: 3 } });

    const concurrent = await Promise.all([
      repository.acceptHostedSurface(
        liveSurface(project.id, "Recovered", "2026-08-07T10:03:00.000Z"),
        "enforce",
      ),
      repository.acceptHostedSurface(
        liveSurface(project.id, "Recovered", "2026-08-07T10:03:00.000Z"),
        "enforce",
      ),
    ]);
    expect(concurrent.filter((result) => result.created)).toHaveLength(1);
    await expect(repository.getLiveSurface(project.id, "build"))
      .resolves.toMatchObject({ title: "Recovered", version: 4 });

    await repository.deleteLiveSurface(first.id);
    await expect(repository.acceptHostedSurface(first, "enforce"))
      .resolves.toMatchObject({ created: true, surface: { version: 1 } });
  });

  it("recreates Supabase retention, downgrade, and device cascade semantics", async () => {
    const project = {
      ...hostedProject(),
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const newerProject = {
      ...project,
      id: "project-2",
      slug: "newer",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    await repository.createProject(project);
    await repository.createProject(newerProject);
    const event = {
      ...hostedEvent(project.id),
      receivedAt: "2026-07-01T00:00:00.000Z",
    };
    await repository.acceptHostedEvent(event, "enforce");
    await repository.createDeliveryIfAbsent(queuedDelivery(event.id));

    const olderDevice = device("device-1", "install-1", "a".repeat(64), "2026-07-01T00:00:00.000Z");
    const newerDevice = device("device-2", "install-2", "b".repeat(64), "2026-08-01T00:00:00.000Z");
    await repository.saveDevice(olderDevice);
    await repository.saveDevice(newerDevice);
    await repository.saveAppleTransaction(expiredTransaction());

    await repository.runMaintenance("2026-08-20T00:00:00.000Z");

    await expect(repository.getEvent(event.id)).resolves.toBeUndefined();
    await expect(repository.listDeliveries(event.id)).resolves.toEqual([]);
    await expect(repository.listProjects(project.userId)).resolves.toMatchObject([
      { id: project.id, status: "paused" },
      { id: newerProject.id, status: "active" },
    ]);
    await expect(repository.listDevices(project.userId)).resolves.toMatchObject([
      { id: newerDevice.id, pushEnabled: true },
      { id: olderDevice.id, pushEnabled: false },
    ]);
    await expect(repository.getAccountEntitlement(project.userId, "2026-08-20T00:00:00.000Z"))
      .resolves.toMatchObject({
        plan: "free",
        status: "expired",
        downgradeDeadline: "2026-08-08T00:00:00.000Z",
      });

    const currentEvent = {
      ...hostedEvent(newerProject.id),
      id: "event-2",
      idempotencyKeyHash: "idem-2",
      receivedAt: "2026-08-20T00:01:00.000Z",
    };
    await repository.acceptHostedEvent(currentEvent, "enforce");
    await repository.createDeliveryIfAbsent({
      ...queuedDelivery(currentEvent.id),
      id: "delivery-2",
      deviceId: newerDevice.id,
    });
    await repository.deleteDevice(newerDevice.id);
    await expect(repository.listDevices(project.userId)).resolves.toHaveLength(1);
    await expect(repository.listDeliveries(currentEvent.id)).resolves.toEqual([]);
  });
});

function hostedProject(): Project {
  return {
    id: "project-1",
    userId: "user-1",
    name: "Builds",
    slug: "builds",
    icon: "hammer",
    displayOrder: 0,
    category: "engineering",
    status: "active",
    deliveryMode: "hosted",
    endpoint: "https://api.bellwire.app/v1/ingest/project-1",
    createdAt: "2026-08-07T09:00:00.000Z",
    updatedAt: "2026-08-07T09:00:00.000Z",
  };
}

function hostedEvent(projectId: string): BellwireEvent {
  return {
    id: "event-1",
    projectId,
    eventType: "build.completed",
    idempotencyKeyHash: "idem-1",
    data: { branch: "main" },
    occurredAt: "2026-08-07T10:00:00.000Z",
    receivedAt: "2026-08-07T10:00:01.000Z",
    status: "accepted",
  };
}

function queuedDelivery(eventId: string): Delivery {
  return {
    id: "delivery-1",
    eventId,
    deviceId: "device-1",
    channel: "apns",
    status: "queued",
    attemptCount: 0,
    queuedAt: "2026-08-07T10:00:02.000Z",
    updatedAt: "2026-08-07T10:00:02.000Z",
  };
}

function liveSurface(projectId: string, title: string, updatedAt: string): LiveSurface {
  return {
    id: "surface-1",
    projectId,
    surfaceKey: "build",
    type: "status",
    title,
    content: { state: title.toLowerCase() },
    displayOrder: 0,
    version: 0,
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt,
  };
}

function device(
  id: string,
  installationId: string,
  apnsToken: string,
  lastActiveAt: string,
): Device {
  return {
    id,
    userId: "user-1",
    installationId,
    name: id,
    platform: "ios",
    apnsToken,
    apnsEnvironment: "sandbox",
    lastActiveAt,
    pushEnabled: true,
    createdAt: lastActiveAt,
  };
}

function expiredTransaction(): AppleTransactionRecord {
  return {
    transactionId: "transaction-1",
    originalTransactionId: "original-1",
    userId: "user-1",
    productId: "app.bellwire.pro.monthly",
    environment: "Sandbox",
    purchaseDate: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
    status: "expired",
    signedDate: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}
