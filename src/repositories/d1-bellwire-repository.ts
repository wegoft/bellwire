// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccountEntitlement,
  AgentToken,
  AppleTransactionRecord,
  BellwireEvent,
  Delivery,
  DeliveryHealth,
  DeliveryModeChangeRequest,
  Device,
  DeviceBinding,
  DeviceKey,
  DeviceLiveActivityCapability,
  DirectConnectionEnvelope,
  DirectConnectionRecoveryRequest,
  EventListOptions,
  EventListPage,
  EventSchema,
  IngestToken,
  LiveActivityRegistration,
  LiveActivityStartRequest,
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

type EntityKind =
  | "project"
  | "device"
  | "device_live_activity_capability"
  | "live_activity_registration"
  | "live_activity_start_request"
  | "device_binding"
  | "agent_token"
  | "device_key"
  | "direct_connection_envelope"
  | "private_connection_readiness"
  | "direct_connection_recovery_request"
  | "delivery_mode_change_request"
  | "event_schema"
  | "notification_surface"
  | "live_surface"
  | "ingest_token"
  | "private_wake_token"
  | "event"
  | "private_wake"
  | "delivery"
  | "private_wake_delivery"
  | "apple_transaction"
  | "entitlement";

interface EntityMeta {
  ownerId?: string;
  parentId?: string;
  alternateKey?: string;
  secondaryKey?: string;
  state?: string;
  timestamp?: string;
  expiresAt?: string;
  displayOrder?: number;
  revision?: number;
  attemptCount?: number;
}

interface StoredEntitlement {
  status: AppleTransactionRecord["status"];
  productId?: string;
  expiresAt?: string;
  downgradeDeadline?: string;
  originalTransactionId: string;
  signedDate: string;
  updatedAt: string;
}

const ENTITY_COLUMNS = `
  kind, id, owner_id, parent_id, alternate_key, secondary_key, state,
  timestamp, expires_at, display_order, revision, attempt_count, payload
`;

export class D1BellwireRepository implements BellwireRepository {
  constructor(private readonly database: D1Database) {}

  async deleteAccount(userId: string): Promise<void> {
    const projects = await this.listProjects(userId);
    for (const project of projects) await this.deleteProject(project.id);
    const devices = await this.listDevices(userId);
    for (const device of devices) await this.deleteDevice(device.id);
    await this.database.batch([
      this.database.prepare("DELETE FROM bellwire_entities WHERE owner_id = ?").bind(userId),
      this.database.prepare("DELETE FROM signal_usage WHERE user_id = ?").bind(userId),
      this.database.prepare("DELETE FROM signal_acceptances WHERE user_id = ?").bind(userId),
    ]);
  }

  async createProject(project: Project): Promise<Project> {
    const result = await this.insert("project", project.id, project, projectMeta(project));
    if (!result) throw new Error("Project slug already exists for this account");
    return clone(project);
  }

  async createProjectIfAbsent(project: Project): Promise<CreateProjectResult> {
    const existing = await this.first<Project>(
      "project",
      "owner_id = ? AND alternate_key = ?",
      project.userId,
      project.slug,
    );
    if (existing) return { project: existing, created: false };
    try {
      const created = await this.createProject(project);
      return { project: created, created: true };
    } catch {
      const raced = await this.first<Project>(
        "project",
        "owner_id = ? AND alternate_key = ?",
        project.userId,
        project.slug,
      );
      if (raced) return { project: raced, created: false };
      throw new Error("Project slug already exists for this account");
    }
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    return this.get("project", projectId);
  }

  async listProjects(userId: string): Promise<Project[]> {
    return (await this.list<Project>("project", "owner_id = ?", userId)).sort(compareDisplayOrder);
  }

  async updateProject(project: Project): Promise<Project> {
    await this.put("project", project.id, project, projectMeta(project));
    return clone(project);
  }

  async updateProjectDisplayOrder(projectId: string, displayOrder: number): Promise<Project> {
    const project = await this.getProject(projectId);
    if (!project) throw new Error("Project not found");
    return this.updateProject({ ...project, displayOrder });
  }

  async deleteProject(projectId: string): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        DELETE FROM signal_acceptances
        WHERE entity_id IN (
          SELECT id FROM bellwire_entities
          WHERE parent_id = ? AND kind IN ('event', 'private_wake', 'live_surface')
        )
      `).bind(projectId),
      this.database.prepare(`
        DELETE FROM bellwire_entities
        WHERE kind = 'delivery' AND parent_id IN (
          SELECT id FROM bellwire_entities WHERE kind = 'event' AND parent_id = ?
        )
      `).bind(projectId),
      this.database.prepare(`
        DELETE FROM bellwire_entities
        WHERE kind = 'private_wake_delivery' AND parent_id IN (
          SELECT id FROM bellwire_entities WHERE kind = 'private_wake' AND parent_id = ?
        )
      `).bind(projectId),
      this.database.prepare("DELETE FROM bellwire_entities WHERE kind = 'project' AND id = ?").bind(projectId),
      this.database.prepare("DELETE FROM bellwire_entities WHERE parent_id = ?").bind(projectId),
      this.database.prepare(`
        DELETE FROM bellwire_entities
        WHERE kind IN ('live_activity_registration', 'live_activity_start_request')
          AND json_extract(payload, '$.projectId') = ?
      `).bind(projectId),
    ];
    await this.database.batch(statements);
  }

  async saveDevice(device: Device): Promise<Device> {
    const existing = await this.first<Device>(
      "device",
      "alternate_key = ? OR (owner_id = ? AND secondary_key = ?)",
      device.apnsToken,
      device.userId,
      device.installationId,
    );
    const saved = existing
      ? { ...device, id: existing.id, createdAt: existing.createdAt }
      : device;
    await this.put("device", saved.id, saved, deviceMeta(saved));
    return clone(saved);
  }

  async getDevice(deviceId: string): Promise<Device | undefined> {
    return this.get("device", deviceId);
  }

  async listDevices(userId: string): Promise<Device[]> {
    return (await this.list<Device>("device", "owner_id = ?", userId))
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
  }

  async deleteDevice(deviceId: string): Promise<void> {
    const device = await this.getDevice(deviceId);
    if (!device) return;
    const keys = (await this.list<DeviceKey>(
      "device_key",
      "owner_id = ? AND alternate_key = ?",
      device.userId,
      device.installationId,
    )).map((key) => key.id);
    const statements = [
      this.deleteEntity("device", deviceId),
      this.deleteEntity("device_live_activity_capability", deviceId),
      this.database.prepare(
        "DELETE FROM bellwire_entities WHERE kind IN ('live_activity_registration', 'live_activity_start_request') AND parent_id = ?",
      ).bind(deviceId),
      this.database.prepare(
        "DELETE FROM bellwire_entities WHERE kind = 'device_key' AND owner_id = ? AND alternate_key = ?",
      ).bind(device.userId, device.installationId),
      this.database.prepare(
        "DELETE FROM bellwire_entities WHERE kind IN ('delivery', 'private_wake_delivery') AND alternate_key = ?",
      ).bind(deviceId),
    ];
    if (keys.length) {
      statements.push(
        this.deleteForAlternateKeys("direct_connection_envelope", keys),
        this.deleteForAlternateKeys("private_connection_readiness", keys),
        this.deleteForAlternateKeys("direct_connection_recovery_request", keys),
      );
    }
    await this.database.batch(statements);
  }

  async saveDeviceLiveActivityCapability(
    capability: DeviceLiveActivityCapability,
  ): Promise<DeviceLiveActivityCapability> {
    await this.put("device_live_activity_capability", capability.deviceId, capability, {
      ownerId: capability.userId,
      parentId: capability.deviceId,
      timestamp: capability.updatedAt,
    });
    return clone(capability);
  }

  async listDeviceLiveActivityCapabilities(
    userId: string,
  ): Promise<DeviceLiveActivityCapability[]> {
    return this.list("device_live_activity_capability", "owner_id = ?", userId);
  }

  async saveLiveActivityRegistration(
    registration: LiveActivityRegistration,
  ): Promise<LiveActivityRegistration> {
    const existing = await this.get<LiveActivityRegistration>(
      "live_activity_registration",
      registration.activityId,
    );
    const saved = existing
      ? { ...registration, id: existing.id, createdAt: existing.createdAt }
      : registration;
    await this.put("live_activity_registration", registration.activityId, saved, {
      ownerId: saved.userId,
      parentId: saved.deviceId,
      alternateKey: compoundId(saved.projectId, saved.sessionId),
      timestamp: saved.updatedAt,
      expiresAt: saved.expiresAt,
    });
    return clone(saved);
  }

  async listLiveActivityRegistrations(userId: string): Promise<LiveActivityRegistration[]> {
    return this.list("live_activity_registration", "owner_id = ?", userId);
  }

  async deleteLiveActivityRegistration(activityId: string): Promise<void> {
    await this.deleteEntity("live_activity_registration", activityId).run();
  }

  async createLiveActivityStartRequestIfAbsent(request: LiveActivityStartRequest): Promise<boolean> {
    return this.insert("live_activity_start_request", compoundId(
      request.deviceId,
      request.projectId,
      request.sessionId,
    ), request, {
      parentId: request.deviceId,
      alternateKey: request.projectId,
      secondaryKey: request.sessionId,
      timestamp: request.createdAt,
    });
  }

  async listLiveActivityStartRequests(deviceId: string): Promise<LiveActivityStartRequest[]> {
    return this.list("live_activity_start_request", "parent_id = ?", deviceId);
  }

  async deleteLiveActivityStartRequest(
    deviceId: string,
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    await this.deleteEntity(
      "live_activity_start_request",
      compoundId(deviceId, projectId, sessionId),
    ).run();
  }

  async saveDeviceBinding(binding: DeviceBinding): Promise<DeviceBinding> {
    await this.put("device_binding", binding.id, binding, bindingMeta(binding));
    return clone(binding);
  }

  async findDeviceBindingByCodeHash(codeHash: string): Promise<DeviceBinding | undefined> {
    return this.first("device_binding", "alternate_key = ?", codeHash);
  }

  async claimDeviceBinding(
    codeHash: string,
    token: Omit<AgentToken, "userId">,
    consumedAt: string,
  ): Promise<AgentToken | undefined> {
    const binding = await this.findDeviceBindingByCodeHash(codeHash);
    if (!binding || binding.consumedAt || binding.expiresAt <= consumedAt) return undefined;
    const claimed: AgentToken = { ...token, userId: binding.userId };
    const consumed = { ...binding, consumedAt };
    const tokenMeta = agentTokenMeta(claimed);
    const claimState = `consumed:${token.id}`;
    try {
      const results = await this.database.batch([
        this.database.prepare(`
          UPDATE bellwire_entities
          SET state = ?, timestamp = ?, payload = ?
          WHERE kind = 'device_binding' AND id = ? AND state = 'pending' AND expires_at > ?
        `).bind(claimState, consumedAt, JSON.stringify(consumed), binding.id, consumedAt),
        this.database.prepare(`
          INSERT INTO bellwire_entities (${ENTITY_COLUMNS})
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM bellwire_entities
            WHERE kind = 'device_binding' AND id = ? AND state = ?
          )
        `).bind(
          "agent_token", claimed.id, tokenMeta.ownerId ?? null, null,
          tokenMeta.alternateKey ?? null, null, tokenMeta.state ?? null,
          tokenMeta.timestamp ?? null, tokenMeta.expiresAt ?? null, null, null, null,
          JSON.stringify(claimed), binding.id, claimState,
        ),
      ]);
      return results[1] && changes(results[1]) > 0 ? clone(claimed) : undefined;
    } catch (error) {
      if (isConstraintError(error)) throw new Error("Agent token conflict");
      throw error;
    }
  }

  async saveAgentToken(token: AgentToken): Promise<AgentToken> {
    await this.put("agent_token", token.id, token, agentTokenMeta(token));
    return clone(token);
  }

  async listAgentTokens(userId: string): Promise<AgentToken[]> {
    return (await this.list<AgentToken>("agent_token", "owner_id = ?", userId))
      .filter((token) => !token.revokedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async findAgentTokenByHash(tokenHash: string): Promise<AgentToken | undefined> {
    const token = await this.first<AgentToken>("agent_token", "alternate_key = ?", tokenHash);
    return token && !token.revokedAt && (!token.expiresAt || token.expiresAt > new Date().toISOString())
      ? token
      : undefined;
  }

  async markAgentTokenUsed(tokenId: string, usedAt: string): Promise<void> {
    await this.patchEntity<AgentToken>("agent_token", tokenId, (token) => ({
      ...token,
      lastUsedAt: usedAt,
    }), agentTokenMeta);
  }

  async revokeAgentToken(tokenId: string, userId: string, revokedAt: string): Promise<void> {
    const token = await this.get<AgentToken>("agent_token", tokenId);
    if (token?.userId === userId) {
      await this.put("agent_token", tokenId, { ...token, revokedAt }, agentTokenMeta({
        ...token,
        revokedAt,
      }));
    }
  }

  async saveDeviceKey(key: DeviceKey): Promise<DeviceKey> {
    await this.put("device_key", key.id, key, {
      ownerId: key.userId,
      alternateKey: key.installationId,
      state: key.revokedAt ? "revoked" : "active",
      timestamp: key.lastActiveAt,
    });
    return clone(key);
  }

  async getDeviceKey(keyId: string, userId: string): Promise<DeviceKey | undefined> {
    const key = await this.get<DeviceKey>("device_key", keyId);
    return key?.userId === userId && !key.revokedAt ? key : undefined;
  }

  async saveDirectConnectionEnvelope(
    envelope: DirectConnectionEnvelope,
  ): Promise<DirectConnectionEnvelope> {
    await this.put("direct_connection_envelope", envelope.id, envelope, {
      ownerId: envelope.userId,
      parentId: envelope.projectId,
      alternateKey: envelope.deviceKeyId,
      timestamp: envelope.createdAt,
      expiresAt: envelope.expiresAt,
    });
    return clone(envelope);
  }

  async listDirectConnectionEnvelopes(
    userId: string,
    deviceKeyId: string,
    now: string,
  ): Promise<DirectConnectionEnvelope[]> {
    return (await this.list<DirectConnectionEnvelope>(
      "direct_connection_envelope",
      "owner_id = ? AND alternate_key = ? AND expires_at > ?",
      userId,
      deviceKeyId,
      now,
    )).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async acknowledgeDirectConnectionEnvelope(
    envelopeId: string,
    userId: string,
    deviceKeyId: string,
    verifiedAt: string,
  ): Promise<string | undefined> {
    const envelope = await this.get<DirectConnectionEnvelope>("direct_connection_envelope", envelopeId);
    if (
      !envelope
      || envelope.userId !== userId
      || envelope.deviceKeyId !== deviceKeyId
      || envelope.expiresAt <= verifiedAt
    ) return undefined;
    const readiness: PrivateConnectionReadiness = {
      projectId: envelope.projectId,
      deviceKeyId,
      userId,
      manifestVersion: 2,
      readyAt: verifiedAt,
      lastVerifiedAt: verifiedAt,
    };
    const claim = `acknowledging:${crypto.randomUUID()}`;
    const meta = readinessMeta(readiness);
    const results = await this.database.batch([
      this.database.prepare(`
        UPDATE bellwire_entities SET state = ?
        WHERE kind = 'direct_connection_envelope' AND id = ?
          AND owner_id = ? AND alternate_key = ? AND expires_at > ?
      `).bind(claim, envelopeId, userId, deviceKeyId, verifiedAt),
      this.database.prepare(`
        INSERT INTO bellwire_entities (${ENTITY_COLUMNS})
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM bellwire_entities
          WHERE kind = 'direct_connection_envelope' AND id = ? AND state = ?
        )
        ON CONFLICT (kind, id) DO UPDATE SET
          owner_id = excluded.owner_id,
          parent_id = excluded.parent_id,
          alternate_key = excluded.alternate_key,
          state = excluded.state,
          timestamp = excluded.timestamp,
          payload = excluded.payload
      `).bind(
        ...entityValues(
          "private_connection_readiness",
          compoundId(envelope.projectId, deviceKeyId),
          readiness,
          meta,
        ),
        envelopeId,
        claim,
      ),
      this.database.prepare(`
        DELETE FROM bellwire_entities
        WHERE kind = 'direct_connection_envelope' AND id = ? AND state = ?
      `).bind(envelopeId, claim),
    ]);
    return results[0] && changes(results[0]) > 0 ? envelope.projectId : undefined;
  }

  async getPrivateConnectionReadiness(
    projectId: string,
    deviceKeyId: string,
  ): Promise<PrivateConnectionReadiness | undefined> {
    return this.get("private_connection_readiness", compoundId(projectId, deviceKeyId));
  }

  async listPrivateConnectionReadiness(projectId: string): Promise<PrivateConnectionReadiness[]> {
    return this.list("private_connection_readiness", "parent_id = ?", projectId);
  }

  async getDirectConnectionRecoveryRequest(
    projectId: string,
    deviceKeyId: string,
  ): Promise<DirectConnectionRecoveryRequest | undefined> {
    return this.get("direct_connection_recovery_request", compoundId(projectId, deviceKeyId));
  }

  async saveDirectConnectionRecoveryRequestIfAbsent(
    request: DirectConnectionRecoveryRequest,
  ): Promise<{ request: DirectConnectionRecoveryRequest; created: boolean }> {
    const id = compoundId(request.projectId, request.deviceKeyId);
    const existing = await this.get<DirectConnectionRecoveryRequest>(
      "direct_connection_recovery_request",
      id,
    );
    if (existing) return { request: existing, created: false };
    const created = await this.insert("direct_connection_recovery_request", id, request, {
      ownerId: request.userId,
      parentId: request.projectId,
      alternateKey: request.deviceKeyId,
      timestamp: request.requestedAt,
    });
    if (created) return { request: clone(request), created: true };
    const raced = await this.get<DirectConnectionRecoveryRequest>(
      "direct_connection_recovery_request",
      id,
    );
    if (!raced) throw new Error("Recovery request was not persisted");
    return { request: raced, created: false };
  }

  async listDirectConnectionRecoveryRequests(
    userId: string,
  ): Promise<DirectConnectionRecoveryRequest[]> {
    return (await this.list<DirectConnectionRecoveryRequest>(
      "direct_connection_recovery_request",
      "owner_id = ?",
      userId,
    )).sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  }

  async deleteDirectConnectionRecoveryRequest(
    projectId: string,
    deviceKeyId: string,
  ): Promise<void> {
    await this.deleteEntity(
      "direct_connection_recovery_request",
      compoundId(projectId, deviceKeyId),
    ).run();
  }

  async saveDeliveryModeChangeRequest(
    request: DeliveryModeChangeRequest,
  ): Promise<DeliveryModeChangeRequest> {
    const pending = await this.first<DeliveryModeChangeRequest>(
      "delivery_mode_change_request",
      "parent_id = ? AND state = 'pending'",
      request.projectId,
    );
    if (pending) throw new Error("Pending delivery mode request already exists");
    const created = await this.insert(
      "delivery_mode_change_request",
      request.id,
      request,
      modeRequestMeta(request),
    );
    if (!created) throw new Error("Delivery mode request already exists");
    return clone(request);
  }

  async listDeliveryModeChangeRequests(
    userId: string,
    status?: DeliveryModeChangeRequest["status"],
  ): Promise<DeliveryModeChangeRequest[]> {
    const requests = await this.list<DeliveryModeChangeRequest>(
      "delivery_mode_change_request",
      status ? "owner_id = ? AND state = ?" : "owner_id = ?",
      ...status ? [userId, status] : [userId],
    );
    return requests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async resolveDeliveryModeChangeRequest(
    requestId: string,
    userId: string,
    approved: boolean,
    resolvedAt: string,
  ): Promise<DeliveryModeChangeRequest | undefined> {
    const request = await this.get<DeliveryModeChangeRequest>(
      "delivery_mode_change_request",
      requestId,
    );
    if (!request || request.userId !== userId || request.status !== "pending") return undefined;
    if (request.expiresAt <= resolvedAt) {
      const expired: DeliveryModeChangeRequest = { ...request, status: "expired", resolvedAt };
      await this.put(
        "delivery_mode_change_request",
        request.id,
        expired,
        modeRequestMeta(expired),
      );
      return expired;
    }

    if (approved && request.toMode === "private") {
      const readiness = await this.listPrivateConnectionReadiness(request.projectId);
      const deviceKeys = await this.list<DeviceKey>("device_key", "owner_id = ?", userId);
      const devices = await this.listDevices(userId);
      const ready = readiness.some((item) => {
        const key = deviceKeys.find((candidate) => candidate.id === item.deviceKeyId && !candidate.revokedAt);
        return Boolean(key && devices.some(
          (device) => device.installationId === key.installationId && device.pushEnabled,
        ));
      });
      if (!ready) throw new Error("PRIVATE_READINESS_REQUIRED");
    }

    const resolved: DeliveryModeChangeRequest = {
      ...request,
      status: approved ? "approved" : "rejected",
      resolvedAt,
    };
    const claim = `resolving:${crypto.randomUUID()}`;
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        UPDATE bellwire_entities SET state = ?
        WHERE kind = 'delivery_mode_change_request' AND id = ?
          AND owner_id = ? AND state = 'pending'
      `).bind(claim, requestId, userId),
    ];
    if (approved) {
      const project = await this.getProject(request.projectId);
      if (!project) return undefined;
      const updatedProject = { ...project, deliveryMode: request.toMode, updatedAt: resolvedAt };
      statements.push(this.conditionalUpsertStatement(
        "project",
        project.id,
        updatedProject,
        projectMeta(updatedProject),
        requestId,
        claim,
      ));
      const tokenKind = request.toMode === "private" ? "ingest_token" : "private_wake_token";
      const tokens = await this.list<IngestToken | PrivateWakeToken>(
        tokenKind,
        "parent_id = ? AND state = 'active'",
        request.projectId,
      );
      for (const token of tokens) {
        const revoked = { ...token, revokedAt: resolvedAt };
        statements.push(this.conditionalUpsertStatement(
          tokenKind,
          token.id,
          revoked,
          tokenMeta(revoked),
          requestId,
          claim,
        ));
      }
    }
    statements.push(this.database.prepare(`
      UPDATE bellwire_entities
      SET state = ?, timestamp = ?, expires_at = ?, payload = ?
      WHERE kind = 'delivery_mode_change_request' AND id = ? AND state = ?
    `).bind(
      resolved.status,
      resolved.createdAt,
      resolved.expiresAt,
      JSON.stringify(resolved),
      requestId,
      claim,
    ));
    const results = await this.database.batch(statements);
    if (!results[0] || changes(results[0]) === 0) return undefined;
    return clone(resolved);
  }

  async saveEventSchema(schema: EventSchema): Promise<EventSchema> {
    const latest = await this.latestVersion<EventSchema>(
      "event_schema",
      schema.projectId,
      schema.eventType,
    );
    const saved = { ...schema, version: (latest?.version ?? 0) + 1 };
    await this.insertVersion("event_schema", saved.id, saved, {
      parentId: saved.projectId,
      alternateKey: saved.eventType,
      revision: saved.version,
      timestamp: saved.createdAt,
      state: saved.status,
    });
    return clone(saved);
  }

  async ensureEventSchemaAndNotificationSurface(
    schema: EventSchema,
    surface: NotificationSurface,
  ): Promise<{ schema: EventSchema; surface: NotificationSurface }> {
    let savedSchema = await this.getEventSchema(schema.projectId, schema.eventType);
    let savedSurface = await this.getNotificationSurface(surface.projectId, surface.eventType);
    const statements: D1PreparedStatement[] = [];
    if (!savedSchema) {
      savedSchema = { ...schema, version: 1 };
      statements.push(this.insertStatement("event_schema", savedSchema.id, savedSchema, {
        parentId: savedSchema.projectId,
        alternateKey: savedSchema.eventType,
        revision: 1,
        timestamp: savedSchema.createdAt,
        state: savedSchema.status,
      }));
    }
    if (!savedSurface) {
      savedSurface = { ...surface, version: 1 };
      statements.push(this.insertStatement(
        "notification_surface",
        savedSurface.id,
        savedSurface,
        surfaceMeta(savedSurface),
      ));
    }
    if (statements.length) {
      try {
        await this.database.batch(statements);
      } catch (error) {
        if (!isConstraintError(error)) throw error;
        savedSchema = await this.getEventSchema(schema.projectId, schema.eventType) ?? savedSchema;
        savedSurface = await this.getNotificationSurface(surface.projectId, surface.eventType)
          ?? savedSurface;
      }
    }
    return { schema: clone(savedSchema), surface: clone(savedSurface) };
  }

  async getEventSchema(projectId: string, eventType: string): Promise<EventSchema | undefined> {
    return this.latestVersion("event_schema", projectId, eventType);
  }

  async listEventSchemas(projectId: string): Promise<EventSchema[]> {
    return this.latestVersions<EventSchema>("event_schema", projectId);
  }

  async saveNotificationSurface(surface: NotificationSurface): Promise<NotificationSurface> {
    const latest = await this.latestVersion<NotificationSurface>(
      "notification_surface",
      surface.projectId,
      surface.eventType,
    );
    const saved = { ...surface, version: (latest?.version ?? 0) + 1 };
    await this.insertVersion("notification_surface", saved.id, saved, surfaceMeta(saved));
    return clone(saved);
  }

  async getNotificationSurface(
    projectId: string,
    eventType: string,
  ): Promise<NotificationSurface | undefined> {
    return this.latestVersion("notification_surface", projectId, eventType);
  }

  async listNotificationSurfaces(projectId: string): Promise<NotificationSurface[]> {
    return (await this.latestVersions<NotificationSurface>("notification_surface", projectId))
      .filter((surface) => surface.enabled);
  }

  async saveLiveSurface(surface: LiveSurface): Promise<LiveSurface> {
    const previous = await this.getLiveSurface(surface.projectId, surface.surfaceKey);
    const saved: LiveSurface = {
      ...surface,
      id: previous?.id ?? surface.id,
      version: (previous?.version ?? 0) + 1,
      createdAt: previous?.createdAt ?? surface.createdAt,
    };
    await this.upsertLiveSurface(saved).run();
    return clone(await this.get<LiveSurface>("live_surface", saved.id) ?? saved);
  }

  async acceptHostedSurface(
    surface: LiveSurface,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredLiveSurfaceWrite> {
    const project = await this.getProject(surface.projectId);
    if (!project) throw new Error("Project not found");
    if (project.deliveryMode !== "hosted") throw new Error("PROJECT_PRIVATE_MODE");
    const existing = await this.getLiveSurface(surface.projectId, surface.surfaceKey);
    const meter = await this.meterSnapshot(project.userId, surface.updatedAt);
    if (existing && sameSurface(existing, surface)) {
      return {
        ...meter,
        surface: existing,
        created: false,
        quotaExceeded: false,
        surfaceLimitExceeded: false,
      };
    }
    const surfaces = await this.listLiveSurfaces(surface.projectId);
    const surfaceLimit = meter.plan === "pro" ? undefined : 3;
    if (
      !existing
      && enforcementMode === "enforce"
      && surfaceLimit !== undefined
      && surfaces.length >= surfaceLimit
    ) {
      return {
        ...meter,
        created: false,
        quotaExceeded: false,
        surfaceLimitExceeded: true,
      };
    }
    const saved: LiveSurface = {
      ...surface,
      id: existing?.id ?? surface.id,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? surface.createdAt,
    };
    const signalKey = `surface:${surface.projectId}:${surface.surfaceKey}:${saved.version}:${await digest(stableJson({
      type: surface.type,
      title: surface.title,
      subtitle: surface.subtitle,
      content: surface.content,
      action: surface.action,
      liveActivity: surface.liveActivity,
    }))}`;
    const accepted = await this.acceptMeteredEntity(
      "live_surface",
      signalKey,
      project.userId,
      saved.updatedAt,
      saved.id,
      saved,
      liveSurfaceMeta(saved),
      enforcementMode,
      meter.courtesyLimit,
      true,
    );
    if (!accepted) {
      const raced = await this.getLiveSurface(surface.projectId, surface.surfaceKey);
      if (raced && sameSurface(raced, surface)) {
        return {
          ...meter,
          surface: raced,
          created: false,
          quotaExceeded: false,
          surfaceLimitExceeded: false,
        };
      }
      return {
        ...meter,
        created: false,
        quotaExceeded: enforcementMode === "enforce",
        surfaceLimitExceeded: false,
      };
    }
    return {
      ...meter,
      surface: await this.getLiveSurface(surface.projectId, surface.surfaceKey) ?? saved,
      created: true,
      quotaExceeded: false,
      surfaceLimitExceeded: false,
      acceptedSignals: meter.acceptedSignals + 1,
    };
  }

  async getLiveSurface(projectId: string, surfaceKey: string): Promise<LiveSurface | undefined> {
    return this.first("live_surface", "parent_id = ? AND alternate_key = ?", projectId, surfaceKey);
  }

  async getLiveSurfaceById(surfaceId: string): Promise<LiveSurface | undefined> {
    return this.get("live_surface", surfaceId);
  }

  async listLiveSurfaces(projectId: string): Promise<LiveSurface[]> {
    return (await this.list<LiveSurface>("live_surface", "parent_id = ?", projectId))
      .sort(compareDisplayOrder);
  }

  async updateLiveSurfaceDisplayOrder(surfaceId: string, displayOrder: number): Promise<LiveSurface> {
    const surface = await this.getLiveSurfaceById(surfaceId);
    if (!surface) throw new Error("Live surface not found");
    const updated = { ...surface, displayOrder };
    await this.put("live_surface", surface.id, updated, liveSurfaceMeta(updated));
    return updated;
  }

  async deleteLiveSurface(surfaceId: string): Promise<void> {
    await this.database.batch([
      this.database.prepare(
        "DELETE FROM signal_acceptances WHERE entity_kind = 'live_surface' AND entity_id = ?",
      ).bind(surfaceId),
      this.deleteEntity("live_surface", surfaceId),
    ]);
  }

  async saveIngestToken(token: IngestToken): Promise<IngestToken> {
    await this.put("ingest_token", token.id, token, tokenMeta(token));
    return clone(token);
  }

  async listIngestTokens(projectId: string): Promise<IngestToken[]> {
    return (await this.list<IngestToken>("ingest_token", "parent_id = ?", projectId))
      .filter((token) => !token.revokedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async findIngestTokenByHash(
    projectId: string,
    tokenHash: string,
  ): Promise<IngestToken | undefined> {
    const token = await this.first<IngestToken>(
      "ingest_token",
      "parent_id = ? AND alternate_key = ?",
      projectId,
      tokenHash,
    );
    return validToken(token) ? token : undefined;
  }

  async markIngestTokenUsed(tokenId: string, usedAt: string): Promise<void> {
    await this.patchEntity<IngestToken>("ingest_token", tokenId, (token) => ({
      ...token,
      lastUsedAt: usedAt,
    }), tokenMeta);
  }

  async revokeIngestToken(tokenId: string, revokedAt: string): Promise<void> {
    await this.patchEntity<IngestToken>("ingest_token", tokenId, (token) => ({
      ...token,
      revokedAt,
    }), tokenMeta);
  }

  async savePrivateWakeToken(token: PrivateWakeToken): Promise<PrivateWakeToken> {
    await this.put("private_wake_token", token.id, token, tokenMeta(token));
    return clone(token);
  }

  async listPrivateWakeTokens(projectId: string): Promise<PrivateWakeToken[]> {
    return (await this.list<PrivateWakeToken>("private_wake_token", "parent_id = ?", projectId))
      .filter((token) => !token.revokedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async findPrivateWakeTokenByHash(
    projectId: string,
    tokenHash: string,
  ): Promise<PrivateWakeToken | undefined> {
    const token = await this.first<PrivateWakeToken>(
      "private_wake_token",
      "parent_id = ? AND alternate_key = ?",
      projectId,
      tokenHash,
    );
    return validToken(token) ? token : undefined;
  }

  async markPrivateWakeTokenUsed(tokenId: string, usedAt: string): Promise<void> {
    await this.patchEntity<PrivateWakeToken>("private_wake_token", tokenId, (token) => ({
      ...token,
      lastUsedAt: usedAt,
    }), tokenMeta);
  }

  async revokePrivateWakeToken(tokenId: string, revokedAt: string): Promise<void> {
    await this.patchEntity<PrivateWakeToken>("private_wake_token", tokenId, (token) => ({
      ...token,
      revokedAt,
    }), tokenMeta);
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    if (limit < 1 || windowSeconds < 1) return false;
    const now = Date.now();
    const result = await this.database.prepare(`
      INSERT INTO ingest_rate_limits (key, count, started_at)
      VALUES (?, 1, ?)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN ? - started_at >= ? THEN 1
          ELSE count + 1
        END,
        started_at = CASE
          WHEN ? - started_at >= ? THEN ?
          ELSE started_at
        END
      WHERE ? - started_at >= ? OR count < ?
      RETURNING count
    `).bind(
      key,
      now,
      now,
      windowSeconds * 1_000,
      now,
      windowSeconds * 1_000,
      now,
      now,
      windowSeconds * 1_000,
      limit,
    ).first<{ count: number }>();
    return Boolean(result);
  }

  async acceptHostedEvent(
    event: BellwireEvent,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredEventWrite> {
    const existing = await this.getEventByIdempotencyHash(
      event.projectId,
      event.idempotencyKeyHash,
    );
    const project = await this.getProject(event.projectId);
    if (!project) throw new Error("Project not found");
    if (project.deliveryMode !== "hosted") throw new Error("PROJECT_PRIVATE_MODE");
    const meter = await this.meterSnapshot(project.userId, event.receivedAt);
    if (existing) return { ...meter, event: existing, created: false, quotaExceeded: false };
    const accepted = await this.acceptMeteredEntity(
      "event",
      `event:${event.projectId}:${event.idempotencyKeyHash}`,
      project.userId,
      event.receivedAt,
      event.id,
      event,
      eventMeta(event),
      enforcementMode,
      meter.courtesyLimit,
      false,
    );
    if (!accepted) {
      const raced = await this.getEventByIdempotencyHash(
        event.projectId,
        event.idempotencyKeyHash,
      );
      if (raced) return { ...meter, event: raced, created: false, quotaExceeded: false };
      return { ...meter, created: false, quotaExceeded: true };
    }
    return {
      ...meter,
      event: clone(event),
      created: true,
      quotaExceeded: false,
      acceptedSignals: meter.acceptedSignals + 1,
    };
  }

  async acceptPrivateWake(
    wake: PrivateWake,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredPrivateWakeWrite> {
    const existing = await this.first<PrivateWake>(
      "private_wake",
      "parent_id = ? AND alternate_key = ?",
      wake.projectId,
      wake.idempotencyKeyHash,
    );
    const project = await this.getProject(wake.projectId);
    if (!project) throw new Error("Project not found");
    if (project.deliveryMode !== "private") throw new Error("PROJECT_HOSTED_MODE");
    const meter = await this.meterSnapshot(project.userId, wake.receivedAt);
    if (existing) return { ...meter, wake: existing, created: false, quotaExceeded: false };
    const accepted = await this.acceptMeteredEntity(
      "private_wake",
      `wake:${wake.projectId}:${wake.idempotencyKeyHash}`,
      project.userId,
      wake.receivedAt,
      wake.id,
      wake,
      privateWakeMeta(wake),
      enforcementMode,
      meter.courtesyLimit,
      false,
    );
    if (!accepted) {
      const raced = await this.first<PrivateWake>(
        "private_wake",
        "parent_id = ? AND alternate_key = ?",
        wake.projectId,
        wake.idempotencyKeyHash,
      );
      if (raced) return { ...meter, wake: raced, created: false, quotaExceeded: false };
      return { ...meter, created: false, quotaExceeded: true };
    }
    return {
      ...meter,
      wake: clone(wake),
      created: true,
      quotaExceeded: false,
      acceptedSignals: meter.acceptedSignals + 1,
    };
  }

  async getPrivateWake(wakeId: string): Promise<PrivateWake | undefined> {
    return this.get("private_wake", wakeId);
  }

  async clearPrivateWakeReference(wakeId: string): Promise<void> {
    await this.patchEntity<PrivateWake>("private_wake", wakeId, (wake) => ({
      ...wake,
      reference: undefined,
    }), privateWakeMeta);
  }

  async listEvents(projectId: string, options: EventListOptions): Promise<EventListPage> {
    const conditions = ["kind = 'event'", "parent_id = ?"];
    const values: unknown[] = [projectId];
    if (options.eventType) {
      conditions.push("secondary_key = ?");
      values.push(options.eventType);
    }
    if (options.unreadOnly) conditions.push("state = 'unread'");
    if (options.cursor) {
      const cursor = decodeEventCursor(options.cursor);
      conditions.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
      values.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
    }
    values.push(options.limit + 1);
    const result = await this.database.prepare(`
      SELECT payload FROM bellwire_entities
      WHERE ${conditions.join(" AND ")}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).bind(...values).all<{ payload: string }>();
    const page = result.results.map((row) => parse<BellwireEvent>(row.payload));
    const visible = page.slice(0, options.limit);
    const last = visible.at(-1);
    return {
      events: visible,
      ...(page.length > options.limit && last ? {
        nextCursor: encodeEventCursor({ receivedAt: last.receivedAt, id: last.id }),
      } : {}),
    };
  }

  async getEvent(eventId: string): Promise<BellwireEvent | undefined> {
    return this.get("event", eventId);
  }

  async getEventByIdempotencyHash(
    projectId: string,
    idempotencyKeyHash: string,
  ): Promise<BellwireEvent | undefined> {
    return this.first(
      "event",
      "parent_id = ? AND alternate_key = ?",
      projectId,
      idempotencyKeyHash,
    );
  }

  async replaceEventIdempotencyHash(
    eventId: string,
    expectedHash: string,
    replacementHash: string,
  ): Promise<BellwireEvent | undefined> {
    const event = await this.getEvent(eventId);
    if (!event || event.idempotencyKeyHash !== expectedHash) return undefined;
    const conflict = await this.getEventByIdempotencyHash(event.projectId, replacementHash);
    if (conflict && conflict.id !== eventId) return undefined;
    const updated = { ...event, idempotencyKeyHash: replacementHash };
    const result = await this.database.prepare(`
      UPDATE bellwire_entities SET alternate_key = ?, payload = ?
      WHERE kind = 'event' AND id = ? AND alternate_key = ?
    `).bind(replacementHash, JSON.stringify(updated), eventId, expectedHash).run();
    return changes(result) > 0 ? updated : undefined;
  }

  async markEventRead(eventId: string, readAt: string): Promise<void> {
    await this.patchEntity<BellwireEvent>("event", eventId, (event) => ({ ...event, readAt }), eventMeta);
  }

  async markAllEventsRead(projectIds: string[], readAt: string): Promise<number> {
    if (!projectIds.length) return 0;
    const placeholders = projectIds.map(() => "?").join(", ");
    const result = await this.database.prepare(`
      UPDATE bellwire_entities
      SET state = 'read', payload = json_set(payload, '$.readAt', ?)
      WHERE kind = 'event' AND state = 'unread' AND parent_id IN (${placeholders})
    `).bind(readAt, ...projectIds).run();
    return changes(result);
  }

  async createDeliveryIfAbsent(delivery: Delivery): Promise<CreateDeliveryResult> {
    const existing = await this.first<Delivery>(
      "delivery",
      "parent_id = ? AND alternate_key = ?",
      delivery.eventId,
      delivery.deviceId,
    );
    if (existing) return { delivery: existing, created: false };
    const created = await this.insert("delivery", delivery.id, delivery, deliveryMeta(delivery));
    if (created) return { delivery: clone(delivery), created: true };
    const raced = await this.first<Delivery>(
      "delivery",
      "parent_id = ? AND alternate_key = ?",
      delivery.eventId,
      delivery.deviceId,
    );
    if (!raced) throw new Error("Delivery was not persisted");
    return { delivery: raced, created: false };
  }

  async claimDelivery(
    deliveryId: string,
    claimedAt: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<Delivery | undefined> {
    return this.claimDeliveryEntity<Delivery>(
      "delivery",
      deliveryId,
      claimedAt,
      leaseSeconds,
      maxAttempts,
      "Delivery worker lease expired after the maximum number of attempts",
      deliveryMeta,
    );
  }

  async completeClaimedDelivery(delivery: Delivery): Promise<Delivery | undefined> {
    return this.completeClaimedDeliveryEntity("delivery", delivery, deliveryMeta);
  }

  async recordQueueUnavailable(
    expected: Delivery,
    failedAt: string,
    message: string,
  ): Promise<Delivery | undefined> {
    const current = await this.get<Delivery>("delivery", expected.id);
    if (
      !current
      || current.status !== expected.status
      || current.attemptCount !== expected.attemptCount
      || current.updatedAt !== expected.updatedAt
    ) return undefined;
    const failed: Delivery = {
      ...current,
      status: "failed",
      errorCode: "retryable:QueueUnavailable",
      errorMessage: message,
      updatedAt: failedAt,
    };
    const result = await this.conditionalDeliveryUpdate(
      "delivery",
      failed,
      expected.status,
      expected.attemptCount,
      expected.updatedAt,
      deliveryMeta,
    );
    return result ? failed : undefined;
  }

  async updateDelivery(delivery: Delivery): Promise<Delivery> {
    await this.put("delivery", delivery.id, delivery, deliveryMeta(delivery));
    return clone(delivery);
  }

  async listDeliveries(eventId: string): Promise<Delivery[]> {
    return this.list("delivery", "parent_id = ?", eventId);
  }

  async getDeliveryHealth(projectId: string, since: string): Promise<DeliveryHealth> {
    const project = await this.getProject(projectId);
    const parentKind = project?.deliveryMode === "private" ? "private_wake" : "event";
    const deliveryKind = project?.deliveryMode === "private"
      ? "private_wake_delivery"
      : "delivery";
    const result = await this.database.prepare(`
      SELECT delivery.state, COUNT(*) AS count
      FROM bellwire_entities delivery
      JOIN bellwire_entities parent
        ON parent.kind = ? AND parent.id = delivery.parent_id
      WHERE delivery.kind = ? AND parent.parent_id = ? AND delivery.timestamp >= ?
      GROUP BY delivery.state
    `).bind(parentKind, deliveryKind, projectId, since)
      .all<{ state: string; count: number }>();
    const counts = new Map(result.results.map((row) => [row.state, row.count]));
    const queued = counts.get("queued") ?? 0;
    const accepted = counts.get("accepted_by_apns") ?? 0;
    const failed = counts.get("failed") ?? 0;
    return {
      queued,
      accepted,
      failed,
      status: queued + accepted + failed === 0 ? "idle" : failed > 0 ? "degraded" : "healthy",
    };
  }

  async createPrivateWakeDeliveryIfAbsent(
    delivery: PrivateWakeDelivery,
  ): Promise<{ delivery: PrivateWakeDelivery; created: boolean }> {
    const existing = await this.first<PrivateWakeDelivery>(
      "private_wake_delivery",
      "parent_id = ? AND alternate_key = ?",
      delivery.wakeId,
      delivery.deviceId,
    );
    if (existing) return { delivery: existing, created: false };
    const created = await this.insert(
      "private_wake_delivery",
      delivery.id,
      delivery,
      privateWakeDeliveryMeta(delivery),
    );
    if (created) return { delivery: clone(delivery), created: true };
    const raced = await this.first<PrivateWakeDelivery>(
      "private_wake_delivery",
      "parent_id = ? AND alternate_key = ?",
      delivery.wakeId,
      delivery.deviceId,
    );
    if (!raced) throw new Error("Private wake delivery was not persisted");
    return { delivery: raced, created: false };
  }

  async listPrivateWakeDeliveries(wakeId: string): Promise<PrivateWakeDelivery[]> {
    return this.list("private_wake_delivery", "parent_id = ?", wakeId);
  }

  async claimPrivateWakeDelivery(
    deliveryId: string,
    claimedAt: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<PrivateWakeDelivery | undefined> {
    return this.claimDeliveryEntity<PrivateWakeDelivery>(
      "private_wake_delivery",
      deliveryId,
      claimedAt,
      leaseSeconds,
      maxAttempts,
      "Private wake worker lease expired after the maximum number of attempts",
      privateWakeDeliveryMeta,
    );
  }

  async completeClaimedPrivateWakeDelivery(
    delivery: PrivateWakeDelivery,
  ): Promise<PrivateWakeDelivery | undefined> {
    return this.completeClaimedDeliveryEntity(
      "private_wake_delivery",
      delivery,
      privateWakeDeliveryMeta,
    );
  }

  async updatePrivateWakeDelivery(
    delivery: PrivateWakeDelivery,
  ): Promise<PrivateWakeDelivery> {
    await this.put(
      "private_wake_delivery",
      delivery.id,
      delivery,
      privateWakeDeliveryMeta(delivery),
    );
    return clone(delivery);
  }

  async getAccountEntitlement(userId: string, now: string): Promise<AccountEntitlement> {
    const meter = await this.meterSnapshot(userId, now);
    const transaction = await this.get<StoredEntitlement>("entitlement", userId);
    const projectCount = (await this.list<Project>("project", "owner_id = ?", userId))
      .filter((project) => project.status === "active").length;
    const deviceCount = (await this.list<Device>("device", "owner_id = ?", userId))
      .filter((device) => device.pushEnabled).length;
    return {
      plan: meter.plan,
      status: transaction?.status ?? "active",
      ...(transaction?.productId ? { productId: transaction.productId } : {}),
      ...(transaction?.expiresAt ? { expiresAt: transaction.expiresAt } : {}),
      ...(transaction?.downgradeDeadline
        ? { downgradeDeadline: transaction.downgradeDeadline }
        : {}),
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
        periodStart: periodStart(now),
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
    const existing = await this.get<AppleTransactionRecord>(
      "apple_transaction",
      transaction.transactionId,
    );
    if (existing && (
      existing.userId !== transaction.userId
      || existing.originalTransactionId !== transaction.originalTransactionId
      || existing.productId !== transaction.productId
    )) {
      throw new Error("Apple transaction identity conflict");
    }
    if (existing && existing.signedDate > transaction.signedDate) return;

    const entitlement: StoredEntitlement = {
      status: transaction.status,
      productId: transaction.productId,
      expiresAt: transaction.expiresAt,
      downgradeDeadline: transaction.status === "expired" || transaction.status === "revoked"
        ? new Date(Date.parse(transaction.updatedAt) + 7 * 24 * 60 * 60 * 1_000).toISOString()
        : undefined,
      originalTransactionId: transaction.originalTransactionId,
      signedDate: transaction.signedDate,
      updatedAt: transaction.updatedAt,
    };
    const transactionValues = entityValues("apple_transaction", transaction.transactionId, transaction, {
      ownerId: transaction.userId,
      alternateKey: transaction.originalTransactionId,
      state: transaction.status,
      timestamp: transaction.signedDate,
      expiresAt: transaction.expiresAt,
    });
    const entitlementValues = entityValues("entitlement", transaction.userId, entitlement, {
      ownerId: transaction.userId,
      alternateKey: transaction.originalTransactionId,
      state: transaction.status,
      timestamp: transaction.signedDate,
      expiresAt: transaction.expiresAt,
    });
    const results = await this.database.batch([
      this.database.prepare(`
        INSERT INTO bellwire_entities (${ENTITY_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (kind, id) DO UPDATE SET
          state = excluded.state,
          timestamp = excluded.timestamp,
          expires_at = excluded.expires_at,
          payload = excluded.payload
        WHERE bellwire_entities.owner_id = excluded.owner_id
          AND bellwire_entities.alternate_key = excluded.alternate_key
          AND json_extract(bellwire_entities.payload, '$.productId')
            = json_extract(excluded.payload, '$.productId')
          AND bellwire_entities.timestamp <= excluded.timestamp
      `).bind(...transactionValues),
      this.database.prepare(`
        INSERT INTO bellwire_entities (${ENTITY_COLUMNS})
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM bellwire_entities
          WHERE kind = 'apple_transaction' AND id = ? AND owner_id = ?
            AND alternate_key = ? AND timestamp = ?
        )
        ON CONFLICT (kind, id) DO UPDATE SET
          alternate_key = excluded.alternate_key,
          state = excluded.state,
          timestamp = excluded.timestamp,
          expires_at = excluded.expires_at,
          payload = excluded.payload
        WHERE bellwire_entities.timestamp <= excluded.timestamp
      `).bind(
        ...entitlementValues,
        transaction.transactionId,
        transaction.userId,
        transaction.originalTransactionId,
        transaction.signedDate,
      ),
    ]);
    if (!results[0] || changes(results[0]) === 0) {
      throw new Error("Apple transaction identity conflict");
    }
  }

  async saveAppleNotificationReceipt(
    notificationUUID: string,
    notificationType: string,
    subtype: string | undefined,
    signedDate: string,
  ): Promise<boolean> {
    const result = await this.database.prepare(`
      INSERT INTO apple_notification_receipts (
        notification_uuid, notification_type, subtype, signed_date, received_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (notification_uuid) DO NOTHING
    `).bind(
      notificationUUID,
      notificationType,
      subtype ?? null,
      signedDate,
      new Date().toISOString(),
    ).run();
    return changes(result) > 0;
  }

  async runMaintenance(now: string): Promise<unknown> {
    const cutoff = new Date(Date.parse(now) - 8 * 60 * 60 * 1_000).toISOString();
    const rateLimitCutoff = Date.parse(now) - 24 * 60 * 60 * 1_000;
    const results = await this.database.batch([
      this.database.prepare(`
        UPDATE bellwire_entities
        SET state = 'expired', payload = json_set(payload, '$.status', 'expired', '$.resolvedAt', ?)
        WHERE kind = 'delivery_mode_change_request' AND state = 'pending' AND expires_at <= ?
      `).bind(now, now),
      this.database.prepare(`
        DELETE FROM bellwire_entities
        WHERE kind = 'direct_connection_envelope' AND expires_at <= ?
      `).bind(now),
      this.database.prepare(`
        DELETE FROM bellwire_entities
        WHERE kind = 'live_activity_start_request' AND timestamp < ?
      `).bind(cutoff),
      this.database.prepare(`
        DELETE FROM bellwire_entities
        WHERE kind = 'live_activity_registration' AND expires_at <= ?
      `).bind(now),
      this.database.prepare(`
        DELETE FROM signal_acceptances
        WHERE entity_kind = 'private_wake' AND entity_id IN (
          SELECT id FROM bellwire_entities
          WHERE kind = 'private_wake' AND unixepoch(timestamp) < unixepoch(?) - 7 * 86400
        )
      `).bind(now),
      this.database.prepare(`
        DELETE FROM bellwire_entities
        WHERE kind = 'private_wake_delivery' AND parent_id IN (
          SELECT id FROM bellwire_entities
          WHERE kind = 'private_wake' AND unixepoch(timestamp) < unixepoch(?) - 7 * 86400
        )
      `).bind(now),
      this.database.prepare(`
        DELETE FROM bellwire_entities
        WHERE kind = 'private_wake' AND unixepoch(timestamp) < unixepoch(?) - 7 * 86400
      `).bind(now),
      this.database.prepare(`
        UPDATE bellwire_entities
        SET payload = json_remove(payload, '$.reference')
        WHERE kind = 'private_wake'
          AND json_extract(payload, '$.reference') IS NOT NULL
          AND json_extract(payload, '$.referenceExpiresAt') <= ?
      `).bind(now),
      this.database.prepare(expiredEventAcceptanceSql()).bind(now, now),
      this.database.prepare(expiredDeliverySql()).bind(now, now),
      this.database.prepare(expiredEventSql()).bind(now, now),
      this.database.prepare("DELETE FROM ingest_rate_limits WHERE started_at < ?")
        .bind(rateLimitCutoff),
      this.database.prepare(`
        WITH ranked AS (
          SELECT project.id,
            row_number() OVER (
              PARTITION BY project.owner_id
              ORDER BY json_extract(project.payload, '$.updatedAt') DESC, project.id
            ) AS position
          FROM bellwire_entities project
          JOIN bellwire_entities entitlement
            ON entitlement.kind = 'entitlement' AND entitlement.owner_id = project.owner_id
          WHERE project.kind = 'project' AND project.state = 'active'
            AND entitlement.state IN ('expired', 'revoked')
            AND json_extract(entitlement.payload, '$.downgradeDeadline') <= ?
        )
        UPDATE bellwire_entities
        SET state = 'paused', payload = json_set(payload, '$.status', 'paused', '$.updatedAt', ?)
        WHERE kind = 'project' AND id IN (SELECT id FROM ranked WHERE position > 1)
      `).bind(now, now),
      this.database.prepare(`
        WITH ranked AS (
          SELECT device.id,
            row_number() OVER (
              PARTITION BY device.owner_id ORDER BY device.timestamp DESC, device.id
            ) AS position
          FROM bellwire_entities device
          JOIN bellwire_entities entitlement
            ON entitlement.kind = 'entitlement' AND entitlement.owner_id = device.owner_id
          WHERE device.kind = 'device' AND device.state = 'active'
            AND entitlement.state IN ('expired', 'revoked')
            AND json_extract(entitlement.payload, '$.downgradeDeadline') <= ?
        )
        UPDATE bellwire_entities
        SET state = 'disabled', payload = json_set(payload, '$.pushEnabled', json('false'))
        WHERE kind = 'device' AND id IN (SELECT id FROM ranked WHERE position > 1)
      `).bind(now),
    ]);
    return { deleted: results.reduce((total, result) => total + changes(result), 0) };
  }

  private async get<T>(kind: EntityKind, id: string): Promise<T | undefined> {
    const row = await this.database.prepare(`
      SELECT payload FROM bellwire_entities WHERE kind = ? AND id = ?
    `).bind(kind, id).first<{ payload: string }>();
    return row ? parse<T>(row.payload) : undefined;
  }

  private async first<T>(
    kind: EntityKind,
    where: string,
    ...values: unknown[]
  ): Promise<T | undefined> {
    const row = await this.database.prepare(`
      SELECT payload FROM bellwire_entities WHERE kind = ? AND (${where}) LIMIT 1
    `).bind(kind, ...values).first<{ payload: string }>();
    return row ? parse<T>(row.payload) : undefined;
  }

  private async list<T>(kind: EntityKind, where = "1 = 1", ...values: unknown[]): Promise<T[]> {
    const result = await this.database.prepare(`
      SELECT payload FROM bellwire_entities WHERE kind = ? AND (${where})
    `).bind(kind, ...values).all<{ payload: string }>();
    return result.results.map((row) => parse<T>(row.payload));
  }

  private async listForParents<T>(kind: EntityKind, parentIds: string[]): Promise<T[]> {
    if (!parentIds.length) return [];
    const placeholders = parentIds.map(() => "?").join(", ");
    return this.list(kind, `parent_id IN (${placeholders})`, ...parentIds);
  }

  private async put<T>(kind: EntityKind, id: string, value: T, meta: EntityMeta): Promise<void> {
    await this.upsertStatement(kind, id, value, meta).run();
  }

  private async insert<T>(
    kind: EntityKind,
    id: string,
    value: T,
    meta: EntityMeta,
  ): Promise<boolean> {
    try {
      const result = await this.insertStatement(kind, id, value, meta, true).run();
      return changes(result) > 0;
    } catch (error) {
      if (isConstraintError(error)) return false;
      throw error;
    }
  }

  private insertStatement<T>(
    kind: EntityKind,
    id: string,
    value: T,
    meta: EntityMeta,
    ignoreConflict = false,
  ): D1PreparedStatement {
    return this.database.prepare(`
      INSERT ${ignoreConflict ? "OR IGNORE" : ""} INTO bellwire_entities (${ENTITY_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...entityValues(kind, id, value, meta));
  }

  private upsertStatement<T>(
    kind: EntityKind,
    id: string,
    value: T,
    meta: EntityMeta,
  ): D1PreparedStatement {
    return this.database.prepare(`
      INSERT INTO bellwire_entities (${ENTITY_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET
        owner_id = excluded.owner_id,
        parent_id = excluded.parent_id,
        alternate_key = excluded.alternate_key,
        secondary_key = excluded.secondary_key,
        state = excluded.state,
        timestamp = excluded.timestamp,
        expires_at = excluded.expires_at,
        display_order = excluded.display_order,
        revision = excluded.revision,
        attempt_count = excluded.attempt_count,
        payload = excluded.payload
    `).bind(...entityValues(kind, id, value, meta));
  }

  private upsertLiveSurface(surface: LiveSurface): D1PreparedStatement {
    const meta = liveSurfaceMeta(surface);
    return this.database.prepare(`
      INSERT INTO bellwire_entities (${ENTITY_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (kind, id) DO UPDATE SET
        parent_id = excluded.parent_id,
        alternate_key = excluded.alternate_key,
        state = excluded.state,
        timestamp = excluded.timestamp,
        display_order = excluded.display_order,
        revision = bellwire_entities.revision + 1,
        payload = json_set(
          excluded.payload,
          '$.id', bellwire_entities.id,
          '$.version', bellwire_entities.revision + 1,
          '$.createdAt', json_extract(bellwire_entities.payload, '$.createdAt')
        )
    `).bind(...entityValues("live_surface", surface.id, surface, meta));
  }

  private conditionalUpsertStatement<T>(
    kind: EntityKind,
    id: string,
    value: T,
    meta: EntityMeta,
    requestId: string,
    claim: string,
  ): D1PreparedStatement {
    return this.database.prepare(`
      INSERT INTO bellwire_entities (${ENTITY_COLUMNS})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM bellwire_entities
        WHERE kind = 'delivery_mode_change_request' AND id = ? AND state = ?
      )
      ON CONFLICT (kind, id) DO UPDATE SET
        owner_id = excluded.owner_id,
        parent_id = excluded.parent_id,
        alternate_key = excluded.alternate_key,
        secondary_key = excluded.secondary_key,
        state = excluded.state,
        timestamp = excluded.timestamp,
        expires_at = excluded.expires_at,
        display_order = excluded.display_order,
        revision = excluded.revision,
        attempt_count = excluded.attempt_count,
        payload = excluded.payload
    `).bind(...entityValues(kind, id, value, meta), requestId, claim);
  }

  private deleteEntity(kind: EntityKind, id: string): D1PreparedStatement {
    return this.database.prepare("DELETE FROM bellwire_entities WHERE kind = ? AND id = ?")
      .bind(kind, id);
  }

  private deleteForParents(kind: EntityKind, parentIds: string[]): D1PreparedStatement {
    const placeholders = parentIds.map(() => "?").join(", ");
    return this.database.prepare(`
      DELETE FROM bellwire_entities WHERE kind = ? AND parent_id IN (${placeholders})
    `).bind(kind, ...parentIds);
  }

  private deleteForAlternateKeys(kind: EntityKind, keys: string[]): D1PreparedStatement {
    const placeholders = keys.map(() => "?").join(", ");
    return this.database.prepare(`
      DELETE FROM bellwire_entities WHERE kind = ? AND alternate_key IN (${placeholders})
    `).bind(kind, ...keys);
  }

  private async patchEntity<T>(
    kind: EntityKind,
    id: string,
    update: (current: T) => T,
    metaFor: (value: T) => EntityMeta,
  ): Promise<void> {
    const current = await this.get<T>(kind, id);
    if (!current) return;
    const updated = update(current);
    await this.put(kind, id, updated, metaFor(updated));
  }

  private async latestVersion<T>(
    kind: "event_schema" | "notification_surface",
    projectId: string,
    eventType: string,
  ): Promise<T | undefined> {
    const row = await this.database.prepare(`
      SELECT payload FROM bellwire_entities
      WHERE kind = ? AND parent_id = ? AND alternate_key = ?
      ORDER BY revision DESC LIMIT 1
    `).bind(kind, projectId, eventType).first<{ payload: string }>();
    return row ? parse<T>(row.payload) : undefined;
  }

  private async latestVersions<T>(
    kind: "event_schema" | "notification_surface",
    projectId: string,
  ): Promise<T[]> {
    const rows = await this.database.prepare(`
      SELECT entity.payload
      FROM bellwire_entities entity
      INNER JOIN (
        SELECT alternate_key, MAX(revision) AS revision
        FROM bellwire_entities
        WHERE kind = ? AND parent_id = ?
        GROUP BY alternate_key
      ) latest
        ON latest.alternate_key = entity.alternate_key
        AND latest.revision = entity.revision
      WHERE entity.kind = ? AND entity.parent_id = ?
    `).bind(kind, projectId, kind, projectId).all<{ payload: string }>();
    return rows.results.map((row) => parse<T>(row.payload));
  }

  private async insertVersion<T>(
    kind: "event_schema" | "notification_surface",
    id: string,
    value: T,
    meta: EntityMeta,
  ): Promise<void> {
    try {
      await this.insertStatement(kind, id, value, meta).run();
    } catch (error) {
      if (isConstraintError(error)) {
        throw new Error("Configuration version conflict; retry the request");
      }
      throw error;
    }
  }

  private async acceptMeteredEntity<T>(
    kind: "event" | "private_wake" | "live_surface",
    signalKey: string,
    userId: string,
    acceptedAt: string,
    id: string,
    value: T,
    meta: EntityMeta,
    enforcementMode: "disabled" | "shadow" | "enforce",
    courtesyLimit: number,
    updateOnConflict: boolean,
  ): Promise<boolean> {
    const start = periodStart(acceptedAt);
    const claimToken = crypto.randomUUID();
    const acceptance = this.database.prepare(`
      INSERT INTO signal_acceptances (
        signal_key, claim_token, user_id, period_start, entity_kind, entity_id, accepted_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE ? <> 'enforce' OR COALESCE((
        SELECT accepted_signals FROM signal_usage WHERE user_id = ? AND period_start = ?
      ), 0) < ?
      ON CONFLICT (signal_key) DO NOTHING
    `).bind(
      signalKey,
      claimToken,
      userId,
      start,
      kind,
      id,
      acceptedAt,
      enforcementMode,
      userId,
      start,
      courtesyLimit,
    );
    const values = entityValues(kind, id, value, meta);
    const conflict = updateOnConflict
      ? `DO UPDATE SET
          parent_id = excluded.parent_id,
          alternate_key = excluded.alternate_key,
          state = excluded.state,
          timestamp = excluded.timestamp,
          display_order = excluded.display_order,
          revision = bellwire_entities.revision + 1,
          payload = json_set(
            excluded.payload,
            '$.id', bellwire_entities.id,
            '$.version', bellwire_entities.revision + 1,
            '$.createdAt', json_extract(bellwire_entities.payload, '$.createdAt')
          )`
      : "DO NOTHING";
    const entity = this.database.prepare(`
      INSERT INTO bellwire_entities (${ENTITY_COLUMNS})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM signal_acceptances WHERE signal_key = ? AND claim_token = ?
      )
      ON CONFLICT ${conflict}
    `).bind(...values, signalKey, claimToken);
    const results = await this.database.batch([acceptance, entity]);
    return results[0] ? changes(results[0]) > 0 : false;
  }

  private async meterSnapshot(userId: string, now: string) {
    const transaction = await this.get<StoredEntitlement>("entitlement", userId);
    const pro = transaction?.status === "active" || transaction?.status === "grace"
      ? !transaction.expiresAt || transaction.expiresAt > now
      : false;
    const plan = pro ? "pro" as const : "free" as const;
    const usage = await this.database.prepare(`
      SELECT accepted_signals FROM signal_usage WHERE user_id = ? AND period_start = ?
    `).bind(userId, periodStart(now)).first<{ accepted_signals: number }>();
    return {
      plan,
      acceptedSignals: usage?.accepted_signals ?? 0,
      signalLimit: plan === "pro" ? 50_000 : 5_000,
      courtesyLimit: plan === "pro" ? 55_000 : 5_500,
      resetAt: periodEnd(now),
    };
  }

  private async claimDeliveryEntity<T extends Delivery | PrivateWakeDelivery>(
    kind: "delivery" | "private_wake_delivery",
    deliveryId: string,
    claimedAt: string,
    leaseSeconds: number,
    maxAttempts: number,
    leaseMessage: string,
    metaFor: (delivery: T) => EntityMeta,
  ): Promise<T | undefined> {
    const delivery = await this.get<T>(kind, deliveryId);
    if (!delivery || leaseSeconds < 1 || maxAttempts < 1) return undefined;
    const leaseExpired = Date.parse(delivery.updatedAt)
      <= Date.parse(claimedAt) - leaseSeconds * 1_000;
    if (delivery.status === "queued" && delivery.attemptCount >= maxAttempts && leaseExpired) {
      const failed = {
        ...delivery,
        status: "failed" as const,
        errorCode: "permanent:LeaseExpired",
        errorMessage: leaseMessage,
        updatedAt: claimedAt,
      };
      await this.conditionalDeliveryUpdate(
        kind,
        failed,
        delivery.status,
        delivery.attemptCount,
        delivery.updatedAt,
        metaFor,
      );
      return undefined;
    }
    const claimable = delivery.attemptCount < maxAttempts && (
      (delivery.status === "queued" && (delivery.attemptCount === 0 || leaseExpired))
      || (delivery.status === "failed" && delivery.errorCode?.startsWith("retryable:") === true)
    );
    if (!claimable) return undefined;
    const claimed = {
      ...delivery,
      status: "queued" as const,
      attemptCount: delivery.attemptCount + 1,
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: claimedAt,
    } as T;
    const updated = await this.conditionalDeliveryUpdate(
      kind,
      claimed,
      delivery.status,
      delivery.attemptCount,
      delivery.updatedAt,
      metaFor,
    );
    return updated ? clone(claimed) : undefined;
  }

  private async completeClaimedDeliveryEntity<T extends Delivery | PrivateWakeDelivery>(
    kind: "delivery" | "private_wake_delivery",
    delivery: T,
    metaFor: (delivery: T) => EntityMeta,
  ): Promise<T | undefined> {
    const current = await this.get<T>(kind, delivery.id);
    if (
      !current
      || current.status !== "queued"
      || current.attemptCount !== delivery.attemptCount
    ) return undefined;
    const updated = await this.conditionalDeliveryUpdate(
      kind,
      delivery,
      "queued",
      delivery.attemptCount,
      current.updatedAt,
      metaFor,
    );
    return updated ? clone(delivery) : undefined;
  }

  private async conditionalDeliveryUpdate<T extends Delivery | PrivateWakeDelivery>(
    kind: "delivery" | "private_wake_delivery",
    delivery: T,
    expectedStatus: string,
    expectedAttempts: number,
    expectedUpdatedAt: string,
    metaFor: (delivery: T) => EntityMeta,
  ): Promise<boolean> {
    const meta = metaFor(delivery);
    const result = await this.database.prepare(`
      UPDATE bellwire_entities
      SET state = ?, timestamp = ?, attempt_count = ?, payload = ?
      WHERE kind = ? AND id = ? AND state = ? AND attempt_count = ? AND timestamp = ?
    `).bind(
      meta.state ?? null,
      meta.timestamp ?? null,
      meta.attemptCount ?? null,
      JSON.stringify(delivery),
      kind,
      delivery.id,
      expectedStatus,
      expectedAttempts,
      expectedUpdatedAt,
    ).run();
    return changes(result) > 0;
  }
}

function entityValues<T>(kind: EntityKind, id: string, value: T, meta: EntityMeta): unknown[] {
  return [
    kind,
    id,
    meta.ownerId ?? null,
    meta.parentId ?? null,
    meta.alternateKey ?? null,
    meta.secondaryKey ?? null,
    meta.state ?? null,
    meta.timestamp ?? null,
    meta.expiresAt ?? null,
    meta.displayOrder ?? null,
    meta.revision ?? null,
    meta.attemptCount ?? null,
    JSON.stringify(value),
  ];
}

function projectMeta(project: Project): EntityMeta {
  return {
    ownerId: project.userId,
    alternateKey: project.slug,
    state: project.status,
    timestamp: project.createdAt,
    displayOrder: project.displayOrder,
  };
}

function deviceMeta(device: Device): EntityMeta {
  return {
    ownerId: device.userId,
    alternateKey: device.apnsToken,
    secondaryKey: device.installationId,
    state: device.pushEnabled ? "active" : "disabled",
    timestamp: device.lastActiveAt,
  };
}

function bindingMeta(binding: DeviceBinding): EntityMeta {
  return {
    ownerId: binding.userId,
    alternateKey: binding.codeHash,
    secondaryKey: binding.deviceKeyId,
    state: binding.consumedAt ? "consumed" : "pending",
    timestamp: binding.consumedAt ?? binding.createdAt,
    expiresAt: binding.expiresAt,
  };
}

function agentTokenMeta(token: AgentToken): EntityMeta {
  return {
    ownerId: token.userId,
    alternateKey: token.tokenHash,
    state: token.revokedAt ? "revoked" : "active",
    timestamp: token.createdAt,
    expiresAt: token.expiresAt,
  };
}

function readinessMeta(readiness: PrivateConnectionReadiness): EntityMeta {
  return {
    ownerId: readiness.userId,
    parentId: readiness.projectId,
    alternateKey: readiness.deviceKeyId,
    timestamp: readiness.lastVerifiedAt,
    state: "ready",
  };
}

function modeRequestMeta(request: DeliveryModeChangeRequest): EntityMeta {
  return {
    ownerId: request.userId,
    parentId: request.projectId,
    state: request.status,
    timestamp: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

function surfaceMeta(surface: NotificationSurface): EntityMeta {
  return {
    parentId: surface.projectId,
    alternateKey: surface.eventType,
    state: surface.enabled ? "active" : "disabled",
    timestamp: surface.createdAt,
    revision: surface.version,
  };
}

function liveSurfaceMeta(surface: LiveSurface): EntityMeta {
  return {
    parentId: surface.projectId,
    alternateKey: surface.surfaceKey,
    state: "active",
    timestamp: surface.updatedAt,
    displayOrder: surface.displayOrder,
    revision: surface.version,
  };
}

function tokenMeta(token: IngestToken | PrivateWakeToken): EntityMeta {
  return {
    parentId: token.projectId,
    alternateKey: token.tokenHash,
    state: token.revokedAt ? "revoked" : "active",
    timestamp: token.createdAt,
    expiresAt: token.expiresAt,
  };
}

function eventMeta(event: BellwireEvent): EntityMeta {
  return {
    parentId: event.projectId,
    alternateKey: event.idempotencyKeyHash,
    secondaryKey: event.eventType,
    state: event.readAt ? "read" : "unread",
    timestamp: event.receivedAt,
  };
}

function privateWakeMeta(wake: PrivateWake): EntityMeta {
  return {
    parentId: wake.projectId,
    alternateKey: wake.idempotencyKeyHash,
    timestamp: wake.receivedAt,
  };
}

function deliveryMeta(delivery: Delivery): EntityMeta {
  return {
    parentId: delivery.eventId,
    alternateKey: delivery.deviceId,
    state: delivery.status,
    timestamp: delivery.updatedAt,
    attemptCount: delivery.attemptCount,
  };
}

function privateWakeDeliveryMeta(delivery: PrivateWakeDelivery): EntityMeta {
  return {
    parentId: delivery.wakeId,
    alternateKey: delivery.deviceId,
    state: delivery.status,
    timestamp: delivery.updatedAt,
    attemptCount: delivery.attemptCount,
  };
}

function validToken<T extends { revokedAt?: string; expiresAt?: string }>(token: T | undefined): boolean {
  return Boolean(token && !token.revokedAt && (!token.expiresAt || token.expiresAt > new Date().toISOString()));
}

function compareDisplayOrder(
  left: { displayOrder: number; id: string },
  right: { displayOrder: number; id: string },
): number {
  return left.displayOrder - right.displayOrder || left.id.localeCompare(right.id);
}

function compoundId(...values: string[]): string {
  return values.map((value) => `${value.length}:${value}`).join(":");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parse<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

function changes(result: D1Result<unknown>): number {
  return result.meta.changes ?? 0;
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint|unique|primary key/iu.test(message);
}

function periodStart(now: string): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

function periodEnd(now: string): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}

function expiredEventIdsSql(): string {
  return `
    SELECT event.id
    FROM bellwire_entities event
    JOIN bellwire_entities project
      ON project.kind = 'project' AND project.id = event.parent_id
    LEFT JOIN bellwire_entities entitlement
      ON entitlement.kind = 'entitlement' AND entitlement.owner_id = project.owner_id
    WHERE event.kind = 'event'
      AND unixepoch(event.timestamp) < unixepoch(?) - (
        CASE
          WHEN entitlement.state IN ('active', 'grace')
            AND (entitlement.expires_at IS NULL OR entitlement.expires_at > ?)
          THEN 90 ELSE 7
        END
      ) * 86400
  `;
}

function expiredEventAcceptanceSql(): string {
  return `
    DELETE FROM signal_acceptances
    WHERE entity_kind = 'event' AND entity_id IN (${expiredEventIdsSql()})
  `;
}

function expiredDeliverySql(): string {
  return `
    DELETE FROM bellwire_entities
    WHERE kind = 'delivery' AND parent_id IN (${expiredEventIdsSql()})
  `;
}

function expiredEventSql(): string {
  return `
    DELETE FROM bellwire_entities
    WHERE kind = 'event' AND id IN (${expiredEventIdsSql()})
  `;
}

function sameSurface(left: LiveSurface, right: LiveSurface): boolean {
  return left.type === right.type
    && left.title === right.title
    && left.subtitle === right.subtitle
    && stableJson(left.content) === stableJson(right.content)
    && stableJson(left.action) === stableJson(right.action)
    && stableJson(left.liveActivity) === stableJson(right.liveActivity);
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

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
