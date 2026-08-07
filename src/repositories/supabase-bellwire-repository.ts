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

type JsonRecord = Record<string, unknown>;

export class SupabaseRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Supabase request failed with status ${status}`);
    this.name = "SupabaseRequestError";
  }
}

export class SupabaseBellwireRepository implements BellwireRepository {
  private readonly restBaseUrl: string;
  private readonly authBaseUrl: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    const baseUrl = supabaseUrl.replace(/\/$/u, "");
    this.restBaseUrl = `${baseUrl}/rest/v1`;
    this.authBaseUrl = `${baseUrl}/auth/v1`;
  }

  async deleteAccount(userId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.authBaseUrl}/admin/users/${encodeURIComponent(userId)}`,
      {
        method: "DELETE",
        headers: {
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
          "content-type": "application/json",
        },
      },
    );
    if (response.ok) return;
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // Preserve non-JSON Auth responses for diagnostics.
    }
    throw new SupabaseRequestError(response.status, body);
  }

  async saveAppleRefreshToken(userId: string, encryptedRefreshToken: string): Promise<void> {
    await this.request("/apple_auth_tokens?on_conflict=user_id", {
      method: "POST",
      body: {
        user_id: userId,
        refresh_token_ciphertext: encryptedRefreshToken,
        updated_at: new Date().toISOString(),
      },
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }

  async getAppleRefreshToken(userId: string): Promise<string | undefined> {
    return this.one(
      "/apple_auth_tokens",
      { user_id: `eq.${userId}`, select: "refresh_token_ciphertext" },
      (row) => optionalString(row.refresh_token_ciphertext),
    );
  }

  async deleteAppleRefreshToken(userId: string): Promise<void> {
    await this.request(`/apple_auth_tokens?${params({ user_id: `eq.${userId}` })}`, {
      method: "DELETE",
    });
  }

  async createProject(project: Project): Promise<Project> {
    const rows = await this.request<JsonRecord[]>("/projects", {
      method: "POST",
      body: projectRow(project),
      prefer: "return=representation",
    });
    return toProject(requiredFirst(rows));
  }

  async createProjectIfAbsent(project: Project): Promise<CreateProjectResult> {
    const rows = await this.request<JsonRecord[]>("/projects?on_conflict=user_id,slug", {
      method: "POST",
      body: projectRow(project),
      prefer: "resolution=ignore-duplicates,return=representation",
    });
    if (rows[0]) return { project: toProject(rows[0]), created: true };
    const existing = await this.one(
      "/projects",
      { user_id: `eq.${project.userId}`, slug: `eq.${project.slug}` },
      toProject,
    );
    if (!existing) throw new Error("Project conflict could not be resolved");
    return { project: existing, created: false };
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    return this.one("/projects", { id: `eq.${projectId}` }, toProject);
  }

  async listProjects(userId: string): Promise<Project[]> {
    const rows = await this.getRows("/projects", {
      user_id: `eq.${userId}`,
      order: "display_order.asc,id.asc",
    });
    return rows.map(toProject);
  }

  async updateProject(project: Project): Promise<Project> {
    const rows = await this.request<JsonRecord[]>(
      `/projects?${params({ id: `eq.${project.id}` })}`,
      { method: "PATCH", body: projectRow(project), prefer: "return=representation" },
    );
    return toProject(requiredFirst(rows));
  }

  async updateProjectDisplayOrder(projectId: string, displayOrder: number): Promise<Project> {
    const rows = await this.request<JsonRecord[]>(
      `/projects?${params({ id: `eq.${projectId}` })}`,
      { method: "PATCH", body: { display_order: displayOrder }, prefer: "return=representation" },
    );
    return toProject(requiredFirst(rows));
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.request(`/projects?${params({ id: `eq.${projectId}` })}`, { method: "DELETE" });
  }

  async saveDevice(device: Device): Promise<Device> {
    const rows = await this.request<JsonRecord[]>("/rpc/register_device", {
      method: "POST",
      body: {
        p_id: device.id,
        p_user_id: device.userId,
        p_installation_id: device.installationId,
        p_name: device.name,
        p_apns_token: device.apnsToken,
        p_apns_environment: device.apnsEnvironment,
        p_app_version: device.appVersion ?? null,
        p_build_number: device.buildNumber ?? null,
        p_notification_authorization: device.notificationAuthorization ?? null,
        p_last_active_at: device.lastActiveAt,
        p_push_enabled: device.pushEnabled,
        p_created_at: device.createdAt,
      },
    });
    return toDevice(requiredFirst(rows));
  }

  async getDevice(deviceId: string): Promise<Device | undefined> {
    return this.one("/devices", { id: `eq.${deviceId}` }, toDevice);
  }

  async listDevices(userId: string): Promise<Device[]> {
    const rows = await this.getRows("/devices", {
      user_id: `eq.${userId}`,
      order: "last_active_at.desc",
    });
    return rows.map(toDevice);
  }

  async deleteDevice(deviceId: string): Promise<void> {
    const device = await this.getDevice(deviceId);
    await this.request(`/devices?${params({ id: `eq.${deviceId}` })}`, { method: "DELETE" });
    if (device) {
      await this.request(`/device_keys?${params({
        user_id: `eq.${device.userId}`,
        installation_id: `eq.${device.installationId}`,
      })}`, { method: "DELETE" });
    }
  }

  async saveDeviceBinding(binding: DeviceBinding): Promise<DeviceBinding> {
    const rows = await this.request<JsonRecord[]>("/device_bindings", {
      method: "POST",
      body: bindingRow(binding),
      prefer: "return=representation",
    });
    return toDeviceBinding(requiredFirst(rows));
  }

  async findDeviceBindingByCodeHash(codeHash: string): Promise<DeviceBinding | undefined> {
    return this.one(
      "/device_bindings",
      { code_hash: `eq.${codeHash}` },
      toDeviceBinding,
    );
  }

  async claimDeviceBinding(
    codeHash: string,
    token: Omit<AgentToken, "userId">,
    consumedAt: string,
  ): Promise<AgentToken | undefined> {
    const rows = await this.request<JsonRecord[]>("/rpc/claim_device_binding", {
      method: "POST",
      body: {
        p_code_hash: codeHash,
        p_consumed_at: consumedAt,
        p_token_id: token.id,
        p_token_name: token.name,
        p_token_hash: token.tokenHash,
        p_token_scopes: token.scopes,
        p_token_created_at: token.createdAt,
      },
    });
    return rows[0] ? toAgentToken(rows[0]) : undefined;
  }

  async saveAgentToken(token: AgentToken): Promise<AgentToken> {
    const rows = await this.request<JsonRecord[]>("/agent_tokens", {
      method: "POST",
      body: agentTokenRow(token),
      prefer: "return=representation",
    });
    return toAgentToken(requiredFirst(rows));
  }

  async listAgentTokens(userId: string): Promise<AgentToken[]> {
    const rows = await this.getRows("/agent_tokens", {
      user_id: `eq.${userId}`,
      revoked_at: "is.null",
      order: "created_at.desc",
    });
    return rows.map(toAgentToken);
  }

  async findAgentTokenByHash(tokenHash: string): Promise<AgentToken | undefined> {
    return this.one(
      "/agent_tokens",
      {
        token_hash: `eq.${tokenHash}`,
        revoked_at: "is.null",
        or: `(expires_at.is.null,expires_at.gt.${new Date().toISOString()})`,
      },
      toAgentToken,
    );
  }

  async markAgentTokenUsed(tokenId: string, usedAt: string): Promise<void> {
    await this.request(`/agent_tokens?${params({ id: `eq.${tokenId}` })}`, {
      method: "PATCH",
      body: { last_used_at: usedAt },
    });
  }

  async revokeAgentToken(tokenId: string, userId: string, revokedAt: string): Promise<void> {
    await this.request(`/agent_tokens?${params({
      id: `eq.${tokenId}`,
      user_id: `eq.${userId}`,
    })}`, {
      method: "PATCH",
      body: { revoked_at: revokedAt },
    });
  }

  async saveDeviceKey(key: DeviceKey): Promise<DeviceKey> {
    const rows = await this.request<JsonRecord[]>("/device_keys?on_conflict=user_id,id", {
      method: "POST",
      body: deviceKeyRow(key),
      prefer: "resolution=merge-duplicates,return=representation",
    });
    return toDeviceKey(requiredFirst(rows));
  }

  async getDeviceKey(keyId: string, userId: string): Promise<DeviceKey | undefined> {
    return this.one(
      "/device_keys",
      { id: `eq.${keyId}`, user_id: `eq.${userId}`, revoked_at: "is.null" },
      toDeviceKey,
    );
  }

  async saveDirectConnectionEnvelope(
    envelope: DirectConnectionEnvelope,
  ): Promise<DirectConnectionEnvelope> {
    const rows = await this.request<JsonRecord[]>("/direct_connection_envelopes", {
      method: "POST",
      body: directConnectionEnvelopeRow(envelope),
      prefer: "return=representation",
    });
    return toDirectConnectionEnvelope(requiredFirst(rows));
  }

  async listDirectConnectionEnvelopes(
    userId: string,
    deviceKeyId: string,
    now: string,
  ): Promise<DirectConnectionEnvelope[]> {
    const rows = await this.getRows("/direct_connection_envelopes", {
      user_id: `eq.${userId}`,
      device_key_id: `eq.${deviceKeyId}`,
      expires_at: `gt.${now}`,
      order: "created_at.asc",
    });
    return rows.map(toDirectConnectionEnvelope);
  }

  async acknowledgeDirectConnectionEnvelope(
    envelopeId: string,
    userId: string,
    deviceKeyId: string,
    verifiedAt: string,
  ): Promise<string | undefined> {
    const projectId = await this.request<string | null>(
      "/rpc/ack_direct_connection_envelope",
      {
        method: "POST",
        body: {
          p_envelope_id: envelopeId,
          p_user_id: userId,
          p_device_key_id: deviceKeyId,
          p_verified_at: verifiedAt,
        },
      },
    );
    return projectId ?? undefined;
  }

  async getPrivateConnectionReadiness(
    projectId: string,
    deviceKeyId: string,
  ): Promise<PrivateConnectionReadiness | undefined> {
    return this.one(
      "/private_connection_readiness",
      { project_id: `eq.${projectId}`, device_key_id: `eq.${deviceKeyId}` },
      toPrivateConnectionReadiness,
    );
  }

  async listPrivateConnectionReadiness(
    projectId: string,
  ): Promise<PrivateConnectionReadiness[]> {
    const rows = await this.getRows("/private_connection_readiness", {
      project_id: `eq.${projectId}`,
      order: "ready_at.asc",
    });
    return rows.map(toPrivateConnectionReadiness);
  }

  async getDirectConnectionRecoveryRequest(
    projectId: string,
    deviceKeyId: string,
  ): Promise<DirectConnectionRecoveryRequest | undefined> {
    return this.one(
      "/direct_connection_recovery_requests",
      { project_id: `eq.${projectId}`, device_key_id: `eq.${deviceKeyId}` },
      toDirectConnectionRecoveryRequest,
    );
  }

  async saveDirectConnectionRecoveryRequestIfAbsent(
    request: DirectConnectionRecoveryRequest,
  ): Promise<{ request: DirectConnectionRecoveryRequest; created: boolean }> {
    const rows = await this.request<JsonRecord[]>(
      "/direct_connection_recovery_requests?on_conflict=project_id,device_key_id",
      {
        method: "POST",
        body: directConnectionRecoveryRequestRow(request),
        prefer: "resolution=ignore-duplicates,return=representation",
      },
    );
    const saved = rows[0]
      ? toDirectConnectionRecoveryRequest(rows[0])
      : await this.getDirectConnectionRecoveryRequest(request.projectId, request.deviceKeyId);
    if (!saved) throw new Error("Supabase did not return the recovery request");
    return { request: saved, created: rows.length > 0 };
  }

  async listDirectConnectionRecoveryRequests(
    userId: string,
  ): Promise<DirectConnectionRecoveryRequest[]> {
    const rows = await this.getRows("/direct_connection_recovery_requests", {
      user_id: `eq.${userId}`,
      order: "requested_at.asc",
    });
    return rows.map(toDirectConnectionRecoveryRequest);
  }

  async deleteDirectConnectionRecoveryRequest(
    projectId: string,
    deviceKeyId: string,
  ): Promise<void> {
    await this.request(`/direct_connection_recovery_requests?${params({
      project_id: `eq.${projectId}`,
      device_key_id: `eq.${deviceKeyId}`,
    })}`, { method: "DELETE" });
  }

  async saveDeliveryModeChangeRequest(
    request: DeliveryModeChangeRequest,
  ): Promise<DeliveryModeChangeRequest> {
    const rows = await this.request<JsonRecord[]>("/delivery_mode_change_requests", {
      method: "POST",
      body: deliveryModeChangeRequestRow(request),
      prefer: "return=representation",
    });
    return toDeliveryModeChangeRequest(requiredFirst(rows));
  }

  async listDeliveryModeChangeRequests(
    userId: string,
    status?: DeliveryModeChangeRequest["status"],
  ): Promise<DeliveryModeChangeRequest[]> {
    const rows = await this.getRows("/delivery_mode_change_requests", {
      user_id: `eq.${userId}`,
      ...(status ? { status: `eq.${status}` } : {}),
      order: "created_at.desc",
    });
    return rows.map(toDeliveryModeChangeRequest);
  }

  async resolveDeliveryModeChangeRequest(
    requestId: string,
    userId: string,
    approved: boolean,
    resolvedAt: string,
  ): Promise<DeliveryModeChangeRequest | undefined> {
    const rows = await this.request<JsonRecord[]>("/rpc/resolve_delivery_mode_request", {
      method: "POST",
      body: {
        p_request_id: requestId,
        p_user_id: userId,
        p_approved: approved,
        p_resolved_at: resolvedAt,
      },
    });
    return rows[0] ? toDeliveryModeChangeRequest(rows[0]) : undefined;
  }

  async saveEventSchema(schema: EventSchema): Promise<EventSchema> {
    const rows = await this.request<JsonRecord[]>("/rpc/save_event_schema_version", {
      method: "POST",
      body: {
        p_id: schema.id,
        p_project_id: schema.projectId,
        p_event_type: schema.eventType,
        p_fields: schema.fields,
        p_status: schema.status,
        p_created_at: schema.createdAt,
      },
    });
    return toEventSchema(requiredFirst(rows));
  }

  async ensureEventSchemaAndNotificationSurface(
    schema: EventSchema,
    surface: NotificationSurface,
  ): Promise<{ schema: EventSchema; surface: NotificationSurface }> {
    const [existingSchema, existingSurface] = await Promise.all([
      this.getEventSchema(schema.projectId, schema.eventType),
      this.getNotificationSurface(surface.projectId, surface.eventType),
    ]);
    const [schemaRows, surfaceRows] = await Promise.all([
      existingSchema ? Promise.resolve([]) : this.request<JsonRecord[]>(
        "/event_schemas?on_conflict=project_id,event_type,version",
        {
          method: "POST",
          body: eventSchemaRow(schema),
          prefer: "resolution=ignore-duplicates,return=representation",
        },
      ),
      existingSurface ? Promise.resolve([]) : this.request<JsonRecord[]>(
        "/notification_surfaces?on_conflict=project_id,event_type,version",
        {
          method: "POST",
          body: notificationSurfaceRow(surface),
          prefer: "resolution=ignore-duplicates,return=representation",
        },
      ),
    ]);
    const [savedSchema, savedSurface] = await Promise.all([
      existingSchema ? Promise.resolve(existingSchema)
        : schemaRows[0] ? Promise.resolve(toEventSchema(schemaRows[0]))
        : this.getEventSchema(schema.projectId, schema.eventType),
      existingSurface ? Promise.resolve(existingSurface)
        : surfaceRows[0] ? Promise.resolve(toSurface(surfaceRows[0]))
        : this.getNotificationSurface(surface.projectId, surface.eventType),
    ]);
    if (!savedSchema || !savedSurface) {
      throw new Error("Demo configuration conflict could not be resolved");
    }
    return { schema: savedSchema, surface: savedSurface };
  }

  async getEventSchema(projectId: string, eventType: string): Promise<EventSchema | undefined> {
    return this.one(
      "/event_schemas",
      {
        project_id: `eq.${projectId}`,
        event_type: `eq.${eventType}`,
        status: "eq.active",
        order: "version.desc",
      },
      toEventSchema,
    );
  }

  async listEventSchemas(projectId: string): Promise<EventSchema[]> {
    const rows = await this.getRows("/active_event_schemas", {
      project_id: `eq.${projectId}`,
      order: "event_type.asc",
    });
    return rows.map(toEventSchema);
  }

  async saveNotificationSurface(surface: NotificationSurface): Promise<NotificationSurface> {
    const rows = await this.request<JsonRecord[]>("/rpc/save_notification_surface_version", {
      method: "POST",
      body: {
        p_id: surface.id,
        p_project_id: surface.projectId,
        p_event_type: surface.eventType,
        p_title_template: surface.titleTemplate,
        p_body_template: surface.bodyTemplate,
        p_subtitle_template: surface.subtitleTemplate ?? null,
        p_sound: surface.sound,
        p_group_name: surface.group,
        p_priority: surface.priority,
        p_enabled: surface.enabled,
        p_created_at: surface.createdAt,
      },
    });
    return toSurface(requiredFirst(rows));
  }

  async getNotificationSurface(
    projectId: string,
    eventType: string,
  ): Promise<NotificationSurface | undefined> {
    return this.one(
      "/notification_surfaces",
      {
        project_id: `eq.${projectId}`,
        event_type: `eq.${eventType}`,
        order: "version.desc",
      },
      toSurface,
    );
  }

  async listNotificationSurfaces(projectId: string): Promise<NotificationSurface[]> {
    const rows = await this.getRows("/active_notification_surfaces", {
      project_id: `eq.${projectId}`,
      order: "event_type.asc",
    });
    return rows.map(toSurface);
  }

  async saveLiveSurface(surface: LiveSurface): Promise<LiveSurface> {
    const rows = await this.request<JsonRecord[]>("/rpc/save_live_surface_version", {
      method: "POST",
      body: {
        p_id: surface.id,
        p_project_id: surface.projectId,
        p_surface_key: surface.surfaceKey,
        p_type: surface.type,
        p_title: surface.title,
        p_subtitle: surface.subtitle ?? null,
        p_content: surface.content,
        p_action: surface.action ?? null,
        p_display_order: surface.displayOrder,
        p_created_at: surface.createdAt,
        p_updated_at: surface.updatedAt,
      },
    });
    return toLiveSurface(requiredFirst(rows));
  }

  async acceptHostedSurface(
    surface: LiveSurface,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredLiveSurfaceWrite> {
    const rows = await this.request<JsonRecord[]>("/rpc/accept_hosted_surface_signal", {
      method: "POST",
      body: {
        p_id: surface.id,
        p_project_id: surface.projectId,
        p_surface_key: surface.surfaceKey,
        p_type: surface.type,
        p_title: surface.title,
        p_subtitle: surface.subtitle ?? null,
        p_content: surface.content,
        p_action: surface.action ?? null,
        p_display_order: surface.displayOrder,
        p_created_at: surface.createdAt,
        p_updated_at: surface.updatedAt,
        p_enforcement_mode: enforcementMode,
      },
    });
    return toMeteredLiveSurfaceWrite(requiredFirst(rows));
  }

  async getLiveSurface(projectId: string, surfaceKey: string): Promise<LiveSurface | undefined> {
    return this.one(
      "/live_surfaces",
      { project_id: `eq.${projectId}`, surface_key: `eq.${surfaceKey}` },
      toLiveSurface,
    );
  }

  async listLiveSurfaces(projectId: string): Promise<LiveSurface[]> {
    const rows = await this.getRows("/live_surfaces", {
      project_id: `eq.${projectId}`,
      order: "display_order.asc,id.asc",
    });
    return rows.map(toLiveSurface);
  }

  async updateLiveSurfaceDisplayOrder(surfaceId: string, displayOrder: number): Promise<LiveSurface> {
    const rows = await this.request<JsonRecord[]>(
      `/live_surfaces?${params({ id: `eq.${surfaceId}` })}`,
      { method: "PATCH", body: { display_order: displayOrder }, prefer: "return=representation" },
    );
    return toLiveSurface(requiredFirst(rows));
  }

  async deleteLiveSurface(surfaceId: string): Promise<void> {
    await this.request(`/live_surfaces?${params({ id: `eq.${surfaceId}` })}`, { method: "DELETE" });
  }

  async saveIngestToken(token: IngestToken): Promise<IngestToken> {
    const rows = await this.request<JsonRecord[]>("/ingest_tokens", {
      method: "POST",
      body: ingestTokenRow(token),
      prefer: "return=representation",
    });
    return toIngestToken(requiredFirst(rows));
  }

  async listIngestTokens(projectId: string): Promise<IngestToken[]> {
    const rows = await this.getRows("/ingest_tokens", {
      project_id: `eq.${projectId}`,
      order: "created_at.desc",
    });
    return rows.map(toIngestToken);
  }

  async findIngestTokenByHash(
    projectId: string,
    tokenHash: string,
  ): Promise<IngestToken | undefined> {
    return this.one(
      "/ingest_tokens",
      {
        project_id: `eq.${projectId}`,
        token_hash: `eq.${tokenHash}`,
        revoked_at: "is.null",
        or: `(expires_at.is.null,expires_at.gt.${new Date().toISOString()})`,
      },
      toIngestToken,
    );
  }

  async markIngestTokenUsed(tokenId: string, usedAt: string): Promise<void> {
    await this.request(`/ingest_tokens?${params({ id: `eq.${tokenId}` })}`, {
      method: "PATCH",
      body: { last_used_at: usedAt },
    });
  }

  async revokeIngestToken(tokenId: string, revokedAt: string): Promise<void> {
    await this.request(`/ingest_tokens?${params({ id: `eq.${tokenId}` })}`, {
      method: "PATCH",
      body: { revoked_at: revokedAt },
    });
  }

  async savePrivateWakeToken(token: PrivateWakeToken): Promise<PrivateWakeToken> {
    const rows = await this.request<JsonRecord[]>("/private_wake_tokens", {
      method: "POST",
      body: privateWakeTokenRow(token),
      prefer: "return=representation",
    });
    return toPrivateWakeToken(requiredFirst(rows));
  }

  async listPrivateWakeTokens(projectId: string): Promise<PrivateWakeToken[]> {
    const rows = await this.getRows("/private_wake_tokens", {
      project_id: `eq.${projectId}`,
      order: "created_at.desc",
    });
    return rows.map(toPrivateWakeToken);
  }

  async findPrivateWakeTokenByHash(
    projectId: string,
    tokenHash: string,
  ): Promise<PrivateWakeToken | undefined> {
    return this.one(
      "/private_wake_tokens",
      {
        project_id: `eq.${projectId}`,
        token_hash: `eq.${tokenHash}`,
        revoked_at: "is.null",
        or: `(expires_at.is.null,expires_at.gt.${new Date().toISOString()})`,
      },
      toPrivateWakeToken,
    );
  }

  async markPrivateWakeTokenUsed(tokenId: string, usedAt: string): Promise<void> {
    await this.request(`/private_wake_tokens?${params({ id: `eq.${tokenId}` })}`, {
      method: "PATCH",
      body: { last_used_at: usedAt },
    });
  }

  async revokePrivateWakeToken(tokenId: string, revokedAt: string): Promise<void> {
    await this.request(`/private_wake_tokens?${params({ id: `eq.${tokenId}` })}`, {
      method: "PATCH",
      body: { revoked_at: revokedAt },
    });
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    return this.request<boolean>("/rpc/consume_ingest_quota", {
      method: "POST",
      body: { p_key: key, p_limit: limit, p_window_seconds: windowSeconds },
    });
  }

  async acceptHostedEvent(
    event: BellwireEvent,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredEventWrite> {
    const rows = await this.request<JsonRecord[]>("/rpc/accept_hosted_event_signal", {
      method: "POST",
      body: {
        p_id: event.id,
        p_project_id: event.projectId,
        p_event_type: event.eventType,
        p_idempotency_key_hash: event.idempotencyKeyHash,
        p_data: event.data,
        p_sensitive_fields: event.sensitiveFields ?? Object.keys(event.data),
        p_occurred_at: event.occurredAt,
        p_received_at: event.receivedAt,
        p_enforcement_mode: enforcementMode,
      },
    });
    return toMeteredEventWrite(requiredFirst(rows));
  }

  async acceptPrivateWake(
    wake: PrivateWake,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredPrivateWakeWrite> {
    const rows = await this.request<JsonRecord[]>("/rpc/accept_private_wake_signal", {
      method: "POST",
      body: {
        p_id: wake.id,
        p_project_id: wake.projectId,
        p_idempotency_key_hash: wake.idempotencyKeyHash,
        p_reference: wake.reference ?? null,
        p_priority: wake.priority,
        p_received_at: wake.receivedAt,
        p_reference_expires_at: wake.referenceExpiresAt,
        p_enforcement_mode: enforcementMode,
      },
    });
    return toMeteredPrivateWakeWrite(requiredFirst(rows));
  }

  async getPrivateWake(wakeId: string): Promise<PrivateWake | undefined> {
    return this.one("/private_wakes", { id: `eq.${wakeId}` }, toPrivateWake);
  }

  async clearPrivateWakeReference(wakeId: string): Promise<void> {
    await this.request(`/private_wakes?${params({ id: `eq.${wakeId}` })}`, {
      method: "PATCH",
      body: { reference: null },
    });
  }

  async listEvents(projectId: string, options: EventListOptions): Promise<EventListPage> {
    const query: Record<string, string> = {
      project_id: `eq.${projectId}`,
      order: "received_at.desc,id.desc",
      limit: String(options.limit + 1),
    };
    if (options.cursor) {
      const cursor = decodeEventCursor(options.cursor);
      query.or = `(received_at.lt.${cursor.receivedAt},and(received_at.eq.${cursor.receivedAt},id.lt.${cursor.id}))`;
    }
    if (options.eventType) query.event_type = `eq.${options.eventType}`;
    if (options.unreadOnly) query.read_at = "is.null";
    const rows = await this.getRows("/events", query);
    const hasMore = rows.length > options.limit;
    const events = rows.slice(0, options.limit).map(toEvent);
    return {
      events,
      ...(hasMore && events.at(-1) ? {
        nextCursor: encodeEventCursor({
          receivedAt: events.at(-1)!.receivedAt,
          id: events.at(-1)!.id,
        }),
      } : {}),
    };
  }

  async getEvent(eventId: string): Promise<BellwireEvent | undefined> {
    return this.one("/events", { id: `eq.${eventId}` }, toEvent);
  }

  async getEventByIdempotencyHash(
    projectId: string,
    idempotencyKeyHash: string,
  ): Promise<BellwireEvent | undefined> {
    return this.one(
      "/events",
      {
        project_id: `eq.${projectId}`,
        idempotency_key_hash: `eq.${idempotencyKeyHash}`,
      },
      toEvent,
    );
  }

  async replaceEventIdempotencyHash(
    eventId: string,
    expectedHash: string,
    replacementHash: string,
  ): Promise<BellwireEvent | undefined> {
    const rows = await this.request<JsonRecord[]>(
      `/events?${params({
        id: `eq.${eventId}`,
        idempotency_key_hash: `eq.${expectedHash}`,
      })}`,
      {
        method: "PATCH",
        body: { idempotency_key_hash: replacementHash },
        prefer: "return=representation",
      },
    );
    return rows[0] ? toEvent(rows[0]) : undefined;
  }

  async markEventRead(eventId: string, readAt: string): Promise<void> {
    await this.request(`/events?${params({ id: `eq.${eventId}` })}`, {
      method: "PATCH",
      body: { read_at: readAt },
    });
  }

  async markAllEventsRead(projectIds: string[], readAt: string): Promise<number> {
    if (projectIds.length === 0) return 0;
    const rows = await this.request<JsonRecord[]>(
      `/events?${params({
        project_id: `in.(${projectIds.join(",")})`,
        read_at: "is.null",
        select: "id",
      })}`,
      { method: "PATCH", body: { read_at: readAt }, prefer: "return=representation" },
    );
    return rows.length;
  }

  async createDeliveryIfAbsent(delivery: Delivery): Promise<CreateDeliveryResult> {
    const rows = await this.request<JsonRecord[]>(
      "/deliveries?on_conflict=event_id,device_id",
      {
        method: "POST",
        body: deliveryRow(delivery),
        prefer: "resolution=ignore-duplicates,return=representation",
      },
    );
    if (rows[0]) return { delivery: toDelivery(rows[0]), created: true };
    const existing = await this.one(
      "/deliveries",
      { event_id: `eq.${delivery.eventId}`, device_id: `eq.${delivery.deviceId}` },
      toDelivery,
    );
    if (!existing) throw new Error("Delivery conflict could not be resolved");
    return { delivery: existing, created: false };
  }

  async claimDelivery(
    deliveryId: string,
    claimedAt: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<Delivery | undefined> {
    const rows = await this.request<JsonRecord[]>("/rpc/claim_delivery", {
      method: "POST",
      body: {
        p_delivery_id: deliveryId,
        p_claimed_at: claimedAt,
        p_lease_seconds: leaseSeconds,
        p_max_attempts: maxAttempts,
      },
    });
    return rows[0] ? toDelivery(rows[0]) : undefined;
  }

  async completeClaimedDelivery(delivery: Delivery): Promise<Delivery | undefined> {
    const rows = await this.request<JsonRecord[]>(
      `/deliveries?${params({
        id: `eq.${delivery.id}`,
        status: "eq.queued",
        attempt_count: `eq.${delivery.attemptCount}`,
      })}`,
      { method: "PATCH", body: deliveryRow(delivery), prefer: "return=representation" },
    );
    return rows[0] ? toDelivery(rows[0]) : undefined;
  }

  async recordQueueUnavailable(
    expected: Delivery,
    failedAt: string,
    message: string,
  ): Promise<Delivery | undefined> {
    const rows = await this.request<JsonRecord[]>("/rpc/record_queue_unavailable", {
      method: "POST",
      body: {
        p_delivery_id: expected.id,
        p_expected_status: expected.status,
        p_expected_attempt_count: expected.attemptCount,
        p_expected_updated_at: expected.updatedAt,
        p_failed_at: failedAt,
        p_error_message: message,
      },
    });
    return rows[0] ? toDelivery(rows[0]) : undefined;
  }

  async updateDelivery(delivery: Delivery): Promise<Delivery> {
    const rows = await this.request<JsonRecord[]>(
      `/deliveries?${params({ id: `eq.${delivery.id}` })}`,
      { method: "PATCH", body: deliveryRow(delivery), prefer: "return=representation" },
    );
    return toDelivery(requiredFirst(rows));
  }

  async listDeliveries(eventId: string): Promise<Delivery[]> {
    const rows = await this.getRows("/deliveries", {
      event_id: `eq.${eventId}`,
      order: "queued_at.asc",
    });
    return rows.map(toDelivery);
  }

  async getDeliveryHealth(projectId: string, since: string): Promise<DeliveryHealth> {
    const project = await this.getProject(projectId);
    const rows = project?.deliveryMode === "private"
      ? await this.getRows("/private_wake_deliveries", {
          select: "status,private_wakes!inner(project_id)",
          "private_wakes.project_id": `eq.${projectId}`,
          updated_at: `gte.${since}`,
        })
      : await this.getRows("/deliveries", {
          select: "status,events!inner(project_id)",
          "events.project_id": `eq.${projectId}`,
          updated_at: `gte.${since}`,
        });
    const statuses = rows.map((row) => String(row.status));
    const queued = statuses.filter((status) => status === "queued").length;
    const accepted = statuses.filter((status) => status === "accepted_by_apns").length;
    const failed = statuses.filter((status) => status === "failed").length;
    return {
      queued,
      accepted,
      failed,
      status: statuses.length === 0 ? "idle" : failed > 0 ? "degraded" : "healthy",
    };
  }

  async createPrivateWakeDeliveryIfAbsent(
    delivery: PrivateWakeDelivery,
  ): Promise<{ delivery: PrivateWakeDelivery; created: boolean }> {
    const rows = await this.request<JsonRecord[]>(
      "/private_wake_deliveries?on_conflict=wake_id,device_id",
      {
        method: "POST",
        body: privateWakeDeliveryRow(delivery),
        prefer: "resolution=ignore-duplicates,return=representation",
      },
    );
    if (rows[0]) return { delivery: toPrivateWakeDelivery(rows[0]), created: true };
    const existing = await this.one(
      "/private_wake_deliveries",
      { wake_id: `eq.${delivery.wakeId}`, device_id: `eq.${delivery.deviceId}` },
      toPrivateWakeDelivery,
    );
    if (!existing) throw new Error("Private wake delivery conflict could not be resolved");
    return { delivery: existing, created: false };
  }

  async listPrivateWakeDeliveries(wakeId: string): Promise<PrivateWakeDelivery[]> {
    const rows = await this.getRows("/private_wake_deliveries", {
      wake_id: `eq.${wakeId}`,
      order: "queued_at.asc",
    });
    return rows.map(toPrivateWakeDelivery);
  }

  async claimPrivateWakeDelivery(
    deliveryId: string,
    claimedAt: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<PrivateWakeDelivery | undefined> {
    const rows = await this.request<JsonRecord[]>("/rpc/claim_private_wake_delivery", {
      method: "POST",
      body: {
        p_delivery_id: deliveryId,
        p_claimed_at: claimedAt,
        p_lease_seconds: leaseSeconds,
        p_max_attempts: maxAttempts,
      },
    });
    return rows[0] ? toPrivateWakeDelivery(rows[0]) : undefined;
  }

  async completeClaimedPrivateWakeDelivery(
    delivery: PrivateWakeDelivery,
  ): Promise<PrivateWakeDelivery | undefined> {
    const rows = await this.request<JsonRecord[]>(
      `/private_wake_deliveries?${params({
        id: `eq.${delivery.id}`,
        status: "eq.queued",
        attempt_count: `eq.${delivery.attemptCount}`,
      })}`,
      {
        method: "PATCH",
        body: privateWakeDeliveryRow(delivery),
        prefer: "return=representation",
      },
    );
    return rows[0] ? toPrivateWakeDelivery(rows[0]) : undefined;
  }

  async updatePrivateWakeDelivery(
    delivery: PrivateWakeDelivery,
  ): Promise<PrivateWakeDelivery> {
    const rows = await this.request<JsonRecord[]>(
      `/private_wake_deliveries?${params({ id: `eq.${delivery.id}` })}`,
      {
        method: "PATCH",
        body: privateWakeDeliveryRow(delivery),
        prefer: "return=representation",
      },
    );
    return toPrivateWakeDelivery(requiredFirst(rows));
  }

  async getAccountEntitlement(userId: string, now: string): Promise<AccountEntitlement> {
    const rows = await this.request<JsonRecord[]>("/rpc/account_entitlement_snapshot", {
      method: "POST",
      body: { p_user_id: userId, p_now: now },
    });
    return toAccountEntitlement(requiredFirst(rows));
  }

  async saveAppleTransaction(transaction: AppleTransactionRecord): Promise<void> {
    await this.request("/rpc/record_verified_apple_transaction", {
      method: "POST",
      body: {
        p_transaction_id: transaction.transactionId,
        p_original_transaction_id: transaction.originalTransactionId,
        p_user_id: transaction.userId,
        p_product_id: transaction.productId,
        p_environment: transaction.environment,
        p_purchase_date: transaction.purchaseDate,
        p_expires_at: transaction.expiresAt ?? null,
        p_revocation_date: transaction.revocationDate ?? null,
        p_status: transaction.status,
        p_signed_date: transaction.signedDate,
        p_updated_at: transaction.updatedAt,
      },
    });
  }

  async saveAppleNotificationReceipt(
    notificationUUID: string,
    notificationType: string,
    subtype: string | undefined,
    signedDate: string,
  ): Promise<boolean> {
    const rows = await this.request<JsonRecord[]>(
      "/apple_notification_receipts?on_conflict=notification_uuid",
      {
        method: "POST",
        body: {
          notification_uuid: notificationUUID,
          notification_type: notificationType,
          subtype: subtype ?? null,
          signed_date: signedDate,
        },
        prefer: "resolution=ignore-duplicates,return=representation",
      },
    );
    return rows.length > 0;
  }

  async runMaintenance(now: string): Promise<unknown> {
    return this.request("/rpc/cleanup_bellwire_retention", {
      method: "POST",
      body: { p_now: now },
    });
  }

  private async one<T>(
    path: string,
    query: Record<string, string>,
    transform: (row: JsonRecord) => T,
  ): Promise<T | undefined> {
    const rows = await this.getRows(path, { ...query, limit: "1" });
    return rows[0] ? transform(rows[0]) : undefined;
  }

  private getRows(path: string, query: Record<string, string>): Promise<JsonRecord[]> {
    return this.request<JsonRecord[]>(`${path}?${params(query)}`, { method: "GET" });
  }

  private async request<T = unknown>(
    path: string,
    options: { method: string; body?: unknown; prefer?: string },
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.restBaseUrl}${path}`, {
      method: options.method,
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        ...(options.prefer ? { prefer: options.prefer } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      let body: unknown = text;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // Preserve non-JSON PostgREST responses for diagnostics.
      }
      throw new SupabaseRequestError(response.status, body);
    }
    if (response.status === 204 || text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }
}

function params(values: Record<string, string>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) query.set(key, value);
  return query.toString();
}

function requiredFirst(rows: JsonRecord[]): JsonRecord {
  const row = rows[0];
  if (!row) throw new Error("Supabase did not return the saved row");
  return row;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function projectRow(value: Project): JsonRecord {
  return {
    id: value.id, user_id: value.userId, name: value.name, slug: value.slug,
    icon: value.icon, logo_url: value.logoUrl ?? null, display_order: value.displayOrder,
    category: value.category, status: value.status, delivery_mode: value.deliveryMode,
    endpoint: value.endpoint, created_at: value.createdAt, updated_at: value.updatedAt,
  };
}

function eventSchemaRow(value: EventSchema): JsonRecord {
  return {
    id: value.id,
    project_id: value.projectId,
    event_type: value.eventType,
    fields: value.fields,
    version: value.version,
    status: value.status,
    created_at: value.createdAt,
  };
}

function notificationSurfaceRow(value: NotificationSurface): JsonRecord {
  return {
    id: value.id,
    project_id: value.projectId,
    event_type: value.eventType,
    type: value.type,
    title_template: value.titleTemplate,
    body_template: value.bodyTemplate,
    subtitle_template: value.subtitleTemplate ?? null,
    sound: value.sound,
    group_name: value.group,
    priority: value.priority,
    enabled: value.enabled,
    version: value.version,
    created_at: value.createdAt,
  };
}

function toProject(row: JsonRecord): Project {
  return {
    id: String(row.id), userId: String(row.user_id), name: String(row.name),
    slug: String(row.slug), icon: String(row.icon), logoUrl: optionalString(row.logo_url),
    displayOrder: Number(row.display_order), category: String(row.category),
    status: row.status === "paused" ? "paused" : "active",
    deliveryMode: row.delivery_mode === "hosted" ? "hosted" : "private",
    endpoint: String(row.endpoint),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function toDevice(row: JsonRecord): Device {
  return {
    id: String(row.id), userId: String(row.user_id), installationId: String(row.installation_id),
    name: String(row.name), platform: "ios",
    apnsToken: String(row.apns_token),
    apnsEnvironment: row.apns_environment === "sandbox" ? "sandbox" : "production",
    appVersion: optionalString(row.app_version),
    buildNumber: optionalString(row.build_number),
    notificationAuthorization: toNotificationAuthorizationDiagnostic(
      row.notification_authorization,
    ),
    lastActiveAt: String(row.last_active_at), pushEnabled: row.push_enabled === true,
    createdAt: String(row.created_at),
  };
}

function bindingRow(value: DeviceBinding): JsonRecord {
  return {
    id: value.id, user_id: value.userId, code_hash: value.codeHash,
    device_key_id: value.deviceKeyId ?? null,
    expires_at: value.expiresAt, consumed_at: value.consumedAt ?? null, created_at: value.createdAt,
  };
}

function toDeviceBinding(row: JsonRecord): DeviceBinding {
  return {
    id: String(row.id), userId: String(row.user_id), codeHash: String(row.code_hash),
    deviceKeyId: optionalString(row.device_key_id),
    expiresAt: String(row.expires_at), consumedAt: optionalString(row.consumed_at),
    createdAt: String(row.created_at),
  };
}

function deviceKeyRow(value: DeviceKey): JsonRecord {
  return {
    id: value.id,
    user_id: value.userId,
    installation_id: value.installationId,
    agreement_public_key: value.agreementPublicKey,
    signing_public_key: value.signingPublicKey,
    algorithm: value.algorithm,
    created_at: value.createdAt,
    last_active_at: value.lastActiveAt,
    revoked_at: value.revokedAt ?? null,
  };
}

function toDeviceKey(row: JsonRecord): DeviceKey {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    installationId: String(row.installation_id),
    agreementPublicKey: String(row.agreement_public_key),
    signingPublicKey: String(row.signing_public_key),
    algorithm: "p256",
    createdAt: String(row.created_at),
    lastActiveAt: String(row.last_active_at),
    revokedAt: optionalString(row.revoked_at),
  };
}

function directConnectionEnvelopeRow(value: DirectConnectionEnvelope): JsonRecord {
  return {
    id: value.id,
    user_id: value.userId,
    device_key_id: value.deviceKeyId,
    project_id: value.projectId,
    manifest_version: value.manifestVersion,
    algorithm: value.algorithm,
    ephemeral_public_key: value.ephemeralPublicKey,
    sealed_box: value.sealedBox,
    created_at: value.createdAt,
    expires_at: value.expiresAt,
  };
}

function toDirectConnectionEnvelope(row: JsonRecord): DirectConnectionEnvelope {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    deviceKeyId: String(row.device_key_id),
    projectId: String(row.project_id),
    manifestVersion: 2,
    algorithm: "p256-hkdf-sha256-aes-gcm",
    ephemeralPublicKey: String(row.ephemeral_public_key),
    sealedBox: String(row.sealed_box),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
}

function toPrivateConnectionReadiness(row: JsonRecord): PrivateConnectionReadiness {
  return {
    projectId: String(row.project_id),
    deviceKeyId: String(row.device_key_id),
    userId: String(row.user_id),
    manifestVersion: 2,
    readyAt: String(row.ready_at),
    lastVerifiedAt: String(row.last_verified_at),
    lastSyncAt: optionalString(row.last_sync_at),
    lastErrorCode: optionalString(row.last_error_code),
  };
}

function directConnectionRecoveryRequestRow(
  value: DirectConnectionRecoveryRequest,
): JsonRecord {
  return {
    user_id: value.userId,
    project_id: value.projectId,
    device_key_id: value.deviceKeyId,
    installation_id: value.installationId,
    app_version: value.appVersion ?? null,
    build_number: value.buildNumber ?? null,
    notification_authorization: value.notificationAuthorization ?? null,
    requested_at: value.requestedAt,
  };
}

function toDirectConnectionRecoveryRequest(row: JsonRecord): DirectConnectionRecoveryRequest {
  return {
    userId: String(row.user_id),
    projectId: String(row.project_id),
    deviceKeyId: String(row.device_key_id),
    installationId: String(row.installation_id),
    appVersion: optionalString(row.app_version),
    buildNumber: optionalString(row.build_number),
    notificationAuthorization: toNotificationAuthorizationDiagnostic(
      row.notification_authorization,
    ),
    requestedAt: String(row.requested_at),
  };
}

function toNotificationAuthorizationDiagnostic(value: unknown) {
  return value === "unknown" || value === "not_determined" || value === "denied" ||
      value === "authorized" || value === "provisional" || value === "ephemeral"
    ? value
    : undefined;
}

function deliveryModeChangeRequestRow(value: DeliveryModeChangeRequest): JsonRecord {
  return {
    id: value.id,
    project_id: value.projectId,
    user_id: value.userId,
    requested_by_token_id: value.requestedByTokenId,
    from_mode: value.fromMode,
    to_mode: value.toMode,
    status: value.status,
    created_at: value.createdAt,
    expires_at: value.expiresAt,
    resolved_at: value.resolvedAt ?? null,
  };
}

function toDeliveryModeChangeRequest(row: JsonRecord): DeliveryModeChangeRequest {
  const status = String(row.status);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    userId: String(row.user_id),
    requestedByTokenId: String(row.requested_by_token_id),
    fromMode: row.from_mode === "hosted" ? "hosted" : "private",
    toMode: row.to_mode === "hosted" ? "hosted" : "private",
    status: status === "approved" || status === "rejected" || status === "expired"
      ? status
      : "pending",
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    resolvedAt: optionalString(row.resolved_at),
  };
}

function agentTokenRow(value: AgentToken): JsonRecord {
  return {
    id: value.id, user_id: value.userId, name: value.name, token_hash: value.tokenHash,
    scopes: value.scopes, created_at: value.createdAt, last_used_at: value.lastUsedAt ?? null,
    expires_at: value.expiresAt ?? null, revoked_at: value.revokedAt ?? null,
  };
}

function toAgentToken(row: JsonRecord): AgentToken {
  return {
    id: String(row.id), userId: String(row.user_id), name: String(row.name),
    tokenHash: String(row.token_hash), scopes: row.scopes as AgentToken["scopes"],
    createdAt: String(row.created_at), lastUsedAt: optionalString(row.last_used_at),
    expiresAt: optionalString(row.expires_at), revokedAt: optionalString(row.revoked_at),
  };
}

function toEventSchema(row: JsonRecord): EventSchema {
  return {
    id: String(row.id), projectId: String(row.project_id), eventType: String(row.event_type),
    fields: row.fields as EventSchema["fields"], version: Number(row.version),
    status: "active", createdAt: String(row.created_at),
  };
}

function toSurface(row: JsonRecord): NotificationSurface {
  return {
    id: String(row.id), projectId: String(row.project_id), eventType: String(row.event_type),
    type: "notification", titleTemplate: String(row.title_template), bodyTemplate: String(row.body_template),
    subtitleTemplate: optionalString(row.subtitle_template), sound: String(row.sound),
    group: String(row.group_name), priority: row.priority === "high" ? "high" : "normal",
    enabled: row.enabled === true, version: Number(row.version), createdAt: String(row.created_at),
  };
}

function toLiveSurface(row: JsonRecord): LiveSurface {
  return {
    id: String(row.id), projectId: String(row.project_id), surfaceKey: String(row.surface_key),
    type: row.type as LiveSurface["type"], title: String(row.title),
    subtitle: optionalString(row.subtitle), content: row.content as Record<string, unknown>,
    ...(row.action && typeof row.action === "object"
      ? { action: row.action as unknown as LiveSurface["action"] }
      : {}),
    displayOrder: Number(row.display_order), version: Number(row.version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function ingestTokenRow(value: IngestToken): JsonRecord {
  return {
    id: value.id, project_id: value.projectId, name: value.name, token_hash: value.tokenHash,
    scope: value.scope, created_at: value.createdAt, last_used_at: value.lastUsedAt ?? null,
    expires_at: value.expiresAt ?? null, revoked_at: value.revokedAt ?? null,
  };
}

function toIngestToken(row: JsonRecord): IngestToken {
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name),
    tokenHash: String(row.token_hash), scope: "event:ingest", createdAt: String(row.created_at),
    lastUsedAt: optionalString(row.last_used_at), expiresAt: optionalString(row.expires_at),
    revokedAt: optionalString(row.revoked_at),
  };
}

function privateWakeTokenRow(value: PrivateWakeToken): JsonRecord {
  return {
    id: value.id,
    project_id: value.projectId,
    name: value.name,
    token_hash: value.tokenHash,
    scope: value.scope,
    created_at: value.createdAt,
    last_used_at: value.lastUsedAt ?? null,
    expires_at: value.expiresAt ?? null,
    revoked_at: value.revokedAt ?? null,
  };
}

function toPrivateWakeToken(row: JsonRecord): PrivateWakeToken {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    scope: "wake:send",
    createdAt: String(row.created_at),
    lastUsedAt: optionalString(row.last_used_at),
    expiresAt: optionalString(row.expires_at),
    revokedAt: optionalString(row.revoked_at),
  };
}

function toPrivateWake(row: JsonRecord): PrivateWake {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    idempotencyKeyHash: String(row.idempotency_key_hash),
    reference: optionalString(row.reference),
    priority: row.priority === "high" ? "high" : "normal",
    receivedAt: String(row.received_at),
    referenceExpiresAt: String(row.reference_expires_at),
  };
}

function toMeteredEventWrite(row: JsonRecord): MeteredEventWrite {
  const rawEvent = row.event_row;
  return {
    ...(rawEvent && typeof rawEvent === "object"
      ? { event: toEvent(rawEvent as JsonRecord) }
      : {}),
    created: row.created === true,
    quotaExceeded: row.quota_exceeded === true,
    plan: row.plan === "pro" ? "pro" : "free",
    acceptedSignals: Number(row.accepted_signals),
    signalLimit: Number(row.signal_limit),
    courtesyLimit: Number(row.courtesy_limit),
    resetAt: String(row.reset_at),
  };
}

function toMeteredPrivateWakeWrite(row: JsonRecord): MeteredPrivateWakeWrite {
  const rawWake = row.wake_row;
  return {
    ...(rawWake && typeof rawWake === "object"
      ? { wake: toPrivateWake(rawWake as JsonRecord) }
      : {}),
    created: row.created === true,
    quotaExceeded: row.quota_exceeded === true,
    plan: row.plan === "pro" ? "pro" : "free",
    acceptedSignals: Number(row.accepted_signals),
    signalLimit: Number(row.signal_limit),
    courtesyLimit: Number(row.courtesy_limit),
    resetAt: String(row.reset_at),
  };
}

function toMeteredLiveSurfaceWrite(row: JsonRecord): MeteredLiveSurfaceWrite {
  const rawSurface = row.surface_row;
  return {
    ...(rawSurface && typeof rawSurface === "object"
      ? { surface: toLiveSurface(rawSurface as JsonRecord) }
      : {}),
    created: row.created === true,
    quotaExceeded: row.quota_exceeded === true,
    surfaceLimitExceeded: row.surface_limit_exceeded === true,
    plan: row.plan === "pro" ? "pro" : "free",
    acceptedSignals: Number(row.accepted_signals),
    signalLimit: Number(row.signal_limit),
    courtesyLimit: Number(row.courtesy_limit),
    resetAt: String(row.reset_at),
  };
}

function toEvent(row: JsonRecord): BellwireEvent {
  const data = row.data as Record<string, unknown>;
  return {
    id: String(row.id), projectId: String(row.project_id), eventType: String(row.event_type),
    idempotencyKeyHash: String(row.idempotency_key_hash), data,
    sensitiveFields: Array.isArray(row.sensitive_fields)
      ? row.sensitive_fields.filter((value): value is string => typeof value === "string")
      : Object.keys(data),
    occurredAt: String(row.occurred_at), receivedAt: String(row.received_at), status: "accepted",
    readAt: optionalString(row.read_at),
  };
}

function deliveryRow(value: Delivery): JsonRecord {
  return {
    id: value.id, event_id: value.eventId, device_id: value.deviceId, channel: value.channel,
    status: value.status, attempt_count: value.attemptCount,
    provider_message_id: value.providerMessageId ?? null, error_code: value.errorCode ?? null,
    error_message: value.errorMessage ?? null, queued_at: value.queuedAt,
    sent_at: value.sentAt ?? null, updated_at: value.updatedAt,
  };
}

function toDelivery(row: JsonRecord): Delivery {
  const rawStatus = String(row.status);
  return {
    id: String(row.id), eventId: String(row.event_id), deviceId: String(row.device_id), channel: "apns",
    status: rawStatus === "accepted_by_apns" ? "accepted_by_apns" : rawStatus === "failed" ? "failed" : "queued",
    attemptCount: Number(row.attempt_count), providerMessageId: optionalString(row.provider_message_id),
    errorCode: optionalString(row.error_code), errorMessage: optionalString(row.error_message),
    queuedAt: String(row.queued_at), sentAt: optionalString(row.sent_at), updatedAt: String(row.updated_at),
  };
}

function privateWakeDeliveryRow(value: PrivateWakeDelivery): JsonRecord {
  return {
    id: value.id,
    wake_id: value.wakeId,
    device_id: value.deviceId,
    channel: value.channel,
    status: value.status,
    attempt_count: value.attemptCount,
    provider_message_id: value.providerMessageId ?? null,
    error_code: value.errorCode ?? null,
    error_message: value.errorMessage ?? null,
    queued_at: value.queuedAt,
    sent_at: value.sentAt ?? null,
    updated_at: value.updatedAt,
  };
}

function toPrivateWakeDelivery(row: JsonRecord): PrivateWakeDelivery {
  const rawStatus = String(row.status);
  return {
    id: String(row.id),
    wakeId: String(row.wake_id),
    deviceId: String(row.device_id),
    channel: "apns",
    status: rawStatus === "accepted_by_apns"
      ? "accepted_by_apns"
      : rawStatus === "failed" ? "failed" : "queued",
    attemptCount: Number(row.attempt_count),
    providerMessageId: optionalString(row.provider_message_id),
    errorCode: optionalString(row.error_code),
    errorMessage: optionalString(row.error_message),
    queuedAt: String(row.queued_at),
    sentAt: optionalString(row.sent_at),
    updatedAt: String(row.updated_at),
  };
}

function toAccountEntitlement(row: JsonRecord): AccountEntitlement {
  const plan = row.plan === "pro" ? "pro" : "free";
  const acceptedSignals = Number(row.accepted_signals);
  const monthlySignals = Number(row.monthly_signal_limit);
  const courtesySignals = Number(row.courtesy_signal_limit);
  return {
    plan,
    status: row.status === "grace" || row.status === "expired" || row.status === "revoked"
      ? row.status
      : "active",
    productId: optionalString(row.product_id),
    expiresAt: optionalString(row.expires_at),
    downgradeDeadline: optionalString(row.downgrade_deadline),
    limits: {
      activeProjects: Number(row.active_project_limit),
      activeDevices: Number(row.active_device_limit),
      monthlySignals,
      courtesySignals,
      ingestPerMinute: Number(row.ingest_per_minute),
      hostedRetentionDays: Number(row.hosted_retention_days),
      surfacesPerProject: row.surfaces_per_project == null
        ? null
        : Number(row.surfaces_per_project),
    },
    usage: {
      periodStart: new Date(`${String(row.month_start)}T00:00:00.000Z`).toISOString(),
      periodEnd: String(row.month_end),
      acceptedSignals,
      remainingSignals: Math.max(0, monthlySignals - acceptedSignals),
      courtesyRemainingSignals: Math.max(0, courtesySignals - acceptedSignals),
    },
    activeProjects: Number(row.active_projects),
    activeDevices: Number(row.active_devices),
  };
}
