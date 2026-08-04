// SPDX-License-Identifier: AGPL-3.0-only
export const EVENT_FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "datetime",
  "url",
  "enum",
] as const;

export type EventFieldType = (typeof EVENT_FIELD_TYPES)[number];

export interface EventFieldDefinition {
  type: EventFieldType;
  required?: boolean;
  values?: string[];
  sensitive?: boolean;
}

export const AGENT_SCOPES = [
  "project:read",
  "project:write",
  "config:read",
  "config:write",
  "event:test",
  "delivery:read",
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

export interface Principal {
  kind: "user" | "agent";
  userId: string;
  tokenId?: string;
  scopes: AgentScope[];
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  slug: string;
  icon: string;
  logoUrl?: string;
  displayOrder: number;
  category: string;
  status: "active" | "paused";
  deliveryMode: ProjectDeliveryMode;
  endpoint: string;
  createdAt: string;
  updatedAt: string;
}

export const PROJECT_DELIVERY_MODES = ["private", "hosted"] as const;
export type ProjectDeliveryMode = (typeof PROJECT_DELIVERY_MODES)[number];

export interface Device {
  id: string;
  userId: string;
  installationId: string;
  name: string;
  platform: "ios";
  apnsToken: string;
  apnsEnvironment: "sandbox" | "production";
  appVersion?: string;
  buildNumber?: string;
  notificationAuthorization?: NotificationAuthorizationDiagnostic;
  lastActiveAt: string;
  pushEnabled: boolean;
  createdAt: string;
}

export const NOTIFICATION_AUTHORIZATION_DIAGNOSTICS = [
  "unknown",
  "not_determined",
  "denied",
  "authorized",
  "provisional",
  "ephemeral",
] as const;
export type NotificationAuthorizationDiagnostic =
  (typeof NOTIFICATION_AUTHORIZATION_DIAGNOSTICS)[number];

export interface DeviceBinding {
  id: string;
  userId: string;
  codeHash: string;
  deviceKeyId?: string;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

export interface DeviceKey {
  id: string;
  userId: string;
  installationId: string;
  agreementPublicKey: string;
  signingPublicKey: string;
  algorithm: "p256";
  createdAt: string;
  lastActiveAt: string;
  revokedAt?: string;
}

export interface AgentToken {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  scopes: AgentScope[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface AgentConnection {
  id: string;
  name: string;
  scopes: AgentScope[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

export interface DirectConnectionEnvelope {
  id: string;
  userId: string;
  deviceKeyId: string;
  projectId: string;
  manifestVersion: 2;
  algorithm: "p256-hkdf-sha256-aes-gcm";
  ephemeralPublicKey: string;
  sealedBox: string;
  createdAt: string;
  expiresAt: string;
}

export interface PrivateConnectionReadiness {
  projectId: string;
  deviceKeyId: string;
  userId: string;
  manifestVersion: 2;
  readyAt: string;
  lastVerifiedAt: string;
  lastSyncAt?: string;
  lastErrorCode?: string;
}

export interface DirectConnectionRecoveryRequest {
  userId: string;
  projectId: string;
  deviceKeyId: string;
  installationId: string;
  appVersion?: string;
  buildNumber?: string;
  notificationAuthorization?: NotificationAuthorizationDiagnostic;
  requestedAt: string;
}

export interface DeliveryModeChangeRequest {
  id: string;
  projectId: string;
  userId: string;
  requestedByTokenId: string;
  fromMode: ProjectDeliveryMode;
  toMode: ProjectDeliveryMode;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
}

export interface EventSchema {
  id: string;
  projectId: string;
  eventType: string;
  fields: Record<string, EventFieldDefinition>;
  version: number;
  status: "active";
  createdAt: string;
}

export interface NotificationSurface {
  id: string;
  projectId: string;
  eventType: string;
  type: "notification";
  titleTemplate: string;
  bodyTemplate: string;
  subtitleTemplate?: string;
  sound: string;
  group: string;
  priority: "normal" | "high";
  enabled: boolean;
  version: number;
  createdAt: string;
}

export const LIVE_SURFACE_TYPES = [
  "stats",
  "metrics",
  "segmented_progress",
  "progress",
  "alert",
  "timer",
] as const;

export type LiveSurfaceType = (typeof LIVE_SURFACE_TYPES)[number];

export interface LiveSurfaceAction {
  type: "open_url";
  title: string;
  url: string;
}

export interface LiveSurface {
  id: string;
  projectId: string;
  surfaceKey: string;
  type: LiveSurfaceType;
  title: string;
  subtitle?: string;
  content: Record<string, unknown>;
  action?: LiveSurfaceAction;
  displayOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface IngestToken {
  id: string;
  projectId: string;
  name: string;
  tokenHash: string;
  scope: "event:ingest";
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface PrivateWakeToken {
  id: string;
  projectId: string;
  name: string;
  tokenHash: string;
  scope: "wake:send";
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface BellwireEvent {
  id: string;
  projectId: string;
  eventType: string;
  idempotencyKeyHash: string;
  data: Record<string, unknown>;
  sensitiveFields?: string[];
  occurredAt: string;
  receivedAt: string;
  status: "accepted";
  readAt?: string;
}

export interface PrivateWake {
  id: string;
  projectId: string;
  idempotencyKeyHash: string;
  reference?: string;
  priority: "normal" | "high";
  receivedAt: string;
  referenceExpiresAt: string;
}

export interface PrivateWakeDelivery {
  id: string;
  wakeId: string;
  deviceId: string;
  channel: "apns";
  status: DeliveryStatus;
  attemptCount: number;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
  queuedAt: string;
  sentAt?: string;
  updatedAt: string;
}

export type DeliveryStatus = "queued" | "accepted_by_apns" | "failed";

export interface Delivery {
  id: string;
  eventId: string;
  deviceId: string;
  channel: "apns";
  status: DeliveryStatus;
  attemptCount: number;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
  queuedAt: string;
  sentAt?: string;
  updatedAt: string;
}

export interface EventListOptions {
  cursor?: string;
  limit: number;
  eventType?: string;
  unreadOnly?: boolean;
}

export interface EventListPage {
  events: BellwireEvent[];
  nextCursor?: string;
}

export interface DeliveryHealth {
  queued: number;
  accepted: number;
  failed: number;
  status: "healthy" | "degraded" | "idle";
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export type PlanId = "free" | "pro";
export type EntitlementStatus = "active" | "grace" | "expired" | "revoked";

export interface PlanLimits {
  activeProjects: number;
  activeDevices: number;
  monthlySignals: number;
  courtesySignals: number;
  ingestPerMinute: number;
  hostedRetentionDays: number;
  /** `null` means the plan does not impose a per-project Surface limit. */
  surfacesPerProject: number | null;
}

export interface SignalUsage {
  periodStart: string;
  periodEnd: string;
  acceptedSignals: number;
  remainingSignals: number;
  courtesyRemainingSignals: number;
}

export interface AccountEntitlement {
  plan: PlanId;
  status: EntitlementStatus;
  productId?: string;
  expiresAt?: string;
  downgradeDeadline?: string;
  limits: PlanLimits;
  usage: SignalUsage;
  activeProjects: number;
  activeDevices: number;
}

export interface MeteredWrite {
  created: boolean;
  quotaExceeded: boolean;
  plan: PlanId;
  acceptedSignals: number;
  signalLimit: number;
  courtesyLimit: number;
  resetAt: string;
}

export interface MeteredEventWrite extends MeteredWrite {
  event?: BellwireEvent;
}

export interface MeteredPrivateWakeWrite extends MeteredWrite {
  wake?: PrivateWake;
}

export interface MeteredLiveSurfaceWrite extends MeteredWrite {
  surface?: LiveSurface;
  surfaceLimitExceeded: boolean;
}

export interface AppleTransactionRecord {
  transactionId: string;
  originalTransactionId: string;
  userId: string;
  productId: string;
  environment: "Sandbox" | "Production";
  purchaseDate: string;
  expiresAt?: string;
  revocationDate?: string;
  status: EntitlementStatus;
  signedDate: string;
  updatedAt: string;
}
