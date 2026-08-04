// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccountEntitlement,
  BellwireEvent,
  AgentToken,
  AppleTransactionRecord,
  Delivery,
  DeliveryModeChangeRequest,
  DeliveryHealth,
  Device,
  DeviceBinding,
  DeviceKey,
  DirectConnectionEnvelope,
  DirectConnectionRecoveryRequest,
  EventListOptions,
  EventListPage,
  EventSchema,
  IngestToken,
  LiveSurface,
  MeteredEventWrite,
  MeteredLiveSurfaceWrite,
  MeteredPrivateWakeWrite,
  NotificationSurface,
  PrivateConnectionReadiness,
  PrivateWake,
  PrivateWakeDelivery,
  PrivateWakeToken,
  Project,
} from "../domain/models";
import type {
  BellwireRepository,
  CreateDeliveryResult,
  CreateProjectResult,
} from "./bellwire-repository";
import { decodeEventCursor, encodeEventCursor } from "./event-cursor";

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryBellwireRepository implements BellwireRepository {
  private readonly projects = new Map<string, Project>();
  private readonly devices = new Map<string, Device>();
  private readonly deviceBindings = new Map<string, DeviceBinding>();
  private readonly deviceKeys = new Map<string, DeviceKey>();
  private readonly directConnectionEnvelopes = new Map<string, DirectConnectionEnvelope>();
  private readonly privateConnectionReadiness = new Map<string, PrivateConnectionReadiness>();
  private readonly directConnectionRecoveryRequests = new Map<
    string,
    DirectConnectionRecoveryRequest
  >();
  private readonly deliveryModeChangeRequests = new Map<string, DeliveryModeChangeRequest>();
  private readonly agentTokens = new Map<string, AgentToken>();
  private readonly eventSchemas = new Map<string, EventSchema[]>();
  private readonly surfaces = new Map<string, NotificationSurface[]>();
  private readonly liveSurfaces = new Map<string, LiveSurface>();
  private readonly ingestTokens = new Map<string, IngestToken>();
  private readonly privateWakeTokens = new Map<string, PrivateWakeToken>();
  private readonly events = new Map<string, BellwireEvent>();
  private readonly eventsByIdempotencyKey = new Map<string, string>();
  private readonly privateWakes = new Map<string, PrivateWake>();
  private readonly privateWakesByIdempotencyKey = new Map<string, string>();
  private readonly privateWakeDeliveries = new Map<string, PrivateWakeDelivery>();
  private readonly deliveries = new Map<string, Delivery>();
  private readonly deliveryByEventDevice = new Map<string, string>();
  private readonly rateLimits = new Map<string, { count: number; startedAt: number }>();
  private readonly appleRefreshTokens = new Map<string, string>();
  private readonly appleTransactions = new Map<string, AppleTransactionRecord>();
  private readonly appleNotificationReceipts = new Set<string>();
  private readonly entitlements = new Map<string, AppleTransactionRecord>();
  private readonly signalUsage = new Map<string, number>();

  async deleteAccount(userId: string): Promise<void> {
    const projectIds = [...this.projects.values()]
      .filter((project) => project.userId === userId)
      .map((project) => project.id);
    for (const projectId of projectIds) await this.deleteProject(projectId);

    for (const [deviceId, device] of this.devices) {
      if (device.userId === userId) this.devices.delete(deviceId);
    }
    for (const [bindingId, binding] of this.deviceBindings) {
      if (binding.userId === userId) this.deviceBindings.delete(bindingId);
    }
    for (const [tokenId, token] of this.agentTokens) {
      if (token.userId === userId) this.agentTokens.delete(tokenId);
    }
    this.appleRefreshTokens.delete(userId);
    this.entitlements.delete(userId);
  }

  async saveAppleRefreshToken(userId: string, encryptedRefreshToken: string): Promise<void> {
    this.appleRefreshTokens.set(userId, encryptedRefreshToken);
  }

  async getAppleRefreshToken(userId: string): Promise<string | undefined> {
    return this.appleRefreshTokens.get(userId);
  }

  async deleteAppleRefreshToken(userId: string): Promise<void> {
    this.appleRefreshTokens.delete(userId);
  }

  async createProject(project: Project): Promise<Project> {
    if ([...this.projects.values()].some(
      (candidate) => candidate.userId === project.userId && candidate.slug === project.slug,
    )) {
      throw new Error("Project slug already exists for this account");
    }
    this.projects.set(project.id, copy(project));
    return copy(project);
  }

  async createProjectIfAbsent(project: Project): Promise<CreateProjectResult> {
    const existing = [...this.projects.values()].find(
      (candidate) => candidate.userId === project.userId && candidate.slug === project.slug,
    );
    if (existing) return { project: copy(existing), created: false };
    this.projects.set(project.id, copy(project));
    return { project: copy(project), created: true };
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    return this.cloneFrom(this.projects, projectId);
  }

  async listProjects(userId: string): Promise<Project[]> {
    return [...this.projects.values()]
      .filter((project) => project.userId === userId)
      .sort(compareDisplayOrder)
      .map(copy);
  }

  async updateProject(project: Project): Promise<Project> {
    if ([...this.projects.values()].some(
      (candidate) =>
        candidate.id !== project.id
        && candidate.userId === project.userId
        && candidate.slug === project.slug,
    )) {
      throw new Error("Project slug already exists for this account");
    }
    this.projects.set(project.id, copy(project));
    return copy(project);
  }

  async updateProjectDisplayOrder(projectId: string, displayOrder: number): Promise<Project> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error("Project not found");
    const updated = { ...project, displayOrder };
    this.projects.set(projectId, copy(updated));
    return copy(updated);
  }

  async deleteProject(projectId: string): Promise<void> {
    this.projects.delete(projectId);

    for (const key of this.eventSchemas.keys()) {
      if (key.startsWith(`${projectId}:`)) this.eventSchemas.delete(key);
    }
    for (const key of this.surfaces.keys()) {
      if (key.startsWith(`${projectId}:`)) this.surfaces.delete(key);
    }
    for (const [key, surface] of this.liveSurfaces) {
      if (surface.projectId === projectId) this.liveSurfaces.delete(key);
    }
    for (const [tokenId, token] of this.ingestTokens) {
      if (token.projectId === projectId) this.ingestTokens.delete(tokenId);
    }
    for (const [tokenId, token] of this.privateWakeTokens) {
      if (token.projectId === projectId) this.privateWakeTokens.delete(tokenId);
    }
    for (const [envelopeId, envelope] of this.directConnectionEnvelopes) {
      if (envelope.projectId === projectId) this.directConnectionEnvelopes.delete(envelopeId);
    }
    for (const [key, readiness] of this.privateConnectionReadiness) {
      if (readiness.projectId === projectId) this.privateConnectionReadiness.delete(key);
    }
    for (const [key, request] of this.directConnectionRecoveryRequests) {
      if (request.projectId === projectId) this.directConnectionRecoveryRequests.delete(key);
    }
    for (const [requestId, request] of this.deliveryModeChangeRequests) {
      if (request.projectId === projectId) this.deliveryModeChangeRequests.delete(requestId);
    }

    const deletedEventIds = new Set<string>();
    for (const [eventId, event] of this.events) {
      if (event.projectId === projectId) {
        deletedEventIds.add(eventId);
        this.events.delete(eventId);
      }
    }
    for (const [key, eventId] of this.eventsByIdempotencyKey) {
      if (deletedEventIds.has(eventId)) this.eventsByIdempotencyKey.delete(key);
    }
    for (const [deliveryId, delivery] of this.deliveries) {
      if (deletedEventIds.has(delivery.eventId)) this.deliveries.delete(deliveryId);
    }
    for (const [key, deliveryId] of this.deliveryByEventDevice) {
      if (!this.deliveries.has(deliveryId)) this.deliveryByEventDevice.delete(key);
    }
    const deletedWakeIds = new Set<string>();
    for (const [wakeId, wake] of this.privateWakes) {
      if (wake.projectId === projectId) {
        deletedWakeIds.add(wakeId);
        this.privateWakes.delete(wakeId);
      }
    }
    for (const [key, wakeId] of this.privateWakesByIdempotencyKey) {
      if (deletedWakeIds.has(wakeId)) this.privateWakesByIdempotencyKey.delete(key);
    }
    for (const [deliveryId, delivery] of this.privateWakeDeliveries) {
      if (deletedWakeIds.has(delivery.wakeId)) this.privateWakeDeliveries.delete(deliveryId);
    }
  }

  async saveDevice(device: Device): Promise<Device> {
    const existing = [...this.devices.values()].find(
      (candidate) =>
        candidate.apnsToken === device.apnsToken ||
        (candidate.userId === device.userId && candidate.installationId === device.installationId),
    );
    if (existing) {
      const updated = { ...device, id: existing.id, createdAt: existing.createdAt };
      this.devices.set(existing.id, copy(updated));
      return copy(updated);
    }
    this.devices.set(device.id, copy(device));
    return copy(device);
  }

  async getDevice(deviceId: string): Promise<Device | undefined> {
    return this.cloneFrom(this.devices, deviceId);
  }

  async listDevices(userId: string): Promise<Device[]> {
    return [...this.devices.values()]
      .filter((device) => device.userId === userId)
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt))
      .map(copy);
  }

  async deleteDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    this.devices.delete(deviceId);
    if (!device) return;
    const deletedKeyIds = new Set<string>();
    for (const [keyId, key] of this.deviceKeys) {
      if (key.userId === device.userId && key.installationId === device.installationId) {
        deletedKeyIds.add(keyId);
        this.deviceKeys.delete(keyId);
      }
    }
    for (const [envelopeId, envelope] of this.directConnectionEnvelopes) {
      if (deletedKeyIds.has(envelope.deviceKeyId)) this.directConnectionEnvelopes.delete(envelopeId);
    }
    for (const [readinessKey, readiness] of this.privateConnectionReadiness) {
      if (deletedKeyIds.has(readiness.deviceKeyId)) {
        this.privateConnectionReadiness.delete(readinessKey);
      }
    }
    for (const [requestKey, request] of this.directConnectionRecoveryRequests) {
      if (deletedKeyIds.has(request.deviceKeyId)) {
        this.directConnectionRecoveryRequests.delete(requestKey);
      }
    }
  }

  async saveDeviceBinding(binding: DeviceBinding): Promise<DeviceBinding> {
    this.deviceBindings.set(binding.id, copy(binding));
    return copy(binding);
  }

  async findDeviceBindingByCodeHash(codeHash: string): Promise<DeviceBinding | undefined> {
    const binding = [...this.deviceBindings.values()]
      .find((candidate) => candidate.codeHash === codeHash);
    return binding ? copy(binding) : undefined;
  }

  async claimDeviceBinding(
    codeHash: string,
    token: Omit<AgentToken, "userId">,
    consumedAt: string,
  ): Promise<AgentToken | undefined> {
    const binding = [...this.deviceBindings.values()].find(
      (candidate) => candidate.codeHash === codeHash,
    );
    if (!binding || binding.consumedAt || Date.parse(binding.expiresAt) <= Date.parse(consumedAt)) {
      return undefined;
    }
    const claimedToken: AgentToken = { ...token, userId: binding.userId };
    const tokenConflict = this.agentTokens.has(claimedToken.id) || [...this.agentTokens.values()]
      .some((candidate) => candidate.tokenHash === claimedToken.tokenHash);
    if (tokenConflict) throw new Error("Agent token conflict");
    this.deviceBindings.set(binding.id, { ...binding, consumedAt });
    this.agentTokens.set(claimedToken.id, copy(claimedToken));
    return copy(claimedToken);
  }

  async saveAgentToken(token: AgentToken): Promise<AgentToken> {
    this.agentTokens.set(token.id, copy(token));
    return copy(token);
  }

  async listAgentTokens(userId: string): Promise<AgentToken[]> {
    return [...this.agentTokens.values()]
      .filter((token) => token.userId === userId && !token.revokedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(copy);
  }

  async findAgentTokenByHash(tokenHash: string): Promise<AgentToken | undefined> {
    const now = Date.now();
    const token = [...this.agentTokens.values()].find(
      (candidate) =>
        candidate.tokenHash === tokenHash &&
        !candidate.revokedAt &&
        (!candidate.expiresAt || Date.parse(candidate.expiresAt) > now),
    );
    return token ? copy(token) : undefined;
  }

  async markAgentTokenUsed(tokenId: string, usedAt: string): Promise<void> {
    const token = this.agentTokens.get(tokenId);
    if (token) this.agentTokens.set(tokenId, { ...token, lastUsedAt: usedAt });
  }

  async revokeAgentToken(tokenId: string, userId: string, revokedAt: string): Promise<void> {
    const token = this.agentTokens.get(tokenId);
    if (token?.userId === userId) {
      this.agentTokens.set(tokenId, { ...token, revokedAt });
    }
  }

  async saveDeviceKey(key: DeviceKey): Promise<DeviceKey> {
    this.deviceKeys.set(key.id, copy(key));
    return copy(key);
  }

  async getDeviceKey(keyId: string, userId: string): Promise<DeviceKey | undefined> {
    const key = this.deviceKeys.get(keyId);
    return key?.userId === userId && !key.revokedAt ? copy(key) : undefined;
  }

  async saveDirectConnectionEnvelope(
    envelope: DirectConnectionEnvelope,
  ): Promise<DirectConnectionEnvelope> {
    this.directConnectionEnvelopes.set(envelope.id, copy(envelope));
    return copy(envelope);
  }

  async listDirectConnectionEnvelopes(
    userId: string,
    deviceKeyId: string,
    now: string,
  ): Promise<DirectConnectionEnvelope[]> {
    return [...this.directConnectionEnvelopes.values()]
      .filter((envelope) =>
        envelope.userId === userId
        && envelope.deviceKeyId === deviceKeyId
        && envelope.expiresAt > now
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(copy);
  }

  async acknowledgeDirectConnectionEnvelope(
    envelopeId: string,
    userId: string,
    deviceKeyId: string,
    verifiedAt: string,
  ): Promise<string | undefined> {
    const envelope = this.directConnectionEnvelopes.get(envelopeId);
    if (
      !envelope ||
      envelope.userId !== userId ||
      envelope.deviceKeyId !== deviceKeyId ||
      envelope.expiresAt <= verifiedAt
    ) {
      return undefined;
    }
    this.privateConnectionReadiness.set(
      this.projectTypeKey(envelope.projectId, deviceKeyId),
      {
        projectId: envelope.projectId,
        deviceKeyId,
        userId,
        manifestVersion: 2,
        readyAt: verifiedAt,
        lastVerifiedAt: verifiedAt,
      },
    );
    this.directConnectionEnvelopes.delete(envelopeId);
    return envelope.projectId;
  }

  async getPrivateConnectionReadiness(
    projectId: string,
    deviceKeyId: string,
  ): Promise<PrivateConnectionReadiness | undefined> {
    return this.cloneFrom(
      this.privateConnectionReadiness,
      this.projectTypeKey(projectId, deviceKeyId),
    );
  }

  async listPrivateConnectionReadiness(
    projectId: string,
  ): Promise<PrivateConnectionReadiness[]> {
    return [...this.privateConnectionReadiness.values()]
      .filter((readiness) => readiness.projectId === projectId)
      .map(copy);
  }

  async getDirectConnectionRecoveryRequest(
    projectId: string,
    deviceKeyId: string,
  ): Promise<DirectConnectionRecoveryRequest | undefined> {
    return this.cloneFrom(
      this.directConnectionRecoveryRequests,
      this.projectTypeKey(projectId, deviceKeyId),
    );
  }

  async saveDirectConnectionRecoveryRequestIfAbsent(
    request: DirectConnectionRecoveryRequest,
  ): Promise<{ request: DirectConnectionRecoveryRequest; created: boolean }> {
    const key = this.projectTypeKey(request.projectId, request.deviceKeyId);
    const existing = this.directConnectionRecoveryRequests.get(key);
    if (existing) return { request: copy(existing), created: false };
    this.directConnectionRecoveryRequests.set(key, copy(request));
    return { request: copy(request), created: true };
  }

  async listDirectConnectionRecoveryRequests(
    userId: string,
  ): Promise<DirectConnectionRecoveryRequest[]> {
    return [...this.directConnectionRecoveryRequests.values()]
      .filter((request) => request.userId === userId)
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
      .map(copy);
  }

  async deleteDirectConnectionRecoveryRequest(
    projectId: string,
    deviceKeyId: string,
  ): Promise<void> {
    this.directConnectionRecoveryRequests.delete(this.projectTypeKey(projectId, deviceKeyId));
  }

  async saveDeliveryModeChangeRequest(
    request: DeliveryModeChangeRequest,
  ): Promise<DeliveryModeChangeRequest> {
    const pending = [...this.deliveryModeChangeRequests.values()].find(
      (candidate) => candidate.projectId === request.projectId && candidate.status === "pending",
    );
    if (pending) throw new Error("Pending delivery mode request already exists");
    this.deliveryModeChangeRequests.set(request.id, copy(request));
    return copy(request);
  }

  async listDeliveryModeChangeRequests(
    userId: string,
    status?: DeliveryModeChangeRequest["status"],
  ): Promise<DeliveryModeChangeRequest[]> {
    return [...this.deliveryModeChangeRequests.values()]
      .filter((request) => request.userId === userId && (!status || request.status === status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(copy);
  }

  async resolveDeliveryModeChangeRequest(
    requestId: string,
    userId: string,
    approved: boolean,
    resolvedAt: string,
  ): Promise<DeliveryModeChangeRequest | undefined> {
    const request = this.deliveryModeChangeRequests.get(requestId);
    if (!request || request.userId !== userId || request.status !== "pending") return undefined;
    if (request.expiresAt <= resolvedAt) {
      const expired = { ...request, status: "expired" as const, resolvedAt };
      this.deliveryModeChangeRequests.set(request.id, expired);
      return copy(expired);
    }
    if (approved) {
      if (
        request.toMode === "private" &&
        ![...this.privateConnectionReadiness.values()].some((readiness) => {
          if (readiness.projectId !== request.projectId) return false;
          const key = this.deviceKeys.get(readiness.deviceKeyId);
          if (!key || key.revokedAt) return false;
          return [...this.devices.values()].some(
            (device) =>
              device.userId === request.userId
              && device.installationId === key.installationId
              && device.pushEnabled,
          );
        })
      ) {
        throw new Error("PRIVATE_READINESS_REQUIRED");
      }
      const project = this.projects.get(request.projectId);
      if (!project) return undefined;
      this.projects.set(project.id, { ...project, deliveryMode: request.toMode, updatedAt: resolvedAt });
      if (request.toMode === "private") {
        for (const [id, token] of this.ingestTokens) {
          if (token.projectId === request.projectId && !token.revokedAt) {
            this.ingestTokens.set(id, { ...token, revokedAt: resolvedAt });
          }
        }
      } else {
        for (const [id, token] of this.privateWakeTokens) {
          if (token.projectId === request.projectId && !token.revokedAt) {
            this.privateWakeTokens.set(id, { ...token, revokedAt: resolvedAt });
          }
        }
      }
    }
    const resolved = {
      ...request,
      status: approved ? "approved" as const : "rejected" as const,
      resolvedAt,
    };
    this.deliveryModeChangeRequests.set(request.id, resolved);
    return copy(resolved);
  }

  async saveEventSchema(schema: EventSchema): Promise<EventSchema> {
    const key = this.projectTypeKey(schema.projectId, schema.eventType);
    const versions = this.eventSchemas.get(key) ?? [];
    const saved = { ...schema, version: (versions.at(-1)?.version ?? 0) + 1 };
    versions.push(copy(saved));
    this.eventSchemas.set(key, versions);
    return copy(saved);
  }

  async ensureEventSchemaAndNotificationSurface(
    schema: EventSchema,
    surface: NotificationSurface,
  ): Promise<{ schema: EventSchema; surface: NotificationSurface }> {
    const schemaKey = this.projectTypeKey(schema.projectId, schema.eventType);
    const schemaVersions = this.eventSchemas.get(schemaKey) ?? [];
    let savedSchema = schemaVersions.at(-1);
    if (!savedSchema) {
      savedSchema = { ...schema, version: 1 };
      schemaVersions.push(copy(savedSchema));
      this.eventSchemas.set(schemaKey, schemaVersions);
    }

    const surfaceKey = this.projectTypeKey(surface.projectId, surface.eventType);
    const surfaceVersions = this.surfaces.get(surfaceKey) ?? [];
    let savedSurface = surfaceVersions.at(-1);
    if (!savedSurface) {
      savedSurface = { ...surface, version: 1 };
      surfaceVersions.push(copy(savedSurface));
      this.surfaces.set(surfaceKey, surfaceVersions);
    }
    return { schema: copy(savedSchema), surface: copy(savedSurface) };
  }

  async getEventSchema(projectId: string, eventType: string): Promise<EventSchema | undefined> {
    const schema = this.eventSchemas.get(this.projectTypeKey(projectId, eventType))?.at(-1);
    return schema ? copy(schema) : undefined;
  }

  async listEventSchemas(projectId: string): Promise<EventSchema[]> {
    return [...this.eventSchemas.entries()]
      .filter(([key]) => key.startsWith(`${projectId}:`))
      .flatMap(([, versions]) => versions.at(-1) ? [copy(versions.at(-1) as EventSchema)] : []);
  }

  async saveNotificationSurface(surface: NotificationSurface): Promise<NotificationSurface> {
    const key = this.projectTypeKey(surface.projectId, surface.eventType);
    const versions = this.surfaces.get(key) ?? [];
    const saved = { ...surface, version: (versions.at(-1)?.version ?? 0) + 1 };
    versions.push(copy(saved));
    this.surfaces.set(key, versions);
    return copy(saved);
  }

  async getNotificationSurface(
    projectId: string,
    eventType: string,
  ): Promise<NotificationSurface | undefined> {
    const surface = this.surfaces.get(this.projectTypeKey(projectId, eventType))?.at(-1);
    return surface ? copy(surface) : undefined;
  }

  async listNotificationSurfaces(projectId: string): Promise<NotificationSurface[]> {
    return [...this.surfaces.entries()]
      .filter(([key]) => key.startsWith(`${projectId}:`))
      .flatMap(([, versions]) => {
        const latest = versions.at(-1);
        return latest?.enabled ? [copy(latest)] : [];
      });
  }

  async saveLiveSurface(surface: LiveSurface): Promise<LiveSurface> {
    const key = this.projectTypeKey(surface.projectId, surface.surfaceKey);
    const previous = this.liveSurfaces.get(key);
    const saved: LiveSurface = {
      ...surface,
      id: previous?.id ?? surface.id,
      version: (previous?.version ?? 0) + 1,
      createdAt: previous?.createdAt ?? surface.createdAt,
    };
    this.liveSurfaces.set(key, copy(saved));
    return copy(saved);
  }

  async acceptHostedSurface(
    surface: LiveSurface,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredLiveSurfaceWrite> {
    const project = this.projects.get(surface.projectId);
    if (!project) throw new Error("Project not found");
    if (project.deliveryMode !== "hosted") throw new Error("PROJECT_PRIVATE_MODE");
    const key = this.projectTypeKey(surface.projectId, surface.surfaceKey);
    const existing = this.liveSurfaces.get(key);
    const meter = this.meterSnapshot(project.userId, surface.updatedAt);
    if (existing && sameSurface(existing, surface)) {
      return {
        ...meter,
        surface: copy(existing),
        created: false,
        quotaExceeded: false,
        surfaceLimitExceeded: false,
      };
    }
    const surfacesForProject = [...this.liveSurfaces.values()]
      .filter((candidate) => candidate.projectId === surface.projectId).length;
    const surfaceLimit = meter.plan === "pro" ? undefined : 3;
    if (
      !existing
      && enforcementMode === "enforce"
      && surfaceLimit !== undefined
      && surfacesForProject >= surfaceLimit
    ) {
      return {
        ...meter,
        created: false,
        quotaExceeded: false,
        surfaceLimitExceeded: true,
      };
    }
    if (enforcementMode === "enforce" && meter.acceptedSignals >= meter.courtesyLimit) {
      return {
        ...meter,
        created: false,
        quotaExceeded: true,
        surfaceLimitExceeded: false,
      };
    }
    const saved = await this.saveLiveSurface(surface);
    const acceptedSignals = meter.acceptedSignals + 1;
    this.signalUsage.set(this.usageKey(project.userId, surface.updatedAt), acceptedSignals);
    return {
      ...meter,
      surface: saved,
      created: true,
      quotaExceeded: false,
      surfaceLimitExceeded: false,
      acceptedSignals,
    };
  }

  async getLiveSurface(projectId: string, surfaceKey: string): Promise<LiveSurface | undefined> {
    return this.cloneFrom(this.liveSurfaces, this.projectTypeKey(projectId, surfaceKey));
  }

  async listLiveSurfaces(projectId: string): Promise<LiveSurface[]> {
    return [...this.liveSurfaces.values()]
      .filter((surface) => surface.projectId === projectId)
      .sort(compareDisplayOrder)
      .map(copy);
  }

  async updateLiveSurfaceDisplayOrder(surfaceId: string, displayOrder: number): Promise<LiveSurface> {
    const entry = [...this.liveSurfaces.entries()].find(([, surface]) => surface.id === surfaceId);
    if (!entry) throw new Error("Live Surface not found");
    const updated = { ...entry[1], displayOrder };
    this.liveSurfaces.set(entry[0], copy(updated));
    return copy(updated);
  }

  async deleteLiveSurface(surfaceId: string): Promise<void> {
    const entry = [...this.liveSurfaces.entries()].find(([, surface]) => surface.id === surfaceId);
    if (entry) this.liveSurfaces.delete(entry[0]);
  }

  async saveIngestToken(token: IngestToken): Promise<IngestToken> {
    this.ingestTokens.set(token.id, copy(token));
    return copy(token);
  }

  async listIngestTokens(projectId: string): Promise<IngestToken[]> {
    return [...this.ingestTokens.values()]
      .filter((token) => token.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(copy);
  }

  async findIngestTokenByHash(
    projectId: string,
    tokenHash: string,
  ): Promise<IngestToken | undefined> {
    const now = Date.now();
    const token = [...this.ingestTokens.values()].find(
      (candidate) =>
        candidate.projectId === projectId &&
        candidate.tokenHash === tokenHash &&
        !candidate.revokedAt &&
        (!candidate.expiresAt || Date.parse(candidate.expiresAt) > now),
    );
    return token ? copy(token) : undefined;
  }

  async markIngestTokenUsed(tokenId: string, usedAt: string): Promise<void> {
    const token = this.ingestTokens.get(tokenId);
    if (token) this.ingestTokens.set(tokenId, { ...token, lastUsedAt: usedAt });
  }

  async revokeIngestToken(tokenId: string, revokedAt: string): Promise<void> {
    const token = this.ingestTokens.get(tokenId);
    if (token) this.ingestTokens.set(tokenId, { ...token, revokedAt });
  }

  async savePrivateWakeToken(token: PrivateWakeToken): Promise<PrivateWakeToken> {
    this.privateWakeTokens.set(token.id, copy(token));
    return copy(token);
  }

  async listPrivateWakeTokens(projectId: string): Promise<PrivateWakeToken[]> {
    return [...this.privateWakeTokens.values()]
      .filter((token) => token.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(copy);
  }

  async findPrivateWakeTokenByHash(
    projectId: string,
    tokenHash: string,
  ): Promise<PrivateWakeToken | undefined> {
    const now = Date.now();
    const token = [...this.privateWakeTokens.values()].find(
      (candidate) =>
        candidate.projectId === projectId &&
        candidate.tokenHash === tokenHash &&
        !candidate.revokedAt &&
        (!candidate.expiresAt || Date.parse(candidate.expiresAt) > now),
    );
    return token ? copy(token) : undefined;
  }

  async markPrivateWakeTokenUsed(tokenId: string, usedAt: string): Promise<void> {
    const token = this.privateWakeTokens.get(tokenId);
    if (token) this.privateWakeTokens.set(tokenId, { ...token, lastUsedAt: usedAt });
  }

  async revokePrivateWakeToken(tokenId: string, revokedAt: string): Promise<void> {
    const token = this.privateWakeTokens.get(tokenId);
    if (token) this.privateWakeTokens.set(tokenId, { ...token, revokedAt });
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const now = Date.now();
    const current = this.rateLimits.get(key);
    if (!current || now - current.startedAt >= windowSeconds * 1_000) {
      this.rateLimits.set(key, { count: 1, startedAt: now });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  async acceptHostedEvent(
    event: BellwireEvent,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredEventWrite> {
    const index = this.projectTypeKey(event.projectId, event.idempotencyKeyHash);
    const existingId = this.eventsByIdempotencyKey.get(index);
    const existing = existingId ? this.events.get(existingId) : undefined;
    const project = this.projects.get(event.projectId);
    if (!project) throw new Error("Project not found");
    if (project.deliveryMode !== "hosted") throw new Error("PROJECT_PRIVATE_MODE");
    const meter = this.meterSnapshot(project.userId, event.receivedAt);
    if (existing) return { ...meter, event: copy(existing), created: false, quotaExceeded: false };
    if (enforcementMode === "enforce" && meter.acceptedSignals >= meter.courtesyLimit) {
      return { ...meter, created: false, quotaExceeded: true };
    }
    this.events.set(event.id, copy(event));
    this.eventsByIdempotencyKey.set(index, event.id);
    const acceptedSignals = meter.acceptedSignals + 1;
    this.signalUsage.set(this.usageKey(project.userId, event.receivedAt), acceptedSignals);
    return {
      ...meter,
      event: copy(event),
      created: true,
      quotaExceeded: false,
      acceptedSignals,
    };
  }

  async acceptPrivateWake(
    wake: PrivateWake,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredPrivateWakeWrite> {
    const index = this.projectTypeKey(wake.projectId, wake.idempotencyKeyHash);
    const existingId = this.privateWakesByIdempotencyKey.get(index);
    const existing = existingId ? this.privateWakes.get(existingId) : undefined;
    const project = this.projects.get(wake.projectId);
    if (!project) throw new Error("Project not found");
    if (project.deliveryMode !== "private") throw new Error("PROJECT_HOSTED_MODE");
    const meter = this.meterSnapshot(project.userId, wake.receivedAt);
    if (existing) return { ...meter, wake: copy(existing), created: false, quotaExceeded: false };
    if (enforcementMode === "enforce" && meter.acceptedSignals >= meter.courtesyLimit) {
      return { ...meter, created: false, quotaExceeded: true };
    }
    this.privateWakes.set(wake.id, copy(wake));
    this.privateWakesByIdempotencyKey.set(index, wake.id);
    const acceptedSignals = meter.acceptedSignals + 1;
    this.signalUsage.set(this.usageKey(project.userId, wake.receivedAt), acceptedSignals);
    return {
      ...meter,
      wake: copy(wake),
      created: true,
      quotaExceeded: false,
      acceptedSignals,
    };
  }

  async getPrivateWake(wakeId: string): Promise<PrivateWake | undefined> {
    return this.cloneFrom(this.privateWakes, wakeId);
  }

  async clearPrivateWakeReference(wakeId: string): Promise<void> {
    const wake = this.privateWakes.get(wakeId);
    if (wake) this.privateWakes.set(wakeId, { ...wake, reference: undefined });
  }

  async listEvents(projectId: string, options: EventListOptions): Promise<EventListPage> {
    let events = [...this.events.values()]
      .filter((event) => event.projectId === projectId)
      .filter((event) => !options.eventType || event.eventType === options.eventType)
      .filter((event) => !options.unreadOnly || !event.readAt)
      .sort((left, right) => {
        const dateOrder = right.receivedAt.localeCompare(left.receivedAt);
        return dateOrder || right.id.localeCompare(left.id);
      });
    if (options.cursor) {
      const cursor = decodeEventCursor(options.cursor);
      events = events.filter((event) =>
        event.receivedAt < cursor.receivedAt
          || (event.receivedAt === cursor.receivedAt && event.id < cursor.id));
    }
    const page = events.slice(0, options.limit + 1);
    const hasMore = page.length > options.limit;
    const visible = page.slice(0, options.limit).map(copy);
    return {
      events: visible,
      ...(hasMore && visible.at(-1) ? {
        nextCursor: encodeEventCursor({
          receivedAt: visible.at(-1)!.receivedAt,
          id: visible.at(-1)!.id,
        }),
      } : {}),
    };
  }

  async getEvent(eventId: string): Promise<BellwireEvent | undefined> {
    return this.cloneFrom(this.events, eventId);
  }

  async getEventByIdempotencyHash(
    projectId: string,
    idempotencyKeyHash: string,
  ): Promise<BellwireEvent | undefined> {
    const eventId = this.eventsByIdempotencyKey.get(
      this.projectTypeKey(projectId, idempotencyKeyHash),
    );
    return eventId ? this.cloneFrom(this.events, eventId) : undefined;
  }

  async replaceEventIdempotencyHash(
    eventId: string,
    expectedHash: string,
    replacementHash: string,
  ): Promise<BellwireEvent | undefined> {
    const event = this.events.get(eventId);
    if (!event || event.idempotencyKeyHash !== expectedHash) return undefined;
    const replacementKey = this.projectTypeKey(event.projectId, replacementHash);
    const conflictingEventId = this.eventsByIdempotencyKey.get(replacementKey);
    if (conflictingEventId && conflictingEventId !== eventId) return undefined;
    this.eventsByIdempotencyKey.delete(this.projectTypeKey(event.projectId, expectedHash));
    const updated = { ...event, idempotencyKeyHash: replacementHash };
    this.events.set(eventId, copy(updated));
    this.eventsByIdempotencyKey.set(replacementKey, eventId);
    return copy(updated);
  }

  async markEventRead(eventId: string, readAt: string): Promise<void> {
    const event = this.events.get(eventId);
    if (event) this.events.set(eventId, { ...event, readAt });
  }

  async markAllEventsRead(projectIds: string[], readAt: string): Promise<number> {
    const ownedProjects = new Set(projectIds);
    let updatedCount = 0;
    for (const [eventId, event] of this.events) {
      if (ownedProjects.has(event.projectId) && !event.readAt) {
        this.events.set(eventId, { ...event, readAt });
        updatedCount += 1;
      }
    }
    return updatedCount;
  }

  async createDeliveryIfAbsent(delivery: Delivery): Promise<CreateDeliveryResult> {
    const index = `${delivery.eventId}:${delivery.deviceId}`;
    const existingId = this.deliveryByEventDevice.get(index);
    const existing = existingId ? this.deliveries.get(existingId) : undefined;
    if (existing) return { delivery: copy(existing), created: false };
    this.deliveries.set(delivery.id, copy(delivery));
    this.deliveryByEventDevice.set(index, delivery.id);
    return { delivery: copy(delivery), created: true };
  }

  async claimDelivery(
    deliveryId: string,
    claimedAt: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<Delivery | undefined> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || leaseSeconds < 1 || maxAttempts < 1) return undefined;
    const claimTime = Date.parse(claimedAt);
    const leaseExpired = Date.parse(delivery.updatedAt) <= claimTime - leaseSeconds * 1_000;
    if (delivery.status === "queued" && delivery.attemptCount >= maxAttempts && leaseExpired) {
      this.deliveries.set(delivery.id, {
        ...delivery,
        status: "failed",
        errorCode: "permanent:LeaseExpired",
        errorMessage: "Delivery worker lease expired after the maximum number of attempts",
        updatedAt: claimedAt,
      });
      return undefined;
    }
    const claimable = delivery.attemptCount < maxAttempts && (
      (delivery.status === "queued" && (delivery.attemptCount === 0 || leaseExpired)) ||
      (delivery.status === "failed" && delivery.errorCode?.startsWith("retryable:") === true)
    );
    if (!claimable) return undefined;
    const claimed: Delivery = {
      ...delivery,
      status: "queued",
      attemptCount: delivery.attemptCount + 1,
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: claimedAt,
    };
    this.deliveries.set(claimed.id, copy(claimed));
    return copy(claimed);
  }

  async completeClaimedDelivery(delivery: Delivery): Promise<Delivery | undefined> {
    const current = this.deliveries.get(delivery.id);
    if (
      !current ||
      current.status !== "queued" ||
      current.attemptCount !== delivery.attemptCount
    ) {
      return undefined;
    }
    this.deliveries.set(delivery.id, copy(delivery));
    return copy(delivery);
  }

  async recordQueueUnavailable(
    expected: Delivery,
    failedAt: string,
    message: string,
  ): Promise<Delivery | undefined> {
    const current = this.deliveries.get(expected.id);
    if (
      !current ||
      current.status !== expected.status ||
      current.attemptCount !== expected.attemptCount ||
      current.updatedAt !== expected.updatedAt
    ) {
      return undefined;
    }
    const failed: Delivery = {
      ...current,
      status: "failed",
      errorCode: "retryable:QueueUnavailable",
      errorMessage: message,
      updatedAt: failedAt,
    };
    this.deliveries.set(failed.id, copy(failed));
    return copy(failed);
  }

  async updateDelivery(delivery: Delivery): Promise<Delivery> {
    this.deliveries.set(delivery.id, copy(delivery));
    return copy(delivery);
  }

  async listDeliveries(eventId: string): Promise<Delivery[]> {
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.eventId === eventId)
      .map(copy);
  }

  async getDeliveryHealth(projectId: string, since: string): Promise<DeliveryHealth> {
    const project = this.projects.get(projectId);
    const deliveries = project?.deliveryMode === "private"
      ? (() => {
          const wakeIds = new Set(
            [...this.privateWakes.values()]
              .filter((wake) => wake.projectId === projectId)
              .map((wake) => wake.id),
          );
          return [...this.privateWakeDeliveries.values()].filter(
            (item) => wakeIds.has(item.wakeId) && item.updatedAt >= since,
          );
        })()
      : (() => {
          const eventIds = new Set(
            [...this.events.values()]
              .filter((event) => event.projectId === projectId)
              .map((event) => event.id),
          );
          return [...this.deliveries.values()].filter(
            (item) => eventIds.has(item.eventId) && item.updatedAt >= since,
          );
        })();
    const queued = deliveries.filter((item) => item.status === "queued").length;
    const accepted = deliveries.filter((item) => item.status === "accepted_by_apns").length;
    const failed = deliveries.filter((item) => item.status === "failed").length;
    return {
      queued,
      accepted,
      failed,
      status: deliveries.length === 0 ? "idle" : failed > 0 ? "degraded" : "healthy",
    };
  }

  async createPrivateWakeDeliveryIfAbsent(
    delivery: PrivateWakeDelivery,
  ): Promise<{ delivery: PrivateWakeDelivery; created: boolean }> {
    const existing = [...this.privateWakeDeliveries.values()].find(
      (candidate) =>
        candidate.wakeId === delivery.wakeId && candidate.deviceId === delivery.deviceId,
    );
    if (existing) return { delivery: copy(existing), created: false };
    this.privateWakeDeliveries.set(delivery.id, copy(delivery));
    return { delivery: copy(delivery), created: true };
  }

  async listPrivateWakeDeliveries(wakeId: string): Promise<PrivateWakeDelivery[]> {
    return [...this.privateWakeDeliveries.values()]
      .filter((delivery) => delivery.wakeId === wakeId)
      .map(copy);
  }

  async claimPrivateWakeDelivery(
    deliveryId: string,
    claimedAt: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<PrivateWakeDelivery | undefined> {
    const delivery = this.privateWakeDeliveries.get(deliveryId);
    if (!delivery || leaseSeconds < 1 || maxAttempts < 1) return undefined;
    const claimTime = Date.parse(claimedAt);
    const leaseExpired = Date.parse(delivery.updatedAt) <= claimTime - leaseSeconds * 1_000;
    if (delivery.status === "queued" && delivery.attemptCount >= maxAttempts && leaseExpired) {
      this.privateWakeDeliveries.set(delivery.id, {
        ...delivery,
        status: "failed",
        errorCode: "permanent:LeaseExpired",
        errorMessage: "Private wake worker lease expired after the maximum number of attempts",
        updatedAt: claimedAt,
      });
      return undefined;
    }
    const claimable = delivery.attemptCount < maxAttempts && (
      (delivery.status === "queued" && (delivery.attemptCount === 0 || leaseExpired)) ||
      (delivery.status === "failed" && delivery.errorCode?.startsWith("retryable:") === true)
    );
    if (!claimable) return undefined;
    const claimed: PrivateWakeDelivery = {
      ...delivery,
      status: "queued",
      attemptCount: delivery.attemptCount + 1,
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: claimedAt,
    };
    this.privateWakeDeliveries.set(claimed.id, copy(claimed));
    return copy(claimed);
  }

  async completeClaimedPrivateWakeDelivery(
    delivery: PrivateWakeDelivery,
  ): Promise<PrivateWakeDelivery | undefined> {
    const current = this.privateWakeDeliveries.get(delivery.id);
    if (
      !current ||
      current.status !== "queued" ||
      current.attemptCount !== delivery.attemptCount
    ) {
      return undefined;
    }
    this.privateWakeDeliveries.set(delivery.id, copy(delivery));
    return copy(delivery);
  }

  async updatePrivateWakeDelivery(
    delivery: PrivateWakeDelivery,
  ): Promise<PrivateWakeDelivery> {
    this.privateWakeDeliveries.set(delivery.id, copy(delivery));
    return copy(delivery);
  }

  async getAccountEntitlement(userId: string, now: string): Promise<AccountEntitlement> {
    const meter = this.meterSnapshot(userId, now);
    const transaction = this.entitlements.get(userId);
    const projectCount = [...this.projects.values()]
      .filter((project) => project.userId === userId && project.status === "active").length;
    const deviceCount = [...this.devices.values()]
      .filter((device) => device.userId === userId && device.pushEnabled).length;
    return {
      plan: meter.plan,
      status: transaction?.status ?? "active",
      ...(transaction?.productId ? { productId: transaction.productId } : {}),
      ...(transaction?.expiresAt ? { expiresAt: transaction.expiresAt } : {}),
      limits: {
        activeProjects: meter.plan === "pro" ? 20 : 1,
        activeDevices: meter.plan === "pro" ? 3 : 1,
        monthlySignals: meter.signalLimit,
        courtesySignals: meter.courtesyLimit,
        ingestPerMinute: meter.plan === "pro" ? 300 : 60,
        hostedRetentionDays: meter.plan === "pro" ? 90 : 7,
        surfacesPerProject: meter.plan === "pro" ? null : 3,
      },
      usage: {
        periodStart: this.periodStart(now),
        periodEnd: meter.resetAt,
        acceptedSignals: meter.acceptedSignals,
        remainingSignals: Math.max(0, meter.signalLimit - meter.acceptedSignals),
        courtesyRemainingSignals: Math.max(0, meter.courtesyLimit - meter.acceptedSignals),
      },
      activeProjects: projectCount,
      activeDevices: deviceCount,
    };
  }

  async saveAppleTransaction(transaction: AppleTransactionRecord): Promise<void> {
    this.appleTransactions.set(transaction.transactionId, copy(transaction));
    const current = this.entitlements.get(transaction.userId);
    if (!current || current.signedDate <= transaction.signedDate) {
      this.entitlements.set(transaction.userId, copy(transaction));
    }
  }

  async saveAppleNotificationReceipt(
    notificationUUID: string,
    notificationType: string,
    subtype: string | undefined,
    signedDate: string,
  ): Promise<boolean> {
    void notificationType;
    void subtype;
    void signedDate;
    if (this.appleNotificationReceipts.has(notificationUUID)) return false;
    this.appleNotificationReceipts.add(notificationUUID);
    return true;
  }

  async runMaintenance(now: string): Promise<unknown> {
    void now;
    return {};
  }

  private cloneFrom<T>(map: Map<string, T>, key: string): T | undefined {
    const value = map.get(key);
    return value ? copy(value) : undefined;
  }

  private projectTypeKey(projectId: string, value: string): string {
    return `${projectId}:${value}`;
  }

  private meterSnapshot(userId: string, now: string) {
    const transaction = this.entitlements.get(userId);
    const pro = transaction?.status === "active" || transaction?.status === "grace"
      ? !transaction.expiresAt || transaction.expiresAt > now
      : false;
    const plan = pro ? "pro" as const : "free" as const;
    return {
      plan,
      acceptedSignals: this.signalUsage.get(this.usageKey(userId, now)) ?? 0,
      signalLimit: plan === "pro" ? 50_000 : 5_000,
      courtesyLimit: plan === "pro" ? 55_000 : 5_500,
      resetAt: this.periodEnd(now),
    };
  }

  private usageKey(userId: string, now: string): string {
    return `${userId}:${this.periodStart(now)}`;
  }

  private periodStart(now: string): string {
    const date = new Date(now);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
  }

  private periodEnd(now: string): string {
    const date = new Date(now);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
  }
}

function compareDisplayOrder(
  left: { displayOrder: number; id: string },
  right: { displayOrder: number; id: string },
): number {
  return left.displayOrder - right.displayOrder || left.id.localeCompare(right.id);
}

function sameSurface(left: LiveSurface, right: LiveSurface): boolean {
  return left.type === right.type
    && left.title === right.title
    && left.subtitle === right.subtitle
    && stableJson(left.content) === stableJson(right.content)
    && stableJson(left.action) === stableJson(right.action);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}
