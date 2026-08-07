// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Device,
  LiveActivityRegistration,
  LiveSurface,
  Project,
} from "../domain/models";
import type { BellwireRepository } from "../repositories/bellwire-repository";
import {
  ApnsError,
  type ApnsLiveActivityNotification,
  type ApnsResult,
} from "./apns-client";

export interface LiveActivitySender {
  sendLiveActivity(
    token: string,
    notification: ApnsLiveActivityNotification,
  ): Promise<ApnsResult>;
}

export type LiveActivitySenderFactory = (
  environment: Device["apnsEnvironment"],
) => LiveActivitySender;

export class LiveActivityProcessor {
  constructor(
    private readonly repository: BellwireRepository,
    private readonly senderFactory: LiveActivitySenderFactory,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async process(surfaceId: string, userId: string): Promise<void> {
    const surface = await this.repository.getLiveSurfaceById(surfaceId);
    if (!surface?.liveActivity) return;
    const project = await this.repository.getProject(surface.projectId);
    if (!project || project.userId !== userId || project.deliveryMode !== "hosted") return;

    const [registrations, capabilities, devices] = await Promise.all([
      this.repository.listLiveActivityRegistrations(userId),
      this.repository.listDeviceLiveActivityCapabilities(userId),
      this.repository.listDevices(userId),
    ]);
    const deviceMap = new Map(devices.map((device) => [device.id, device]));
    const current = registrations.filter((registration) =>
      registration.projectId === project.id
      && registration.sessionId === surface.liveActivity?.sessionId
    );

    if (surface.liveActivity.state === "ended") {
      await this.endRegistrations(current, surface);
      return;
    }

    const superseded = registrations.filter((registration) =>
      registration.origin === "agent"
      && registration.projectId === project.id
      && registration.sessionId !== surface.liveActivity?.sessionId
    );
    await this.endRegistrations(superseded, surface);

    for (const registration of current) {
      if (new Date(registration.expiresAt) <= this.now()) {
        await this.endRegistrations([registration], surface);
        continue;
      }
      if (registration.lastVersion >= surface.version) continue;
      await this.sendToRegistration(registration, surface, "update");
    }

    for (const capability of capabilities) {
      const device = deviceMap.get(capability.deviceId);
      if (
        !device?.pushEnabled
        || !capability.activitiesEnabled
        || !capability.autoStartEnabled
        || !capability.pushToStartToken
        || !supportsPushToStart(capability.osVersion)
        || current.some((registration) => registration.deviceId === capability.deviceId)
      ) continue;
      const activeForDevice = registrations.filter((registration) =>
        registration.deviceId === capability.deviceId
        && registration.origin === "agent"
        && new Date(registration.expiresAt) > this.now()
      );
      const pendingStarts = await this.repository.listLiveActivityStartRequests(device.id);
      if (activeForDevice.length + pendingStarts.length >= 3) continue;

      const startRequest = {
        deviceId: device.id,
        projectId: project.id,
        surfaceId: surface.id,
        sessionId: surface.liveActivity.sessionId,
        createdAt: this.now().toISOString(),
      };
      if (!await this.repository.createLiveActivityStartRequestIfAbsent(startRequest)) continue;
      try {
        await this.senderFactory(device.apnsEnvironment).sendLiveActivity(
          capability.pushToStartToken,
          liveActivityNotification("start", surface, project),
        );
      } catch (error) {
        await this.repository.deleteLiveActivityStartRequest(
          device.id,
          project.id,
          surface.liveActivity.sessionId,
        );
        if (error instanceof ApnsError && !error.retryable) continue;
        throw error;
      }
    }
  }

  private async endRegistrations(
    registrations: LiveActivityRegistration[],
    surface: LiveSurface,
  ): Promise<void> {
    for (const registration of registrations) {
      await this.sendToRegistration(registration, surface, "end");
    }
  }

  private async sendToRegistration(
    registration: LiveActivityRegistration,
    surface: LiveSurface,
    event: "update" | "end",
  ): Promise<void> {
    try {
      await this.senderFactory(registration.apnsEnvironment).sendLiveActivity(
        registration.updateToken,
        liveActivityNotification(event, surface),
      );
      if (event === "end") {
        await this.repository.deleteLiveActivityRegistration(registration.activityId);
      } else {
        await this.repository.saveLiveActivityRegistration({
          ...registration,
          lastVersion: surface.version,
          updatedAt: this.now().toISOString(),
        });
      }
    } catch (error) {
      if (error instanceof ApnsError && !error.retryable) {
        await this.repository.deleteLiveActivityRegistration(registration.activityId);
        return;
      }
      throw error;
    }
  }
}

function liveActivityNotification(
  event: "start" | "update" | "end",
  surface: LiveSurface,
  project?: Project,
): ApnsLiveActivityNotification {
  const urgent = event !== "update" || surface.content.state === "critical"
    || checklistHasFailure(surface);
  return {
    event,
    timestamp: Math.floor(Date.now() / 1_000),
    contentState: nativeContentState(surface),
    ...(event === "start" && project
      ? {
          attributes: {
            surfaceID: surface.id,
            projectName: project.name,
            projectIcon: project.icon,
            projectID: project.id,
            surfaceKey: surface.surfaceKey,
            sessionID: surface.liveActivity?.sessionId,
            origin: "agent",
            deliveryMode: "hosted",
          },
        }
      : {}),
    priority: urgent ? 10 : 5,
    collapseId: `surface-${surface.id}`.slice(0, 64),
    ...(event === "end" ? { dismissalDate: Math.floor(Date.now() / 1_000) } : {}),
  };
}

function nativeContentState(surface: LiveSurface): Record<string, unknown> {
  const metrics = Array.isArray(surface.content.metrics) ? surface.content.metrics : [];
  const firstMetric = record(metrics[0]);
  const directValue = displayValue(surface.content.displayValue ?? surface.content.value);
  const metricValue = displayValue(firstMetric.value);
  const value = metricValue === undefined
    ? directValue
    : `${metricValue}${typeof firstMetric.unit === "string" ? firstMetric.unit : ""}`;
  const percentage = finiteNumber(surface.content.percentage);
  const rawValue = finiteNumber(surface.content.value);
  const upperLimit = finiteNumber(surface.content.upperLimit);
  const progress = percentage === undefined
    ? rawValue !== undefined && upperLimit !== undefined && upperLimit > 0
      ? clamp(rawValue / upperLimit)
      : undefined
    : clamp(percentage / 100);
  return {
    title: surface.title,
    ...(surface.subtitle ? { subtitle: surface.subtitle } : {}),
    ...(value === undefined ? {} : { value }),
    ...(progress === undefined ? {} : { progress }),
    type: surface.type,
    ...(typeof surface.content.state === "string"
      ? { statusState: surface.content.state }
      : {}),
    ...(typeof surface.content.label === "string"
      ? { statusLabel: surface.content.label }
      : {}),
    ...(surface.type === "checklist"
      ? {
          checklistItems: (Array.isArray(surface.content.items) ? surface.content.items : [])
            .map(record)
            .filter((item) =>
              typeof item.id === "string"
              && typeof item.title === "string"
              && typeof item.state === "string"
            )
            .map((item) => ({ id: item.id, title: item.title, state: item.state })),
        }
      : {}),
    ...(surface.type === "trend"
      ? {
          trendPoints: (Array.isArray(surface.content.points) ? surface.content.points : [])
            .map(record)
            .filter((point) => typeof point.label === "string" && finiteNumber(point.value) !== undefined)
            .map((point) => ({ label: point.label, value: point.value })),
          trendGoal: surface.content.goal,
          ...(typeof surface.content.unit === "string" ? { trendUnit: surface.content.unit } : {}),
        }
      : {}),
    updatedAt: appleReferenceSeconds(surface.updatedAt),
  };
}

function checklistHasFailure(surface: LiveSurface): boolean {
  return Array.isArray(surface.content.items) && surface.content.items.some(
    (item) => record(item).state === "failed",
  );
}

function supportsPushToStart(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 17 || (major === 17 && minor >= 2);
}

function appleReferenceSeconds(value: string): number {
  const milliseconds = new Date(value).getTime();
  return milliseconds / 1_000 - 978_307_200;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function displayValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function clamp(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
