// SPDX-License-Identifier: AGPL-3.0-only
import type {
  BellwireEvent,
  AccountEntitlement,
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

export interface CreateEventResult {
  event: BellwireEvent;
  created: boolean;
}

export interface CreateDeliveryResult {
  delivery: Delivery;
  created: boolean;
}

export interface BellwireRepository {
  deleteAccount(userId: string): Promise<void>;
  saveAppleRefreshToken(userId: string, encryptedRefreshToken: string): Promise<void>;
  getAppleRefreshToken(userId: string): Promise<string | undefined>;
  deleteAppleRefreshToken(userId: string): Promise<void>;

  createProject(project: Project): Promise<Project>;
  getProject(projectId: string): Promise<Project | undefined>;
  listProjects(userId: string): Promise<Project[]>;
  updateProject(project: Project): Promise<Project>;
  updateProjectDisplayOrder(projectId: string, displayOrder: number): Promise<Project>;
  deleteProject(projectId: string): Promise<void>;

  saveDevice(device: Device): Promise<Device>;
  getDevice(deviceId: string): Promise<Device | undefined>;
  listDevices(userId: string): Promise<Device[]>;
  deleteDevice(deviceId: string): Promise<void>;

  saveDeviceBinding(binding: DeviceBinding): Promise<DeviceBinding>;
  findDeviceBindingByCodeHash(codeHash: string): Promise<DeviceBinding | undefined>;
  claimDeviceBinding(
    codeHash: string,
    token: Omit<AgentToken, "userId">,
    consumedAt: string,
  ): Promise<AgentToken | undefined>;

  saveAgentToken(token: AgentToken): Promise<AgentToken>;
  listAgentTokens(userId: string): Promise<AgentToken[]>;
  findAgentTokenByHash(tokenHash: string): Promise<AgentToken | undefined>;
  markAgentTokenUsed(tokenId: string, usedAt: string): Promise<void>;
  revokeAgentToken(tokenId: string, userId: string, revokedAt: string): Promise<void>;

  saveDeviceKey(key: DeviceKey): Promise<DeviceKey>;
  getDeviceKey(keyId: string, userId: string): Promise<DeviceKey | undefined>;
  saveDirectConnectionEnvelope(
    envelope: DirectConnectionEnvelope,
  ): Promise<DirectConnectionEnvelope>;
  listDirectConnectionEnvelopes(
    userId: string,
    deviceKeyId: string,
    now: string,
  ): Promise<DirectConnectionEnvelope[]>;
  acknowledgeDirectConnectionEnvelope(
    envelopeId: string,
    userId: string,
    deviceKeyId: string,
    verifiedAt: string,
  ): Promise<string | undefined>;
  getPrivateConnectionReadiness(
    projectId: string,
    deviceKeyId: string,
  ): Promise<PrivateConnectionReadiness | undefined>;
  listPrivateConnectionReadiness(projectId: string): Promise<PrivateConnectionReadiness[]>;
  getDirectConnectionRecoveryRequest(
    projectId: string,
    deviceKeyId: string,
  ): Promise<DirectConnectionRecoveryRequest | undefined>;
  saveDirectConnectionRecoveryRequestIfAbsent(
    request: DirectConnectionRecoveryRequest,
  ): Promise<{ request: DirectConnectionRecoveryRequest; created: boolean }>;
  listDirectConnectionRecoveryRequests(
    userId: string,
  ): Promise<DirectConnectionRecoveryRequest[]>;
  deleteDirectConnectionRecoveryRequest(
    projectId: string,
    deviceKeyId: string,
  ): Promise<void>;

  saveDeliveryModeChangeRequest(
    request: DeliveryModeChangeRequest,
  ): Promise<DeliveryModeChangeRequest>;
  listDeliveryModeChangeRequests(
    userId: string,
    status?: DeliveryModeChangeRequest["status"],
  ): Promise<DeliveryModeChangeRequest[]>;
  resolveDeliveryModeChangeRequest(
    requestId: string,
    userId: string,
    approved: boolean,
    resolvedAt: string,
  ): Promise<DeliveryModeChangeRequest | undefined>;

  saveEventSchema(schema: EventSchema): Promise<EventSchema>;
  getEventSchema(
    projectId: string,
    eventType: string,
  ): Promise<EventSchema | undefined>;
  listEventSchemas(projectId: string): Promise<EventSchema[]>;

  saveNotificationSurface(surface: NotificationSurface): Promise<NotificationSurface>;
  getNotificationSurface(
    projectId: string,
    eventType: string,
  ): Promise<NotificationSurface | undefined>;
  listNotificationSurfaces(projectId: string): Promise<NotificationSurface[]>;

  saveLiveSurface(surface: LiveSurface): Promise<LiveSurface>;
  acceptHostedSurface(
    surface: LiveSurface,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredLiveSurfaceWrite>;
  getLiveSurface(projectId: string, surfaceKey: string): Promise<LiveSurface | undefined>;
  listLiveSurfaces(projectId: string): Promise<LiveSurface[]>;
  updateLiveSurfaceDisplayOrder(surfaceId: string, displayOrder: number): Promise<LiveSurface>;
  deleteLiveSurface(surfaceId: string): Promise<void>;

  saveIngestToken(token: IngestToken): Promise<IngestToken>;
  listIngestTokens(projectId: string): Promise<IngestToken[]>;
  findIngestTokenByHash(
    projectId: string,
    tokenHash: string,
  ): Promise<IngestToken | undefined>;
  markIngestTokenUsed(tokenId: string, usedAt: string): Promise<void>;
  revokeIngestToken(tokenId: string, revokedAt: string): Promise<void>;

  savePrivateWakeToken(token: PrivateWakeToken): Promise<PrivateWakeToken>;
  listPrivateWakeTokens(projectId: string): Promise<PrivateWakeToken[]>;
  findPrivateWakeTokenByHash(
    projectId: string,
    tokenHash: string,
  ): Promise<PrivateWakeToken | undefined>;
  markPrivateWakeTokenUsed(tokenId: string, usedAt: string): Promise<void>;
  revokePrivateWakeToken(tokenId: string, revokedAt: string): Promise<void>;

  consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  acceptHostedEvent(
    event: BellwireEvent,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredEventWrite>;
  acceptPrivateWake(
    wake: PrivateWake,
    enforcementMode: "disabled" | "shadow" | "enforce",
  ): Promise<MeteredPrivateWakeWrite>;
  getPrivateWake(wakeId: string): Promise<PrivateWake | undefined>;
  clearPrivateWakeReference(wakeId: string): Promise<void>;
  listEvents(projectId: string, options: EventListOptions): Promise<EventListPage>;
  getEvent(eventId: string): Promise<BellwireEvent | undefined>;
  markEventRead(eventId: string, readAt: string): Promise<void>;
  markAllEventsRead(projectIds: string[], readAt: string): Promise<number>;

  createDeliveryIfAbsent(delivery: Delivery): Promise<CreateDeliveryResult>;
  claimDelivery(
    deliveryId: string,
    claimedAt: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<Delivery | undefined>;
  completeClaimedDelivery(delivery: Delivery): Promise<Delivery | undefined>;
  recordQueueUnavailable(
    expected: Delivery,
    failedAt: string,
    message: string,
  ): Promise<Delivery | undefined>;
  updateDelivery(delivery: Delivery): Promise<Delivery>;
  listDeliveries(eventId: string): Promise<Delivery[]>;
  getDeliveryHealth(projectId: string, since: string): Promise<DeliveryHealth>;

  createPrivateWakeDeliveryIfAbsent(
    delivery: PrivateWakeDelivery,
  ): Promise<{ delivery: PrivateWakeDelivery; created: boolean }>;
  claimPrivateWakeDelivery(
    deliveryId: string,
    claimedAt: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<PrivateWakeDelivery | undefined>;
  completeClaimedPrivateWakeDelivery(
    delivery: PrivateWakeDelivery,
  ): Promise<PrivateWakeDelivery | undefined>;
  updatePrivateWakeDelivery(delivery: PrivateWakeDelivery): Promise<PrivateWakeDelivery>;
  listPrivateWakeDeliveries(wakeId: string): Promise<PrivateWakeDelivery[]>;

  getAccountEntitlement(userId: string, now: string): Promise<AccountEntitlement>;
  saveAppleTransaction(transaction: AppleTransactionRecord): Promise<void>;
  saveAppleNotificationReceipt(
    notificationUUID: string,
    notificationType: string,
    subtype: string | undefined,
    signedDate: string,
  ): Promise<boolean>;
  runMaintenance(now: string): Promise<unknown>;
}
