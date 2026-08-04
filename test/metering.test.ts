// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { LiveSurface, Principal, Project } from "../src/domain/models";
import { InMemoryBellwireRepository } from "../src/repositories/in-memory-bellwire-repository";
import { BellwireService, ServiceError } from "../src/services/bellwire-service";

const user: Principal = {
  kind: "user",
  userId: "11111111-1111-4111-8111-111111111111",
  scopes: ["project:read", "project:write", "config:read", "config:write", "event:test"],
};

describe("plan enforcement and atomic Signal semantics", () => {
  it("accepts the Free courtesy buffer, rejects the next unique Signal, and never charges a replay", async () => {
    const repository = new InMemoryBellwireRepository();
    const project = await repository.createProject(privateProject());
    const first = privateWake(project, 0, "2026-07-25T10:00:00.000Z");
    expect(await repository.acceptPrivateWake(first, "enforce")).toMatchObject({
      created: true,
      acceptedSignals: 1,
      signalLimit: 5_000,
      courtesyLimit: 5_500,
    });

    for (let index = 1; index < 5_500; index += 1) {
      const result = await repository.acceptPrivateWake(
        privateWake(project, index, "2026-07-25T10:00:00.000Z"),
        "enforce",
      );
      if (index === 4_999) {
        expect(result).toMatchObject({ created: true, acceptedSignals: 5_000 });
      }
    }

    expect(await repository.acceptPrivateWake(
      privateWake(project, 5_500, "2026-07-25T10:00:00.000Z"),
      "enforce",
    )).toMatchObject({
      created: false,
      quotaExceeded: true,
      acceptedSignals: 5_500,
    });
    expect(await repository.acceptPrivateWake(first, "enforce")).toMatchObject({
      wake: { id: first.id },
      created: false,
      quotaExceeded: false,
      acceptedSignals: 5_500,
    });
    expect(await repository.acceptPrivateWake(
      privateWake(project, 5_501, "2026-08-01T00:00:00.000Z"),
      "enforce",
    )).toMatchObject({
      created: true,
      acceptedSignals: 1,
      quotaExceeded: false,
      resetAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("does not meter a no-op Surface and enforces the Free per-project Surface cap", async () => {
    const repository = new InMemoryBellwireRepository();
    const project = await repository.createProject({
      ...privateProject(),
      deliveryMode: "hosted",
    });
    const first = surface(project, "revenue", 1);
    expect(await repository.acceptHostedSurface(first, "enforce")).toMatchObject({
      created: true,
      acceptedSignals: 1,
      surfaceLimitExceeded: false,
    });
    expect(await repository.acceptHostedSurface(first, "enforce")).toMatchObject({
      created: false,
      acceptedSignals: 1,
      surfaceLimitExceeded: false,
    });
    for (const [key, order] of [["orders", 2], ["refunds", 3]] as const) {
      expect(await repository.acceptHostedSurface(
        surface(project, key, order),
        "enforce",
      )).toMatchObject({
        created: true,
        surfaceLimitExceeded: false,
      });
    }
    expect(await repository.acceptHostedSurface(
      surface(project, "customers", 4),
      "enforce",
    )).toMatchObject({
      created: false,
      acceptedSignals: 3,
      surfaceLimitExceeded: true,
    });
  });

  it("does not impose a per-project Surface cap on Pro", async () => {
    const repository = new InMemoryBellwireRepository();
    const now = "2026-07-25T10:00:00.000Z";
    await repository.saveAppleTransaction({
      transactionId: "pro-surfaces-transaction",
      originalTransactionId: "pro-surfaces-original",
      userId: user.userId,
      productId: "app.bellwire.pro.monthly",
      environment: "Sandbox",
      purchaseDate: now,
      expiresAt: "2026-08-25T10:00:00.000Z",
      status: "active",
      signedDate: now,
      updatedAt: now,
    });
    const project = await repository.createProject({
      ...privateProject(),
      deliveryMode: "hosted",
    });

    expect(await repository.getAccountEntitlement(user.userId, now)).toMatchObject({
      limits: { activeProjects: 20, surfacesPerProject: null },
    });
    for (let index = 1; index <= 25; index += 1) {
      await expect(repository.acceptHostedSurface(
        surface(project, `surface-${index}`, index),
        "enforce",
      )).resolves.toMatchObject({ created: true, surfaceLimitExceeded: false });
    }
  });

  it("applies the Pro 50,000 Signal limit and accepts only its 10% courtesy buffer", async () => {
    const repository = new InMemoryBellwireRepository();
    const project = await repository.createProject(privateProject());
    const now = "2026-07-25T10:00:00.000Z";
    await repository.saveAppleTransaction({
      transactionId: "pro-metering-transaction",
      originalTransactionId: "pro-metering-original",
      userId: user.userId,
      productId: "app.bellwire.pro.yearly",
      environment: "Sandbox",
      purchaseDate: now,
      expiresAt: "2027-07-25T10:00:00.000Z",
      status: "active",
      signedDate: now,
      updatedAt: now,
    });
    for (let index = 0; index < 55_000; index += 1) {
      const result = await repository.acceptPrivateWake(
        privateWake(project, index, now),
        "enforce",
      );
      if (index === 49_999) {
        expect(result).toMatchObject({
          created: true,
          acceptedSignals: 50_000,
          signalLimit: 50_000,
        });
      }
    }
    expect(await repository.acceptPrivateWake(
      privateWake(project, 55_000, now),
      "enforce",
    )).toMatchObject({
      created: false,
      quotaExceeded: true,
      acceptedSignals: 55_000,
      courtesyLimit: 55_000,
    });
  });

  it("enforces Free project and device capacity in the service but not in self-host mode", async () => {
    const repository = new InMemoryBellwireRepository();
    const cloud = new BellwireService(repository, undefined, undefined, "enforce");
    await cloud.createProject(user, { name: "One" });
    await expect(cloud.createProject(user, { name: "Two" })).rejects.toMatchObject({
      code: "PLAN_LIMIT_REACHED",
      status: 409,
    } satisfies Partial<ServiceError>);

    expect(await repository.getAccountEntitlement(
      user.userId,
      "2026-07-25T10:00:00.000Z",
    )).toMatchObject({ limits: { activeProjects: 1, surfacesPerProject: 3 } });

    await cloud.registerDevice(user, device("aaaaaaaa"));
    await expect(cloud.registerDevice(user, device("bbbbbbbb"))).rejects.toMatchObject({
      code: "PLAN_LIMIT_REACHED",
      status: 409,
    } satisfies Partial<ServiceError>);

    const selfHosted = new BellwireService(repository, undefined, undefined, "disabled");
    await expect(selfHosted.createProject(user, { name: "Self-hosted extra" })).resolves
      .toMatchObject({ deliveryMode: "private" });
    await expect(selfHosted.registerDevice(user, device("cccccccc"))).resolves
      .toMatchObject({ pushEnabled: true });
  });

  it("allows exactly 20 active projects and 3 push devices for Pro", async () => {
    const repository = new InMemoryBellwireRepository();
    const service = new BellwireService(repository, undefined, undefined, "enforce");
    const now = "2026-07-25T10:00:00.000Z";
    await repository.saveAppleTransaction({
      transactionId: "pro-capacity-transaction",
      originalTransactionId: "pro-capacity-original",
      userId: user.userId,
      productId: "app.bellwire.pro.monthly",
      environment: "Sandbox",
      purchaseDate: now,
      expiresAt: "2026-08-25T10:00:00.000Z",
      status: "active",
      signedDate: now,
      updatedAt: now,
    });
    for (let index = 1; index <= 20; index += 1) {
      await expect(service.createProject(user, { name: `Project ${index}` })).resolves
        .toMatchObject({ status: "active" });
    }
    await expect(service.createProject(user, { name: "Project 21" })).rejects
      .toMatchObject({ code: "PLAN_LIMIT_REACHED", status: 409 });

    for (const seed of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) {
      await expect(service.registerDevice(user, device(seed))).resolves
        .toMatchObject({ pushEnabled: true });
    }
    await expect(service.registerDevice(user, device("dddddddd"))).rejects
      .toMatchObject({ code: "PLAN_LIMIT_REACHED", status: 409 });
  });
});

function privateProject(): Project {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    userId: user.userId,
    name: "Private",
    slug: "private",
    icon: "lock",
    displayOrder: 0,
    category: "automation",
    status: "active",
    deliveryMode: "private",
    endpoint: "/v1/events/22222222-2222-4222-8222-222222222222",
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-25T10:00:00.000Z",
  };
}

function privateWake(project: Project, index: number, receivedAt: string) {
  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    idempotencyKeyHash: index.toString(16).padStart(64, "0"),
    reference: index.toString(36).padStart(22, "a"),
    priority: "normal" as const,
    receivedAt,
    referenceExpiresAt: new Date(Date.parse(receivedAt) + 86_400_000).toISOString(),
  };
}

function surface(project: Project, key: string, order: number): LiveSurface {
  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    surfaceKey: key,
    type: "stats",
    title: key,
    content: { metrics: [{ label: key, value: order }] },
    displayOrder: order,
    version: 1,
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-25T10:00:00.000Z",
  };
}

function device(seed: string) {
  return {
    installationId: `${seed.slice(0, 8)}-1111-4111-8111-111111111111`,
    name: `iPhone ${seed}`,
    apnsToken: seed.repeat(8),
    apnsEnvironment: "sandbox",
    pushEnabled: true,
  };
}
