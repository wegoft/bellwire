// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type {
  ApnsLiveActivityNotification,
} from "../src/services/apns-client";
import { InMemoryBellwireRepository } from "../src/repositories/in-memory-bellwire-repository";
import { LiveActivityProcessor } from "../src/services/live-activity-processor";

const now = "2026-08-07T12:00:00.000Z";

describe("Agent Live Activity lifecycle", () => {
  it("starts once, coalesces versions, and ends a registered Hosted activity", async () => {
    const repository = new InMemoryBellwireRepository();
    await repository.createProject({
      id: "project-1",
      userId: "user-1",
      name: "Deploy Agent",
      slug: "deploy-agent",
      icon: "shippingbox.fill",
      displayOrder: 0,
      category: "automation",
      status: "active",
      deliveryMode: "hosted",
      endpoint: "/v1/events/project-1",
      createdAt: now,
      updatedAt: now,
    });
    await repository.saveDevice({
      id: "device-1",
      userId: "user-1",
      installationId: "11111111-1111-4111-8111-111111111111",
      name: "iPhone",
      platform: "ios",
      apnsToken: "a".repeat(64),
      apnsEnvironment: "sandbox",
      lastActiveAt: now,
      pushEnabled: true,
      createdAt: now,
    });
    await repository.saveDeviceLiveActivityCapability({
      deviceId: "device-1",
      userId: "user-1",
      activitiesEnabled: true,
      autoStartEnabled: true,
      pushToStartToken: "b".repeat(64),
      osVersion: "17.2",
      updatedAt: now,
    });
    const surface = await repository.saveLiveSurface({
      id: "surface-1",
      projectId: "project-1",
      surfaceKey: "deploy-run",
      type: "status",
      title: "Deploying production",
      content: { state: "running" },
      liveActivity: { sessionId: "deploy-1", state: "active" },
      displayOrder: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const deliveries: Array<{ token: string; payload: ApnsLiveActivityNotification }> = [];
    const processor = new LiveActivityProcessor(repository, () => ({
      sendLiveActivity: async (token, payload) => {
        deliveries.push({ token, payload });
        return {};
      },
    }), () => new Date(now));

    await processor.process(surface.id, "user-1");
    await processor.process(surface.id, "user-1");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      token: "b".repeat(64),
      payload: { event: "start", priority: 10 },
    });

    await repository.saveLiveActivityRegistration({
      id: "registration-1",
      userId: "user-1",
      deviceId: "device-1",
      projectId: "project-1",
      surfaceId: surface.id,
      sessionId: "deploy-1",
      activityId: "activity-1",
      updateToken: "c".repeat(64),
      apnsEnvironment: "sandbox",
      origin: "agent",
      lastVersion: surface.version,
      expiresAt: "2026-08-07T20:00:00.000Z",
      createdAt: now,
      updatedAt: now,
    });
    const critical = await repository.saveLiveSurface({
      ...surface,
      content: { state: "critical" },
      updatedAt: "2026-08-07T12:01:00.000Z",
    });
    await processor.process(critical.id, "user-1");
    await processor.process(critical.id, "user-1");
    expect(deliveries.at(-1)).toMatchObject({
      token: "c".repeat(64),
      payload: { event: "update", priority: 10 },
    });
    expect(deliveries.filter(({ payload }) => payload.event === "update")).toHaveLength(1);

    const ended = await repository.saveLiveSurface({
      ...critical,
      liveActivity: { sessionId: "deploy-1", state: "ended" },
      updatedAt: "2026-08-07T12:02:00.000Z",
    });
    await processor.process(ended.id, "user-1");
    expect(deliveries.at(-1)?.payload.event).toBe("end");
    expect(await repository.listLiveActivityRegistrations("user-1")).toEqual([]);
  });
});
