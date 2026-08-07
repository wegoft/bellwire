// SPDX-License-Identifier: AGPL-3.0-only
import {
  AGENT_SCOPES,
  EVENT_FIELD_TYPES,
  LIVE_SURFACE_TYPES,
  NOTIFICATION_AUTHORIZATION_DIAGNOSTICS,
  type BellwireEvent,
  type AccountEntitlement,
  type AgentConnection,
  type AgentScope,
  type Delivery,
  type Device,
  type DeviceLiveActivityCapability,
  type DeviceKey,
  type DeliveryModeChangeRequest,
  type DirectConnectionEnvelope,
  type DirectConnectionRecoveryRequest,
  type EventFieldDefinition,
  type EventFieldType,
  type EventSchema,
  type IngestToken,
  type LiveSurface,
  type LiveActivityDirective,
  type LiveSurfaceAction,
  type LiveSurfaceType,
  type NotificationSurface,
  type PrivateWake,
  type PrivateWakeToken,
  type Principal,
  type Project,
  type ProjectDeliveryMode,
  type ValidationIssue,
} from "../domain/models";
import type { BellwireRepository } from "../repositories/bellwire-repository";
import { decodeEventCursor } from "../repositories/event-cursor";
import { createOpaqueToken, createPairingCode, hashSecret, readBearerToken } from "../security/tokens";
import type { DeliveryDispatcher } from "./delivery-dispatcher";
import type { AccountIdentityService } from "./auth-admin-client";
import {
  readProductEvent,
  validateAnalyticsProperties,
  type ProductAnalytics,
} from "./product-analytics";

type ErrorCode =
  | "INVALID_REQUEST"
  | "PROJECT_NOT_FOUND"
  | "DEVICE_NOT_FOUND"
  | "AGENT_CONNECTION_NOT_FOUND"
  | "EVENT_NOT_FOUND"
  | "EVENT_SCHEMA_NOT_FOUND"
  | "NOTIFICATION_SURFACE_NOT_FOUND"
  | "SURFACE_NOT_FOUND"
  | "INVALID_TOKEN"
  | "INVALID_BINDING_CODE"
  | "INVALID_CURSOR"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "SCHEMA_VALIDATION_FAILED"
  | "PROJECT_PAUSED"
  | "PROJECT_PRIVATE_MODE"
  | "PROJECT_HOSTED_MODE"
  | "PRIVATE_READINESS_REQUIRED"
  | "PENDING_MODE_REQUEST_EXISTS"
  | "MONTHLY_SIGNAL_LIMIT_REACHED"
  | "PLAN_LIMIT_REACHED"
  | "PAYLOAD_TOO_LARGE"
  | "BILLING_UNAVAILABLE"
  | "PURCHASE_INVALID"
  | "RATE_LIMITED"
  | "FORBIDDEN";

export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ValidationIssue[],
    readonly metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface CreateEventSchemaInput {
  eventType?: unknown;
  fields?: unknown;
  notification?: unknown;
}

export interface IngestEventInput {
  type?: unknown;
  data?: unknown;
  occurredAt?: unknown;
}

export interface IngestEventResult {
  eventId: string;
  deduplicated: boolean;
  deliveryQueued?: boolean;
  usage?: SignalUsageResult;
}

export interface SignalUsageResult {
  plan: "free" | "pro";
  used: number;
  limit: number;
  courtesyLimit: number;
  resetAt: string;
}

export interface PrivateWakeResult {
  wakeId: string;
  deduplicated: boolean;
  deliveryQueued?: boolean;
  usage: SignalUsageResult;
}

export interface SurfaceInput {
  eventType?: unknown;
  title?: unknown;
  body?: unknown;
  subtitle?: unknown;
  sound?: unknown;
  group?: unknown;
  priority?: unknown;
  enabled?: unknown;
}

const DEMO_PROJECT_NAME = "Bellwire Demo";
const DEMO_PROJECT_SLUG = "bellwire-system-demo-v1";
const DEMO_EVENT_TYPE = "deployment.completed";
const DEMO_SURFACE_KEY = "demo-status";
const DEMO_EVENT_IDEMPOTENCY_KEY = "bellwire-demo-deployment-v1";
const DEMO_REVENUE_EVENT_TYPE = "payment.received";
const DEMO_REVENUE_EVENT_IDEMPOTENCY_KEY = "bellwire-demo-payment-v1";
const DEMO_SERVICE_EVENT_TYPE = "service.recovered";
const DEMO_SERVICE_EVENT_IDEMPOTENCY_KEY = "bellwire-demo-service-v1";

const demoFields: Record<string, EventFieldDefinition> = {
  deployment: { type: "string", required: true },
  environment: { type: "enum", required: true, values: ["Production"] },
  duration: { type: "number", required: true },
};

const demoNotification = {
  title: "Deployment completed",
  body: "{{ deployment }} reached {{ environment }} in {{ duration }}s",
};

const demoEventData = {
  deployment: "Bellwire 1.0",
  environment: "Production",
  duration: 24,
};

const demoRevenueFields: Record<string, EventFieldDefinition> = {
  amount: { type: "number", required: true },
  currency: { type: "enum", required: true, values: ["USD"] },
  product: { type: "string", required: true },
  customer: { type: "string", required: true },
};

const demoRevenueNotification = {
  title: "Payment received",
  body: "{{ currency }} {{ amount }} · {{ product }}",
};

const demoRevenueEventData = {
  amount: 249,
  currency: "USD",
  product: "Pro annual",
  customer: "Acme Studio",
};

const demoServiceFields: Record<string, EventFieldDefinition> = {
  service: { type: "string", required: true },
  status: { type: "enum", required: true, values: ["Healthy"] },
  latency: { type: "number", required: true },
  region: { type: "string", required: true },
};

const demoServiceNotification = {
  title: "Service recovered",
  body: "{{ service }} is {{ status }} · {{ latency }}ms",
};

const demoServiceEventData = {
  service: "Production API",
  status: "Healthy",
  latency: 82,
  region: "Global",
};

const demoSurfaceContent = {
  metrics: [
    { label: "Overall", value: "Healthy", color: "green" },
    { label: "Availability", value: "99.99%", color: "green" },
    { label: "P95 latency", value: "82 ms", color: "blue" },
    { label: "Queue", value: 0, color: "cyan" },
  ],
};

const legacyDemoSurfaceContent = {
  metrics: [
    { label: "Status", value: "Healthy", color: "green" },
    { label: "Events", value: 1, color: "orange" },
    { label: "Agents", value: 1, color: "blue" },
  ],
};

interface DemoEventDefinition {
  eventType: string;
  idempotencyKey: string;
  fields: Record<string, EventFieldDefinition>;
  notification: { title: string; body: string; group: string };
  data: Record<string, unknown>;
}

const demoEventDefinitions: DemoEventDefinition[] = [
  {
    eventType: DEMO_EVENT_TYPE,
    idempotencyKey: DEMO_EVENT_IDEMPOTENCY_KEY,
    fields: demoFields,
    notification: { ...demoNotification, group: "deployment" },
    data: demoEventData,
  },
  {
    eventType: DEMO_SERVICE_EVENT_TYPE,
    idempotencyKey: DEMO_SERVICE_EVENT_IDEMPOTENCY_KEY,
    fields: demoServiceFields,
    notification: { ...demoServiceNotification, group: "service" },
    data: demoServiceEventData,
  },
  {
    eventType: DEMO_REVENUE_EVENT_TYPE,
    idempotencyKey: DEMO_REVENUE_EVENT_IDEMPOTENCY_KEY,
    fields: demoRevenueFields,
    notification: { ...demoRevenueNotification, group: "revenue" },
    data: demoRevenueEventData,
  },
];

const demoSurfaceDefinitions = [
  {
    key: "demo-revenue",
    input: {
      type: "stats",
      title: "Revenue today",
      subtitle: "Live commerce snapshot",
      metrics: [
        { label: "Revenue", value: "$12,840", color: "green" },
        { label: "Orders", value: 184, color: "blue" },
        { label: "Avg order", value: "$69.78", color: "purple" },
        { label: "Refunds", value: "0.6%", color: "orange" },
      ],
    },
  },
  {
    key: DEMO_SURFACE_KEY,
    input: {
      type: "stats",
      title: "Production services",
      subtitle: "All systems operational",
      metrics: demoSurfaceContent.metrics,
    },
  },
  {
    key: "demo-revenue-goal",
    input: {
      type: "progress",
      title: "Monthly revenue goal",
      subtitle: "$36,000 of $50,000",
      percentage: 72,
    },
  },
] as const;

export class BellwireService {
  constructor(
    readonly repository: BellwireRepository,
    private readonly deliveryDispatcher?: DeliveryDispatcher,
    private readonly accountIdentityService?: AccountIdentityService,
    private readonly enforcementMode: "disabled" | "shadow" | "enforce" = "disabled",
    private readonly analytics?: ProductAnalytics,
    private readonly liveActivityAutomationEnabled = true,
  ) {}

  async captureProductEvent(principal: Principal, input: unknown): Promise<void> {
    this.requireSignedInUser(principal);
    const body = asStrictRecord(input, ["event", "properties"]);
    const event = readProductEvent(body.event);
    if (!event) throw invalidRequest("Unsupported product analytics event");
    if (!["paywall_viewed", "upgrade_clicked", "subscription_managed"].includes(event)) {
      throw invalidRequest("This analytics event is server-managed");
    }
    let properties;
    try {
      properties = validateAnalyticsProperties(body.properties);
    } catch (error) {
      throw invalidRequest(error instanceof Error ? error.message : "Invalid analytics properties");
    }
    await this.analytics?.capture(principal.userId, event, properties);
  }

  async deleteAccount(principal: Principal): Promise<void> {
    if (principal.kind !== "user") {
      throw new ServiceError(403, "FORBIDDEN", "Only a signed-in user can delete an account");
    }
    await this.repository.deleteAccount(principal.userId);
    await this.accountIdentityService?.deleteUser(principal.userId);
  }

  async createDemoExperience(principal: Principal): Promise<{ projectId: string; created: boolean }> {
    if (principal.kind !== "user") {
      throw new ServiceError(403, "FORBIDDEN", "Only a signed-in user can create the demo project");
    }
    const projects = await this.repository.listProjects(principal.userId);
    const demoIdempotencyHash = await hashSecret(DEMO_EVENT_IDEMPOTENCY_KEY);
    const reservedSlugProject = projects.find((candidate) => candidate.slug === DEMO_PROJECT_SLUG);
    let project = reservedSlugProject && await this.isVerifiedReservedDemo(reservedSlugProject)
      ? reservedSlugProject
      : undefined;
    let created = false;

    if (reservedSlugProject && !project) {
      await this.repository.updateProject({
        ...reservedSlugProject,
        slug: relocatedUserProjectSlug(reservedSlugProject),
        updatedAt: new Date().toISOString(),
      });
    }

    if (!project) {
      const legacy = await this.findVerifiedLegacyDemo(projects, demoIdempotencyHash);
      if (legacy) {
        let eventVerified = legacy.event === undefined;
        if (legacy.event) {
          let adoptedEvent: BellwireEvent | undefined = legacy.event;
          if (adoptedEvent.idempotencyKeyHash !== demoIdempotencyHash) {
            adoptedEvent = await this.repository.replaceEventIdempotencyHash(
              adoptedEvent.id,
              adoptedEvent.idempotencyKeyHash,
              demoIdempotencyHash,
            ) ?? await this.repository.getEventByIdempotencyHash(
              legacy.project.id,
              demoIdempotencyHash,
            );
          }
          eventVerified = adoptedEvent?.id === legacy.event.id;
        }
        if (eventVerified) {
          try {
            project = await this.repository.updateProject({
              ...legacy.project,
              slug: DEMO_PROJECT_SLUG,
              updatedAt: new Date().toISOString(),
            });
          } catch (error) {
            const concurrentProject = (await this.repository.listProjects(principal.userId))
              .find((candidate) => candidate.slug === DEMO_PROJECT_SLUG);
            if (!concurrentProject || !await this.isVerifiedReservedDemo(concurrentProject)) {
              throw error;
            }
            project = concurrentProject;
          }
        }
      }
    }
    if (!project) {
      const entitlement = await this.repository.getAccountEntitlement(
        principal.userId,
        new Date().toISOString(),
      );
      if (
        this.enforcementMode === "enforce"
        && projects.filter((candidate) => candidate.status === "active").length >=
          entitlement.limits.activeProjects
      ) {
        throw planLimitReached("active projects", entitlement);
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const candidate: Project = {
        id,
        userId: principal.userId,
        name: DEMO_PROJECT_NAME,
        slug: DEMO_PROJECT_SLUG,
        icon: "bell.and.waves.left.and.right",
        displayOrder: nextDisplayOrder(projects),
        category: "demo",
        status: "active",
        deliveryMode: "hosted",
        endpoint: `/v1/events/${id}`,
        createdAt: now,
        updatedAt: now,
      };
      let result = await this.repository.createProjectIfAbsent(candidate);
      if (!result.created && !await this.isVerifiedReservedDemo(result.project)) {
        await this.repository.updateProject({
          ...result.project,
          slug: relocatedUserProjectSlug(result.project),
          updatedAt: new Date().toISOString(),
        });
        result = await this.repository.createProjectIfAbsent(candidate);
      }
      if (!result.created && !await this.isVerifiedReservedDemo(result.project)) {
        throw new Error("Reserved demo identity is occupied by an unverified project");
      }
      project = result.project;
      created = result.created;
    }
    if (project.deliveryMode !== "hosted") {
      project = await this.repository.updateProject({
        ...project,
        deliveryMode: "hosted",
        updatedAt: new Date().toISOString(),
      });
    }

    const configurationCreatedAt = new Date().toISOString();
    for (const definition of demoEventDefinitions) {
      await this.repository.ensureEventSchemaAndNotificationSurface({
        id: crypto.randomUUID(),
        projectId: project.id,
        eventType: definition.eventType,
        fields: definition.fields,
        version: 1,
        status: "active",
        createdAt: configurationCreatedAt,
      }, {
        id: crypto.randomUUID(),
        projectId: project.id,
        eventType: definition.eventType,
        type: "notification",
        titleTemplate: definition.notification.title,
        bodyTemplate: definition.notification.body,
        sound: "default",
        group: definition.notification.group,
        priority: "normal",
        enabled: true,
        version: 1,
        createdAt: configurationCreatedAt,
      });
    }

    for (const [index, definition] of demoSurfaceDefinitions.entries()) {
      const surface = await this.upsertLiveSurface(
        principal,
        project.id,
        definition.key,
        definition.input,
      );
      if (surface.displayOrder !== index) {
        await this.repository.updateLiveSurfaceDisplayOrder(surface.id, index);
      }
    }

    let notificationEvent: BellwireEvent | undefined;
    for (const definition of demoEventDefinitions) {
      const accepted = await this.acceptEvent(project, definition.idempotencyKey, {
        type: definition.eventType,
        data: definition.data,
        occurredAt: new Date().toISOString(),
      }, false);
      const event = await this.repository.getEvent(accepted.eventId);
      if (!event) throw new Error(`Demo Event ${definition.eventType} was not persisted`);
      if (definition.eventType === DEMO_EVENT_TYPE) notificationEvent = event;
    }
    if (!notificationEvent) throw new Error("Demo notification Event was not persisted");

    const devices = (await this.repository.listDevices(project.userId))
      .filter((device) => device.pushEnabled);
    await this.ensureDemoEventDelivery(project, notificationEvent, devices);
    return { projectId: project.id, created };
  }

  async createProject(principal: Principal, input: unknown): Promise<Project> {
    const body = asRecord(input);
    const name = readNonEmptyString(body.name);
    if (!name) throw invalidRequest("Project name is required");
    const existingProjects = await this.repository.listProjects(principal.userId);
    const entitlement = await this.repository.getAccountEntitlement(
      principal.userId,
      new Date().toISOString(),
    );
    if (
      this.enforcementMode === "enforce" &&
      existingProjects.filter((project) => project.status === "active").length >=
        entitlement.limits.activeProjects
    ) {
      throw planLimitReached("active projects", entitlement);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    return this.repository.createProject({
      id,
      userId: principal.userId,
      name,
      slug: userProjectSlug(name, id),
      icon: readNonEmptyString(body.icon) ?? "bolt.horizontal",
      logoUrl: readProjectLogoUrl(body.logoUrl),
      displayOrder: nextDisplayOrder(existingProjects),
      category: readNonEmptyString(body.category) ?? "general",
      status: "active",
      deliveryMode: "private",
      endpoint: `/v1/events/${id}`,
      createdAt: now,
      updatedAt: now,
    });
  }

  async listProjects(principal: Principal): Promise<{ projects: Project[] }> {
    return { projects: await this.repository.listProjects(principal.userId) };
  }

  async getAccountEntitlement(principal: Principal): Promise<AccountEntitlement> {
    this.requireSignedInUser(principal);
    return this.repository.getAccountEntitlement(principal.userId, new Date().toISOString());
  }

  async getProjectOverview(principal: Principal, projectId: string) {
    const project = await this.requireOwnedProject(principal, projectId);
    const [
      eventSchemas,
      notificationSurfaces,
      liveSurfaces,
      deliveryHealth,
      readiness,
      devices,
    ] = await Promise.all([
      this.repository.listEventSchemas(projectId),
      this.repository.listNotificationSurfaces(projectId),
      this.repository.listLiveSurfaces(projectId),
      this.repository.getDeliveryHealth(projectId, deliveryHealthWindowStart()),
      this.repository.listPrivateConnectionReadiness(projectId),
      this.repository.listDevices(project.userId),
    ]);
    const activeInstallationIds = new Set(
      devices.filter((device) => device.pushEnabled).map((device) => device.installationId),
    );
    const readinessKeys = await Promise.all(
      readiness.map((item) => this.repository.getDeviceKey(item.deviceKeyId, project.userId)),
    );
    const readyDevices = readinessKeys.filter(
      (key) => key && activeInstallationIds.has(key.installationId),
    ).length;
    return {
      ...project,
      eventSchemas,
      notificationSurfaces,
      liveSurfaces,
      deliveryHealth,
      privateReadiness: {
        readyDevices,
        activeDevices: activeInstallationIds.size,
        connections: readiness,
      },
    };
  }

  async updateProject(principal: Principal, projectId: string, input: unknown): Promise<Project> {
    const project = await this.requireOwnedProject(principal, projectId);
    const body = asRecord(input);
    const name = body.name === undefined ? project.name : readNonEmptyString(body.name);
    if (!name) throw invalidRequest("Project name must not be empty");
    const status = body.status === undefined ? project.status : body.status;
    if (status !== "active" && status !== "paused") {
      throw invalidRequest("Project status must be active or paused");
    }
    if (status === "active" && project.status === "paused" && this.enforcementMode === "enforce") {
      const entitlement = await this.repository.getAccountEntitlement(
        principal.userId,
        new Date().toISOString(),
      );
      if (entitlement.activeProjects >= entitlement.limits.activeProjects) {
        throw planLimitReached("active projects", entitlement);
      }
    }
    return this.repository.updateProject({
      ...project,
      name,
      status,
      icon: readNonEmptyString(body.icon) ?? project.icon,
      logoUrl: body.logoUrl === undefined ? project.logoUrl : readProjectLogoUrl(body.logoUrl),
      category: readNonEmptyString(body.category) ?? project.category,
      updatedAt: new Date().toISOString(),
    });
  }

  async updateProjectDisplayOrder(
    principal: Principal,
    projectId: string,
    input: unknown,
  ): Promise<Project> {
    await this.requireOwnedProject(principal, projectId);
    return this.repository.updateProjectDisplayOrder(
      projectId,
      parseDisplayOrder(asRecord(input).displayOrder),
    );
  }

  async deleteProject(principal: Principal, projectId: string): Promise<void> {
    await this.requireOwnedProject(principal, projectId);
    await this.repository.deleteProject(projectId);
  }

  async registerDevice(principal: Principal, input: unknown) {
    const body = asRecord(input);
    const apnsToken = readNonEmptyString(body.apnsToken);
    const installationId = readNonEmptyString(body.installationId);
    const name = readNonEmptyString(body.name);
    const apnsEnvironment = body.apnsEnvironment ?? "production";
    if (!name) throw invalidRequest("Device name is required");
    if (!apnsToken || !/^[A-Fa-f0-9]{32,256}$/u.test(apnsToken)) {
      throw invalidRequest("A valid APNs device token is required");
    }
    if (!installationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(installationId)) {
      throw invalidRequest("Installation ID must be a UUID");
    }
    if (apnsEnvironment !== "sandbox" && apnsEnvironment !== "production") {
      throw invalidRequest("APNs environment must be sandbox or production");
    }
    const currentDevices = await this.repository.listDevices(principal.userId);
    const existingDevice = currentDevices.find(
      (device) => device.installationId === installationId.toLowerCase(),
    );
    if (
      this.enforcementMode === "enforce" &&
      body.pushEnabled !== false &&
      !existingDevice?.pushEnabled
    ) {
      const entitlement = await this.repository.getAccountEntitlement(
        principal.userId,
        new Date().toISOString(),
      );
      if (entitlement.activeDevices >= entitlement.limits.activeDevices) {
        throw planLimitReached("active devices", entitlement);
      }
    }
    const now = new Date().toISOString();
    const saved = await this.repository.saveDevice({
      id: crypto.randomUUID(),
      userId: principal.userId,
      installationId: installationId.toLowerCase(),
      name,
      platform: "ios",
      apnsToken: apnsToken.toLowerCase(),
      apnsEnvironment,
      appVersion: readNonEmptyString(body.appVersion),
      buildNumber: readOptionalBoundedString(body.buildNumber, "Build number", 40),
      notificationAuthorization: readNotificationAuthorizationDiagnostic(
        body.notificationAuthorization,
      ),
      lastActiveAt: now,
      pushEnabled: body.pushEnabled !== false,
      createdAt: now,
    });
    if (saved.pushEnabled) await this.ensureDemoDeliveryForDevice(saved);
    return saved;
  }

  async listDevices(principal: Principal) {
    return { devices: await this.repository.listDevices(principal.userId) };
  }

  async deleteDevice(principal: Principal, deviceId: string): Promise<void> {
    const device = await this.repository.getDevice(deviceId);
    if (!device || device.userId !== principal.userId) {
      throw new ServiceError(404, "DEVICE_NOT_FOUND", "Device not found");
    }
    await this.repository.deleteDevice(deviceId);
  }

  async registerDeviceLiveActivityCapability(principal: Principal, input: unknown) {
    this.requireSignedInUser(principal);
    const body = asRecord(input);
    const installationId = readNonEmptyString(body.installationId)?.toLowerCase();
    if (!installationId || !isUUID(installationId)) {
      throw invalidRequest("Installation ID must be a UUID");
    }
    if (typeof body.activitiesEnabled !== "boolean" || typeof body.autoStartEnabled !== "boolean") {
      throw invalidRequest("activitiesEnabled and autoStartEnabled must be boolean");
    }
    const osVersion = readBoundedString(body.osVersion, "OS version", 32);
    const pushToStartToken = readOptionalHexToken(body.pushToStartToken, "pushToStartToken");
    const device = (await this.repository.listDevices(principal.userId)).find(
      (candidate) => candidate.installationId === installationId,
    );
    if (!device) throw new ServiceError(404, "DEVICE_NOT_FOUND", "Device not found");
    const capability: DeviceLiveActivityCapability = {
      deviceId: device.id,
      userId: principal.userId,
      activitiesEnabled: body.activitiesEnabled,
      autoStartEnabled: body.autoStartEnabled,
      ...(pushToStartToken ? { pushToStartToken } : {}),
      osVersion,
      updatedAt: new Date().toISOString(),
    };
    return this.repository.saveDeviceLiveActivityCapability(capability);
  }

  async registerLiveActivity(
    principal: Principal,
    activityIdValue: string,
    input: unknown,
  ) {
    this.requireSignedInUser(principal);
    const activityId = readBoundedString(activityIdValue, "Activity ID", 128);
    const body = asRecord(input);
    const installationId = readNonEmptyString(body.installationId)?.toLowerCase();
    if (!installationId || !isUUID(installationId)) {
      throw invalidRequest("Installation ID must be a UUID");
    }
    const projectId = readNonEmptyString(body.projectId);
    const surfaceId = readNonEmptyString(body.surfaceId);
    const sessionId = parseLiveActivitySessionId(body.sessionId);
    const updateToken = readRequiredHexToken(body.updateToken, "updateToken");
    const environment = body.apnsEnvironment;
    if (environment !== "sandbox" && environment !== "production") {
      throw invalidRequest("APNs environment must be sandbox or production");
    }
    const device = (await this.repository.listDevices(principal.userId)).find(
      (candidate) => candidate.installationId === installationId,
    );
    if (!device) throw new ServiceError(404, "DEVICE_NOT_FOUND", "Device not found");
    const project = projectId ? await this.repository.getProject(projectId) : undefined;
    if (!project || project.userId !== principal.userId) {
      throw new ServiceError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    const surface = (await this.repository.listLiveSurfaces(project.id)).find(
      (candidate) => candidate.id === surfaceId,
    );
    if (!surface || surface.liveActivity?.sessionId !== sessionId) {
      throw new ServiceError(404, "SURFACE_NOT_FOUND", "Live Activity Surface not found");
    }
    const now = new Date();
    const registration = await this.repository.saveLiveActivityRegistration({
      id: crypto.randomUUID(),
      userId: principal.userId,
      deviceId: device.id,
      projectId: project.id,
      surfaceId: surface.id,
      sessionId,
      activityId,
      updateToken,
      apnsEnvironment: environment,
      origin: "agent",
      lastVersion: surface.version,
      expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1_000).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await this.repository.deleteLiveActivityStartRequest(device.id, project.id, sessionId);
    if (this.liveActivityAutomationEnabled && surface.liveActivity.state === "ended") {
      await this.deliveryDispatcher?.enqueueLiveSurface?.(surface, project);
    }
    return registration;
  }

  async deleteLiveActivityRegistration(
    principal: Principal,
    activityIdValue: string,
  ): Promise<void> {
    this.requireSignedInUser(principal);
    const activityId = readBoundedString(activityIdValue, "Activity ID", 128);
    const registration = (await this.repository.listLiveActivityRegistrations(principal.userId))
      .find((candidate) => candidate.activityId === activityId);
    if (registration) await this.repository.deleteLiveActivityRegistration(activityId);
  }

  async createDeviceBinding(principal: Principal, input: unknown = {}) {
    this.requireSignedInUser(principal);
    const body = asRecord(input);
    const deviceKey = parseDeviceKey(asRecord(body.deviceKey), principal.userId);
    const code = createPairingCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1_000).toISOString();
    if (deviceKey) await this.repository.saveDeviceKey(deviceKey);
    await this.repository.saveDeviceBinding({
      id: crypto.randomUUID(),
      userId: principal.userId,
      codeHash: await hashSecret(code),
      deviceKeyId: deviceKey?.id,
      expiresAt,
      createdAt: now.toISOString(),
    });
    return { code, expiresAt };
  }

  async registerDeviceKey(principal: Principal, input: unknown) {
    this.requireSignedInUser(principal);
    const deviceKey = parseDeviceKey(
      asStrictRecord(input, [
        "id",
        "installationId",
        "agreementPublicKey",
        "signingPublicKey",
        "algorithm",
      ]),
      principal.userId,
    );
    if (!deviceKey) throw invalidRequest("Device key is required");
    const existing = await this.repository.getDeviceKey(deviceKey.id, principal.userId);
    if (existing && !sameDeviceKeyDescriptor(existing, deviceKey)) {
      throw invalidRequest("Device key ID is already registered with a different descriptor");
    }
    const saved = await this.repository.saveDeviceKey({
      ...deviceKey,
      createdAt: existing?.createdAt ?? deviceKey.createdAt,
    });
    return publicDeviceKey(saved);
  }

  async confirmDeviceBinding(input: unknown, clientIp = "unknown") {
    const body = asRecord(input);
    const code = readNonEmptyString(body.code);
    if (!code || !/^\d{6}$/u.test(code)) throw invalidBindingCode();
    const name = body.name === undefined ? "Codex" : readBoundedString(body.name, "Agent name", 80);
    const codeHash = await hashSecret(code);
    const ipHash = await hashSecret(clientIp);
    const [ipAllowed, codeAllowed] = await Promise.all([
      this.repository.consumeRateLimit(`binding-confirm:ip:${ipHash}`, 20, 10 * 60),
      this.repository.consumeRateLimit(`binding-confirm:code:${codeHash}`, 5, 10 * 60),
    ]);
    if (!ipAllowed || !codeAllowed) {
      throw new ServiceError(429, "RATE_LIMITED", "Binding confirmation rate limit exceeded");
    }
    const token = createOpaqueToken("agent");
    const now = new Date().toISOString();
    const binding = await this.repository.findDeviceBindingByCodeHash(codeHash);
    const deviceKey = binding?.deviceKeyId
      ? await this.repository.getDeviceKey(binding.deviceKeyId, binding.userId)
      : undefined;
    const record = await this.repository.claimDeviceBinding(codeHash, {
      id: crypto.randomUUID(),
      name,
      tokenHash: await hashSecret(token),
      scopes: [...AGENT_SCOPES],
      createdAt: now,
    }, now);
    if (!record) throw invalidBindingCode();
    return {
      id: record.id,
      name: record.name,
      scopes: record.scopes,
      token,
      createdAt: record.createdAt,
      ...(deviceKey ? { deviceKey: publicDeviceKey(deviceKey) } : {}),
    };
  }

  async createDirectConnectionEnvelope(
    principal: Principal,
    input: unknown,
  ): Promise<Omit<DirectConnectionEnvelope, "userId">> {
    if (principal.kind !== "agent") {
      throw new ServiceError(403, "FORBIDDEN", "Only a connected Agent can publish a direct connection");
    }
    const body = asRecord(input);
    const projectId = readUUID(body.projectId, "Project ID");
    const project = await this.requireOwnedProject(principal, projectId);
    if (project.deliveryMode !== "private") {
      const pendingPrivateRequest = (
        await this.repository.listDeliveryModeChangeRequests(principal.userId, "pending")
      ).some((request) => request.projectId === projectId && request.toMode === "private");
      if (!pendingPrivateRequest) {
        throw new ServiceError(
          409,
          "PROJECT_HOSTED_MODE",
          "Request Private delivery before publishing its Direct manifest",
        );
      }
    }
    if (body.manifestVersion !== 2) {
      throw invalidRequest("Direct manifest version must be 2");
    }
    const deviceKeyId = readUUID(body.deviceKeyId, "Device key ID");
    const deviceKey = await this.repository.getDeviceKey(deviceKeyId, principal.userId);
    if (!deviceKey) throw invalidRequest("Device key is not available for this account");
    const algorithm = body.algorithm;
    if (algorithm !== "p256-hkdf-sha256-aes-gcm") {
      throw invalidRequest("Unsupported direct connection encryption algorithm");
    }
    const ephemeralPublicKey = readP256PublicKey(
      body.ephemeralPublicKey,
      "Ephemeral public key",
    );
    const sealedBox = readBase64(body.sealedBox, "Encrypted connection package", 29, 65_536);
    const now = new Date();
    const saved = await this.repository.saveDirectConnectionEnvelope({
      id: crypto.randomUUID(),
      userId: principal.userId,
      deviceKeyId,
      projectId,
      manifestVersion: 2,
      algorithm,
      ephemeralPublicKey,
      sealedBox,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    });
    await this.repository.deleteDirectConnectionRecoveryRequest(projectId, deviceKeyId);
    return withoutUserId(saved);
  }

  async listDirectConnectionEnvelopes(
    principal: Principal,
    deviceKeyId: string,
  ): Promise<{ envelopes: Array<Omit<DirectConnectionEnvelope, "userId">> }> {
    this.requireSignedInUser(principal);
    const validDeviceKeyId = readUUID(deviceKeyId, "Device key ID");
    const deviceKey = await this.repository.getDeviceKey(validDeviceKeyId, principal.userId);
    if (!deviceKey) return { envelopes: [] };
    const envelopes = await this.repository.listDirectConnectionEnvelopes(
      principal.userId,
      validDeviceKeyId,
      new Date().toISOString(),
    );
    return { envelopes: envelopes.map(withoutUserId) };
  }

  async acknowledgeDirectConnectionEnvelope(
    principal: Principal,
    envelopeId: string,
    input: unknown,
  ): Promise<{ projectId: string; readyAt: string }> {
    this.requireSignedInUser(principal);
    const deviceKeyId = readUUID(asRecord(input).deviceKeyId, "Device key ID");
    const readyAt = new Date().toISOString();
    const projectId = await this.repository.acknowledgeDirectConnectionEnvelope(
      readUUID(envelopeId, "Envelope ID"),
      principal.userId,
      deviceKeyId,
      readyAt,
    );
    if (!projectId) throw invalidRequest("Direct connection envelope is invalid or expired");
    return { projectId, readyAt };
  }

  async requestDirectConnectionRecovery(
    principal: Principal,
    projectId: string,
    input: unknown,
  ): Promise<{
    projectId: string;
    deviceKeyId: string;
    requestedAt: string;
    status: "pending";
  }> {
    this.requireSignedInUser(principal);
    const project = await this.requireOwnedProject(principal, projectId);
    this.requirePrivateProject(project);
    const body = asStrictRecord(input, [
      "deviceKeyId",
      "installationId",
      "appVersion",
      "buildNumber",
      "notificationAuthorization",
    ]);
    const deviceKeyId = readUUID(body.deviceKeyId, "Device key ID");
    const installationId = readUUID(body.installationId, "Installation ID");
    const deviceKey = await this.repository.getDeviceKey(deviceKeyId, principal.userId);
    if (!deviceKey || deviceKey.installationId !== installationId) {
      throw invalidRequest("Device key is not available for this installation");
    }
    const readinessRecords = await this.repository.listPrivateConnectionReadiness(project.id);
    const hasReadinessForCurrentKey = readinessRecords.some(
      (readiness) =>
        readiness.userId === principal.userId && readiness.deviceKeyId === deviceKeyId,
    );
    if (!hasReadinessForCurrentKey) {
      throw new ServiceError(
        409,
        "PRIVATE_READINESS_REQUIRED",
        "Only a previously acknowledged Direct device key can be recovered",
      );
    }
    const appVersion = readOptionalBoundedString(body.appVersion, "App version", 40);
    const buildNumber = readOptionalBoundedString(body.buildNumber, "Build number", 40);
    const notificationAuthorization = readNotificationAuthorizationDiagnostic(
      body.notificationAuthorization,
    );
    const existing = await this.repository.getDirectConnectionRecoveryRequest(
      project.id,
      deviceKeyId,
    );
    if (existing) return directConnectionRecoveryResponse(existing);

    const allowed = await this.repository.consumeRateLimit(
      `direct-recovery:${principal.userId}:${project.id}:${installationId}`,
      3,
      60 * 60,
    );
    if (!allowed) {
      throw new ServiceError(
        429,
        "RATE_LIMITED",
        "Direct connection recovery rate limit exceeded",
      );
    }
    const result = await this.repository.saveDirectConnectionRecoveryRequestIfAbsent({
      userId: principal.userId,
      projectId: project.id,
      deviceKeyId,
      installationId,
      appVersion,
      buildNumber,
      notificationAuthorization,
      requestedAt: new Date().toISOString(),
    });
    return directConnectionRecoveryResponse(result.request);
  }

  async listDirectConnectionRecoveryRequests(principal: Principal) {
    if (principal.kind !== "agent") {
      throw new ServiceError(
        403,
        "FORBIDDEN",
        "Only a connected Agent can list Direct recovery requests",
      );
    }
    const stored = await this.repository.listDirectConnectionRecoveryRequests(principal.userId);
    const requests: Array<{
      projectId: string;
      deviceKey: ReturnType<typeof publicDeviceKey>;
      requestedAt: string;
    }> = [];
    for (const recovery of stored) {
      const [project, deviceKey] = await Promise.all([
        this.repository.getProject(recovery.projectId),
        this.repository.getDeviceKey(recovery.deviceKeyId, principal.userId),
      ]);
      if (!project || project.userId !== principal.userId || project.deliveryMode !== "private" ||
          !deviceKey || deviceKey.installationId !== recovery.installationId) {
        await this.repository.deleteDirectConnectionRecoveryRequest(
          recovery.projectId,
          recovery.deviceKeyId,
        );
        continue;
      }
      requests.push({
        projectId: recovery.projectId,
        deviceKey: publicDeviceKey(deviceKey),
        requestedAt: recovery.requestedAt,
      });
    }
    return { requests };
  }

  async createDeliveryModeChangeRequest(
    principal: Principal,
    projectId: string,
    input: unknown,
  ): Promise<DeliveryModeChangeRequest> {
    if (principal.kind !== "agent" || !principal.tokenId) {
      throw new ServiceError(403, "FORBIDDEN", "Only a connected Agent can request a mode change");
    }
    const project = await this.requireOwnedProject(principal, projectId);
    const toMode = asRecord(input).toMode;
    if (toMode !== "private" && toMode !== "hosted") {
      throw invalidRequest("toMode must be private or hosted");
    }
    if (toMode === project.deliveryMode) {
      throw invalidRequest(`Project already uses ${toMode} delivery`);
    }
    const now = new Date();
    try {
      const request = await this.repository.saveDeliveryModeChangeRequest({
        id: crypto.randomUUID(),
        projectId,
        userId: principal.userId,
        requestedByTokenId: principal.tokenId,
        fromMode: project.deliveryMode,
        toMode,
        status: "pending",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      });
      if (this.deliveryDispatcher) {
        try {
          await this.deliveryDispatcher.enqueueModeRequest(request, project);
        } catch (error) {
          console.error(
            "Mode request notification enqueue failed",
            error instanceof Error ? error.message : "Unknown error",
          );
        }
      }
      return request;
    } catch (error) {
      if (/pending/iu.test(repositoryErrorText(error))) {
        throw new ServiceError(
          409,
          "PENDING_MODE_REQUEST_EXISTS",
          "A delivery mode request is already pending",
        );
      }
      throw error;
    }
  }

  async listDeliveryModeChangeRequests(
    principal: Principal,
    status?: string,
  ): Promise<{ requests: DeliveryModeChangeRequest[] }> {
    this.requireSignedInUser(principal);
    const parsedStatus = status === undefined
      ? undefined
      : readDeliveryModeRequestStatus(status);
    if (status !== undefined && !parsedStatus) {
      throw invalidRequest("Invalid delivery mode request status");
    }
    return {
      requests: await this.repository.listDeliveryModeChangeRequests(
        principal.userId,
        parsedStatus,
      ),
    };
  }

  async resolveDeliveryModeChangeRequest(
    principal: Principal,
    requestId: string,
    approved: boolean,
  ): Promise<DeliveryModeChangeRequest> {
    this.requireSignedInUser(principal);
    try {
      const request = await this.repository.resolveDeliveryModeChangeRequest(
        readUUID(requestId, "Request ID"),
        principal.userId,
        approved,
        new Date().toISOString(),
      );
      if (!request) throw invalidRequest("Delivery mode request is not pending");
      return request;
    } catch (error) {
      if (/PRIVATE_READINESS_REQUIRED/u.test(repositoryErrorText(error))) {
        throw new ServiceError(
          409,
          "PRIVATE_READINESS_REQUIRED",
          "At least one device must acknowledge Direct manifest v2 before enabling Private",
        );
      }
      throw error;
    }
  }

  async listAgentConnections(principal: Principal): Promise<{ connections: AgentConnection[] }> {
    this.requireSignedInUser(principal);
    const tokens = await this.repository.listAgentTokens(principal.userId);
    return {
      connections: tokens.map((token) => ({
        id: token.id,
        name: token.name,
        scopes: token.scopes,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        expiresAt: token.expiresAt,
      })),
    };
  }

  async revokeAgentConnection(principal: Principal, tokenId: string): Promise<void> {
    this.requireSignedInUser(principal);
    const connection = (await this.repository.listAgentTokens(principal.userId))
      .find((token) => token.id === tokenId);
    if (!connection) {
      throw new ServiceError(404, "AGENT_CONNECTION_NOT_FOUND", "Agent connection not found");
    }
    await this.repository.revokeAgentToken(tokenId, principal.userId, new Date().toISOString());
  }

  async createEventSchema(
    principal: Principal,
    projectId: string,
    input: CreateEventSchemaInput,
  ): Promise<EventSchema> {
    const project = await this.requireOwnedProject(principal, projectId);
    this.requireHostedProject(project);
    const eventType = parseEventType(input.eventType);
    const fields = parseFields(input.fields);
    const schema: EventSchema = {
      id: crypto.randomUUID(),
      projectId,
      eventType,
      fields,
      version: 1,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    const saved = await this.repository.saveEventSchema(schema);
    if (input.notification !== undefined) {
      const notification = asRecord(input.notification);
      await this.createNotificationSurface(principal, projectId, {
        ...notification,
        eventType,
      });
    } else if (saved.version === 1) {
      await this.createDefaultSurface(project, saved);
    }
    return saved;
  }

  async createNotificationSurface(
    principal: Principal,
    projectId: string,
    input: SurfaceInput,
  ): Promise<NotificationSurface> {
    const project = await this.requireOwnedProject(principal, projectId);
    this.requireHostedProject(project);
    const eventType = parseEventType(input.eventType);
    const schema = await this.repository.getEventSchema(projectId, eventType);
    if (!schema) {
      throw new ServiceError(404, "EVENT_SCHEMA_NOT_FOUND", "Event schema not found");
    }
    const title = readNonEmptyString(input.title);
    const body = readNonEmptyString(input.body);
    if (!title || !body) throw invalidRequest("Notification title and body are required");
    validateTemplate(title, schema.fields, "title");
    validateTemplate(body, schema.fields, "body");
    const subtitle = readNonEmptyString(input.subtitle);
    if (subtitle) validateTemplate(subtitle, schema.fields, "subtitle");
    const priority = input.priority === undefined ? "normal" : input.priority;
    if (priority !== "normal" && priority !== "high") {
      throw invalidRequest("Notification priority must be normal or high");
    }
    if (principal.kind === "agent" && priority === "high") {
      throw new ServiceError(403, "FORBIDDEN", "High-priority notifications require user approval");
    }
    return this.repository.saveNotificationSurface({
      id: crypto.randomUUID(),
      projectId,
      eventType,
      type: "notification",
      titleTemplate: title,
      bodyTemplate: body,
      ...(subtitle ? { subtitleTemplate: subtitle } : {}),
      sound: readNonEmptyString(input.sound) ?? "default",
      group: readNonEmptyString(input.group) ?? eventType.split(".")[0] ?? "general",
      priority,
      enabled: input.enabled !== false,
      version: 1,
      createdAt: new Date().toISOString(),
    });
  }

  async upsertLiveSurface(
    principal: Principal,
    projectId: string,
    surfaceKeyValue: string,
    input: unknown,
  ): Promise<LiveSurface> {
    const project = await this.requireOwnedProject(principal, projectId);
    this.requireHostedProject(project);
    return this.saveLiveSurface(project, surfaceKeyValue, input);
  }

  async upsertLiveSurfaceFromIngestToken(
    projectId: string,
    bearerToken: string | undefined,
    surfaceKeyValue: string,
    input: unknown,
  ): Promise<LiveSurface> {
    const project = await this.requireProject(projectId);
    this.requireHostedProject(project);
    const storedToken = await this.requireIngestToken(projectId, bearerToken);
    const entitlement = await this.repository.getAccountEntitlement(
      project.userId,
      new Date().toISOString(),
    );
    const allowed = await this.repository.consumeRateLimit(
      `${projectId}:${storedToken.id}:surface`,
      entitlement.limits.ingestPerMinute,
      60,
    );
    if (!allowed) {
      throw new ServiceError(429, "RATE_LIMITED", "Surface update rate limit exceeded");
    }
    await this.repository.markIngestTokenUsed(storedToken.id, new Date().toISOString());
    return this.saveLiveSurface(project, surfaceKeyValue, input);
  }

  private async saveLiveSurface(
    project: Project,
    surfaceKeyValue: string,
    input: unknown,
  ): Promise<LiveSurface> {
    const projectId = project.id;
    const surfaceKey = parseSurfaceKey(surfaceKeyValue);
    const body = asRecord(input);
    const type = parseLiveSurfaceType(body.type);
    const title = readBoundedString(body.title, "Surface title", 80);
    const subtitle = readOptionalBoundedString(body.subtitle, "Surface subtitle", 120);
    const content = parseLiveSurfaceContent(type, body);
    const action = parseLiveSurfaceAction(body.action);
    const existing = await this.repository.getLiveSurface(projectId, surfaceKey);
    const liveActivity = body.liveActivity === undefined
      ? existing?.liveActivity
      : parseLiveActivityDirective(body.liveActivity);
    const now = new Date().toISOString();
    const displayOrder = existing?.displayOrder
      ?? nextDisplayOrder(await this.repository.listLiveSurfaces(projectId));
    const accepted = await this.repository.acceptHostedSurface({
      id: crypto.randomUUID(),
      projectId,
      surfaceKey,
      type,
      title,
      ...(subtitle ? { subtitle } : {}),
      content,
      ...(action ? { action } : {}),
      ...(liveActivity ? { liveActivity } : {}),
      displayOrder,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }, this.enforcementMode);
    if (accepted.quotaExceeded) {
      await this.captureQuotaEvent(project.userId, project.deliveryMode, accepted, "rejected");
      throw monthlySignalLimitReached(accepted);
    }
    if (accepted.surfaceLimitExceeded) {
      throw new ServiceError(
        409,
        "PLAN_LIMIT_REACHED",
        `Your ${accepted.plan} plan Surface limit has been reached`,
        undefined,
        { plan: accepted.plan, resource: "surfaces" },
      );
    }
    if (!accepted.surface) throw new Error("Hosted Surface was not persisted");
    if (accepted.created) {
      await this.captureQuotaEvent(project.userId, project.deliveryMode, accepted);
      if (this.liveActivityAutomationEnabled && accepted.surface.liveActivity) {
        try {
          await this.deliveryDispatcher?.enqueueLiveSurface?.(accepted.surface, project);
        } catch (error) {
          console.error(
            "Live Activity queue enqueue failed",
            error instanceof Error ? error.message.slice(0, 240) : "Queue unavailable",
          );
        }
      }
    }
    return accepted.surface;
  }

  async listLiveSurfaces(principal: Principal, projectId?: string) {
    const projects = projectId
      ? [await this.requireOwnedProject(principal, projectId)]
      : await this.repository.listProjects(principal.userId);
    const groups = await Promise.all(projects.map(async (project) => ({
      project,
      surfaces: await this.repository.listLiveSurfaces(project.id),
    })));
    return {
      surfaces: groups
        .flatMap(({ project, surfaces }) => surfaces.map((surface) => ({ project, surface })))
        .sort((left, right) =>
          compareDisplayOrder(left.project, right.project)
          || compareDisplayOrder(left.surface, right.surface))
        .map(({ project, surface }) => ({
          ...surface,
          project: { id: project.id, name: project.name, icon: project.icon, logoUrl: project.logoUrl },
        })),
    };
  }

  async updateLiveSurfaceDisplayOrder(
    principal: Principal,
    projectId: string,
    surfaceKeyValue: string,
    input: unknown,
  ): Promise<LiveSurface> {
    await this.requireOwnedProject(principal, projectId);
    const surfaceKey = parseSurfaceKey(surfaceKeyValue);
    const surface = await this.repository.getLiveSurface(projectId, surfaceKey);
    if (!surface) throw new ServiceError(404, "SURFACE_NOT_FOUND", "Live Surface was not found");
    return this.repository.updateLiveSurfaceDisplayOrder(
      surface.id,
      parseDisplayOrder(asRecord(input).displayOrder),
    );
  }

  async deleteLiveSurface(
    principal: Principal,
    projectId: string,
    surfaceKeyValue: string,
  ): Promise<void> {
    await this.requireOwnedProject(principal, projectId);
    const surfaceKey = parseSurfaceKey(surfaceKeyValue);
    const surface = await this.repository.getLiveSurface(projectId, surfaceKey);
    if (!surface) throw new ServiceError(404, "SURFACE_NOT_FOUND", "Surface not found");
    await this.repository.deleteLiveSurface(surface.id);
  }

  async createIngestToken(
    principal: Principal,
    projectId: string,
    input: unknown,
  ): Promise<Omit<IngestToken, "tokenHash"> & { token: string }> {
    const project = await this.requireOwnedProject(principal, projectId);
    this.requireHostedProject(project);
    const body = asRecord(input);
    const name = readNonEmptyString(body.name);
    if (!name) throw invalidRequest("Token name is required");
    const token = createOpaqueToken("ingest");
    const record: IngestToken = {
      id: crypto.randomUUID(),
      projectId,
      name,
      tokenHash: await hashSecret(token),
      scope: "event:ingest",
      createdAt: new Date().toISOString(),
      ...(readDateTime(body.expiresAt) ? { expiresAt: readDateTime(body.expiresAt) } : {}),
    };
    await this.repository.saveIngestToken(record);
    const { tokenHash, ...publicRecord } = record;
    void tokenHash;
    return { ...publicRecord, token };
  }

  async revokeIngestToken(principal: Principal, projectId: string, tokenId: string): Promise<void> {
    await this.requireOwnedProject(principal, projectId);
    const tokens = await this.repository.listIngestTokens(projectId);
    if (!tokens.some((token) => token.id === tokenId)) {
      throw new ServiceError(404, "INVALID_TOKEN", "Ingest token not found");
    }
    await this.repository.revokeIngestToken(tokenId, new Date().toISOString());
  }

  async createPrivateWakeToken(
    principal: Principal,
    projectId: string,
    input: unknown,
  ): Promise<Omit<PrivateWakeToken, "tokenHash"> & { token: string }> {
    const project = await this.requireOwnedProject(principal, projectId);
    this.requirePrivateProject(project);
    const body = asRecord(input);
    const name = readNonEmptyString(body.name);
    if (!name || name.length > 80) {
      throw invalidRequest("Token name must contain 1 to 80 characters");
    }
    const expiresAt = readDateTime(body.expiresAt);
    const token = createOpaqueToken("wake");
    const record: PrivateWakeToken = {
      id: crypto.randomUUID(),
      projectId,
      name,
      tokenHash: await hashSecret(token),
      scope: "wake:send",
      createdAt: new Date().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
    };
    await this.repository.savePrivateWakeToken(record);
    const { tokenHash, ...publicRecord } = record;
    void tokenHash;
    return { ...publicRecord, token };
  }

  async revokePrivateWakeToken(
    principal: Principal,
    projectId: string,
    tokenId: string,
  ): Promise<void> {
    await this.requireOwnedProject(principal, projectId);
    const tokens = await this.repository.listPrivateWakeTokens(projectId);
    if (!tokens.some((token) => token.id === tokenId)) {
      throw new ServiceError(404, "INVALID_TOKEN", "Private wake token not found");
    }
    await this.repository.revokePrivateWakeToken(tokenId, new Date().toISOString());
  }

  async ingestPrivateWake(
    projectId: string,
    bearerToken: string | undefined,
    idempotencyKeyValue: string | undefined,
    input: unknown,
  ): Promise<PrivateWakeResult> {
    const project = await this.requireProject(projectId);
    this.requirePrivateProject(project);
    if (project.status !== "active") {
      throw new ServiceError(409, "PROJECT_PAUSED", "Project is paused");
    }
    const storedToken = await this.requirePrivateWakeToken(projectId, bearerToken);
    const entitlement = await this.repository.getAccountEntitlement(
      project.userId,
      new Date().toISOString(),
    );
    const allowed = await this.repository.consumeRateLimit(
      `${projectId}:${storedToken.id}:wake`,
      entitlement.limits.ingestPerMinute,
      60,
    );
    if (!allowed) {
      throw new ServiceError(429, "RATE_LIMITED", "Private wake rate limit exceeded");
    }

    const idempotencyKey = readIdempotencyKey(idempotencyKeyValue);
    const body = asStrictRecord(input, ["reference", "priority"]);
    const reference = readOpaqueReference(body.reference);
    const priority = body.priority === undefined ? "normal" : body.priority;
    if (priority !== "normal" && priority !== "high") {
      throw invalidRequest("priority must be normal or high");
    }

    const now = new Date();
    const metered = await this.repository.acceptPrivateWake({
      id: crypto.randomUUID(),
      projectId,
      idempotencyKeyHash: await hashSecret(idempotencyKey),
      reference,
      priority,
      receivedAt: now.toISOString(),
      referenceExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    }, this.enforcementMode);
    if (metered.quotaExceeded) {
      await this.captureQuotaEvent(project.userId, project.deliveryMode, metered, "rejected");
      throw monthlySignalLimitReached(metered);
    }
    if (!metered.wake) throw new Error("Private wake was not persisted");
    await this.repository.markPrivateWakeTokenUsed(storedToken.id, now.toISOString());
    let deliveryQueued: boolean | undefined;
    if (metered.created) {
      deliveryQueued = await this.dispatchPrivateWake(project, metered.wake);
    } else {
      const deliveries = await this.repository.listPrivateWakeDeliveries(metered.wake.id);
      if (deliveries.some((delivery) =>
        delivery.status === "queued" || delivery.status === "accepted_by_apns"
      )) {
        deliveryQueued = true;
      } else if (
        deliveries.length > 0
        && deliveries.every((delivery) =>
          delivery.status === "failed"
          && delivery.errorCode === "retryable:QueueUnavailable"
        )
      ) {
        const referenceExpiresAt = Date.parse(metered.wake.referenceExpiresAt);
        deliveryQueued = metered.wake.reference
          && Number.isFinite(referenceExpiresAt)
          && referenceExpiresAt > now.getTime()
          ? (await this.dispatchPrivateWake(project, metered.wake)) ?? false
          : false;
      } else if (deliveries.length > 0) {
        deliveryQueued = false;
      }
    }
    if (metered.created) {
      await this.captureQuotaEvent(project.userId, project.deliveryMode, metered);
    }
    return {
      wakeId: metered.wake.id,
      deduplicated: !metered.created,
      ...(deliveryQueued === undefined ? {} : { deliveryQueued }),
      usage: signalUsageResult(metered),
    };
  }

  async ingestEvent(
    projectId: string,
    bearerToken: string | undefined,
    idempotencyKeyValue: string | undefined,
    input: IngestEventInput,
  ): Promise<IngestEventResult> {
    const project = await this.requireProject(projectId);
    this.requireHostedProject(project);
    if (project.status !== "active") {
      throw new ServiceError(409, "PROJECT_PAUSED", "Project is paused");
    }
    const storedToken = await this.requireIngestToken(projectId, bearerToken);
    const entitlement = await this.repository.getAccountEntitlement(
      project.userId,
      new Date().toISOString(),
    );
    const allowed = await this.repository.consumeRateLimit(
      `${projectId}:${storedToken.id}`,
      entitlement.limits.ingestPerMinute,
      60,
    );
    if (!allowed) {
      throw new ServiceError(429, "RATE_LIMITED", "Event rate limit exceeded");
    }
    const idempotencyKey = readIdempotencyKey(idempotencyKeyValue);
    await this.repository.markIngestTokenUsed(storedToken.id, new Date().toISOString());
    return this.acceptEvent(project, idempotencyKey, input);
  }

  async sendTestEvent(principal: Principal, projectId: string, input: IngestEventInput) {
    const project = await this.requireOwnedProject(principal, projectId);
    this.requireHostedProject(project);
    return this.acceptEvent(project, `test-${crypto.randomUUID()}`, input);
  }

  async listEvents(
    principal: Principal,
    projectId: string,
    options: { cursor?: string; limit?: number; eventType?: string; unreadOnly?: boolean },
  ) {
    await this.requireOwnedProject(principal, projectId);
    if (options.cursor) {
      try {
        decodeEventCursor(options.cursor);
      } catch {
        throw new ServiceError(400, "INVALID_CURSOR", "Invalid Event cursor");
      }
    }
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    const page = await this.repository.listEvents(projectId, { ...options, limit });
    return this.redactEventPage(page);
  }

  async listInbox(principal: Principal, options: { limit?: number; unreadOnly?: boolean }) {
    const projects = await this.repository.listProjects(principal.userId);
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    const pages = await Promise.all(
      projects.map(async (project) => ({
        project,
        page: await this.redactEventPage(
          await this.repository.listEvents(project.id, {
            limit,
            unreadOnly: options.unreadOnly,
          }),
        ),
      })),
    );
    const events = pages
      .flatMap(({ project, page }) =>
        page.events.map((event) => ({
          ...event,
          project: { id: project.id, name: project.name, icon: project.icon, logoUrl: project.logoUrl },
        })),
      )
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, limit);
    return { events };
  }

  async getEventDetail(principal: Principal, eventId: string) {
    const event = await this.repository.getEvent(eventId);
    if (!event) throw new ServiceError(404, "EVENT_NOT_FOUND", "Event not found");
    const project = await this.requireOwnedProject(principal, event.projectId);
    const deliveries = await this.repository.listDeliveries(event.id);
    return {
      ...event,
      project: { id: project.id, name: project.name, icon: project.icon, logoUrl: project.logoUrl },
      sensitiveFields: eventSensitiveFields(event),
      deliveries,
    };
  }

  async markEventRead(principal: Principal, eventId: string) {
    const event = await this.repository.getEvent(eventId);
    if (!event) throw new ServiceError(404, "EVENT_NOT_FOUND", "Event not found");
    await this.requireOwnedProject(principal, event.projectId);
    const readAt = event.readAt ?? new Date().toISOString();
    await this.repository.markEventRead(eventId, readAt);
    return { readAt };
  }

  async markAllEventsRead(principal: Principal) {
    const projects = await this.repository.listProjects(principal.userId);
    const readAt = new Date().toISOString();
    const updatedCount = await this.repository.markAllEventsRead(
      projects.map((project) => project.id),
      readAt,
    );
    return { readAt, updatedCount };
  }

  async getDeliveryHealth(principal: Principal, projectId: string) {
    await this.requireOwnedProject(principal, projectId);
    return this.repository.getDeliveryHealth(projectId, deliveryHealthWindowStart());
  }

  async exportHostedProject(principal: Principal, projectId: string) {
    const project = await this.requireOwnedProject(principal, projectId);
    this.requireHostedProject(project);
    const entitlement = await this.repository.getAccountEntitlement(
      principal.userId,
      new Date().toISOString(),
    );
    if (entitlement.plan !== "pro") {
      throw planLimitReached("project export", entitlement);
    }

    const events: Array<BellwireEvent & { deliveries: Delivery[] }> = [];
    let cursor: string | undefined;
    do {
      const page = await this.repository.listEvents(project.id, { cursor, limit: 100 });
      const exported = await Promise.all(
        page.events.map(async (event) => ({
          ...event,
          deliveries: await this.repository.listDeliveries(event.id),
        })),
      );
      events.push(...exported);
      cursor = page.nextCursor;
      if (events.length >= 10_000) break;
    } while (cursor);

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      project: {
        id: project.id,
        name: project.name,
        deliveryMode: project.deliveryMode,
      },
      events: events.slice(0, 10_000),
    };
  }

  async getDeliveries(principal: Principal, eventId: string): Promise<{ deliveries: Delivery[] }> {
    const event = await this.repository.getEvent(eventId);
    if (!event) throw new ServiceError(404, "EVENT_NOT_FOUND", "Event not found");
    await this.requireOwnedProject(principal, event.projectId);
    return { deliveries: await this.repository.listDeliveries(eventId) };
  }

  private async acceptEvent(
    project: Project,
    idempotencyKey: string,
    input: IngestEventInput,
    dispatch = true,
  ): Promise<IngestEventResult> {
    const eventType = readNonEmptyString(input.type);
    if (!eventType) throw invalidRequest("Event type is required");
    const schema = await this.repository.getEventSchema(project.id, eventType);
    if (!schema) {
      throw new ServiceError(
        422,
        "EVENT_SCHEMA_NOT_FOUND",
        `No active schema exists for event type ${eventType}`,
      );
    }
    if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) {
      throw invalidRequest("Event data must be a JSON object");
    }
    const data = input.data as Record<string, unknown>;
    if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 8_192) {
      throw new ServiceError(413, "PAYLOAD_TOO_LARGE", "Event data must not exceed 8192 bytes");
    }
    const occurredAt = readDateTime(input.occurredAt);
    const issues = validateEventData(schema.fields, data);
    if (!occurredAt) issues.push({ field: "occurredAt", message: "must be a valid datetime string" });
    if (issues.length > 0) {
      throw new ServiceError(
        422,
        "SCHEMA_VALIDATION_FAILED",
        "Event data does not match its schema",
        issues,
      );
    }
    const event: BellwireEvent = {
      id: crypto.randomUUID(),
      projectId: project.id,
      eventType,
      idempotencyKeyHash: await hashSecret(idempotencyKey),
      data,
      sensitiveFields: Object.entries(schema.fields)
        .filter(([, definition]) => definition.sensitive === true)
        .map(([name]) => name),
      occurredAt: occurredAt as string,
      receivedAt: new Date().toISOString(),
      status: "accepted",
    };
    const saved = await this.repository.acceptHostedEvent(event, this.enforcementMode);
    if (saved.quotaExceeded) {
      await this.captureQuotaEvent(project.userId, project.deliveryMode, saved, "rejected");
      throw monthlySignalLimitReached(saved);
    }
    if (!saved.event) throw new Error("Hosted event was not persisted");
    const previousQueueFailure = !saved.created && (await this.repository.listDeliveries(saved.event.id))
      .some((delivery) => delivery.errorCode === "retryable:QueueUnavailable");
    const deliveryQueued = dispatch && project.status === "active" && (saved.created || previousQueueFailure)
      ? await this.dispatchEvent(project, saved.event)
      : undefined;
    if (saved.created) {
      await this.captureQuotaEvent(project.userId, project.deliveryMode, saved);
    }
    return {
      eventId: saved.event.id,
      deduplicated: !saved.created,
      ...(deliveryQueued === undefined ? {} : { deliveryQueued }),
      usage: signalUsageResult(saved),
    };
  }

  private async dispatchEvent(
    project: Project,
    event: BellwireEvent,
  ): Promise<boolean | undefined> {
    if (!this.deliveryDispatcher) return undefined;
    const devices = (await this.repository.listDevices(project.userId))
      .filter((device) => device.pushEnabled);
    if (devices.length === 0) return undefined;
    try {
      await this.deliveryDispatcher.enqueue(event);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 240) : "Queue unavailable";
      console.error("Delivery queue enqueue failed", message);
      await Promise.allSettled(devices.map(async (device) => {
        const now = new Date().toISOString();
        const result = await this.repository.createDeliveryIfAbsent({
          id: crypto.randomUUID(),
          eventId: event.id,
          deviceId: device.id,
          channel: "apns",
          status: "queued",
          attemptCount: 0,
          queuedAt: now,
          updatedAt: now,
        });
        if (result.delivery.status !== "queued" || result.delivery.attemptCount !== 0) return;
        await this.repository.recordQueueUnavailable(result.delivery, now, message);
      }));
      return false;
    }
  }

  private async findVerifiedLegacyDemo(
    projects: Project[],
    demoIdempotencyHash: string,
  ): Promise<{ project: Project; event?: BellwireEvent } | undefined> {
    const candidates = projects.filter((project) =>
      project.name === DEMO_PROJECT_NAME
      && project.category === "demo"
      && project.icon === "bell.and.waves.left.and.right"
      && project.deliveryMode === "hosted"
      && project.endpoint === `/v1/events/${project.id}`
      && /^bellwire-demo-[0-9a-f]{6}$/u.test(project.slug)
    );
    for (const project of candidates) {
      const [schema, notification, liveSurface, matchingEvents, fixedEvent] = await Promise.all([
        this.repository.getEventSchema(project.id, DEMO_EVENT_TYPE),
        this.repository.getNotificationSurface(project.id, DEMO_EVENT_TYPE),
        this.repository.getLiveSurface(project.id, DEMO_SURFACE_KEY),
        this.listCanonicalDemoEvents(project.id),
        this.repository.getEventByIdempotencyHash(project.id, demoIdempotencyHash),
      ]);
      if (
        !isCanonicalDemoConfiguration(schema, notification, liveSurface)
        || matchingEvents.length > 1
        || (fixedEvent !== undefined && fixedEvent.id !== matchingEvents[0]?.id)
      ) {
        continue;
      }
      return { project, ...(matchingEvents[0] ? { event: matchingEvents[0] } : {}) };
    }
    return undefined;
  }

  private async listCanonicalDemoEvents(projectId: string): Promise<BellwireEvent[]> {
    const matches: BellwireEvent[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.repository.listEvents(projectId, {
        eventType: DEMO_EVENT_TYPE,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      matches.push(...page.events.filter(isCanonicalDemoEvent));
      if (matches.length > 1) break;
      cursor = page.nextCursor;
    } while (cursor);
    return matches;
  }

  private async isVerifiedReservedDemo(project: Project): Promise<boolean> {
    if (project.endpoint !== `/v1/events/${project.id}`) return false;
    if (
      project.deliveryMode === "hosted"
      && project.category === "demo"
      && project.icon === "bell.and.waves.left.and.right"
    ) {
      return true;
    }
    const [schema, notification, liveSurface] = await Promise.all([
      this.repository.getEventSchema(project.id, DEMO_EVENT_TYPE),
      this.repository.getNotificationSurface(project.id, DEMO_EVENT_TYPE),
      this.repository.getLiveSurface(project.id, DEMO_SURFACE_KEY),
    ]);
    return isCanonicalDemoConfiguration(schema, notification, liveSurface);
  }

  private async ensureDemoDeliveryForDevice(device: Device): Promise<void> {
    if (!this.deliveryDispatcher || !device.pushEnabled) return;
    const demoIdempotencyHash = await hashSecret(DEMO_EVENT_IDEMPOTENCY_KEY);
    const demoProjects = (await this.repository.listProjects(device.userId))
      .filter((project) =>
        project.slug === DEMO_PROJECT_SLUG
        && project.deliveryMode === "hosted"
        && project.status === "active"
      );
    for (const project of demoProjects) {
      const event = await this.repository.getEventByIdempotencyHash(
        project.id,
        demoIdempotencyHash,
      );
      if (event) await this.ensureDemoEventDelivery(project, event, [device]);
    }
  }

  private async ensureDemoEventDelivery(
    project: Project,
    event: BellwireEvent,
    devices: Device[],
  ): Promise<void> {
    if (!this.deliveryDispatcher || project.status !== "active" || devices.length === 0) return;
    const candidates: Delivery[] = [];
    for (const device of devices) {
      const now = new Date().toISOString();
      const result = await this.repository.createDeliveryIfAbsent({
        id: crypto.randomUUID(),
        eventId: event.id,
        deviceId: device.id,
        channel: "apns",
        status: "queued",
        attemptCount: 0,
        queuedAt: now,
        updatedAt: now,
      });
      if (
        result.created
        || (result.delivery.status === "queued" && result.delivery.attemptCount === 0)
        || (
          result.delivery.status === "failed"
          && result.delivery.errorCode === "retryable:QueueUnavailable"
        )
      ) {
        candidates.push(result.delivery);
      }
    }
    if (candidates.length === 0) return;

    try {
      await this.deliveryDispatcher.enqueue(event);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 240) : "Queue unavailable";
      console.error("Demo delivery queue enqueue failed", message);
      const failedAt = new Date().toISOString();
      await Promise.allSettled(candidates.map((delivery) =>
        this.repository.recordQueueUnavailable(delivery, failedAt, message)
      ));
    }
  }

  private async dispatchPrivateWake(
    project: Project,
    wake: PrivateWake,
  ): Promise<boolean | undefined> {
    if (!this.deliveryDispatcher) return undefined;
    const devices = (await this.repository.listDevices(project.userId))
      .filter((device) => device.pushEnabled);
    if (devices.length === 0) return undefined;
    try {
      await this.deliveryDispatcher.enqueuePrivateWake(wake);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 240) : "Queue unavailable";
      console.error("Private wake queue enqueue failed", message);
      const now = new Date().toISOString();
      await Promise.allSettled(devices.map(async (device) => {
        await this.repository.createPrivateWakeDeliveryIfAbsent({
          id: crypto.randomUUID(),
          wakeId: wake.id,
          deviceId: device.id,
          channel: "apns",
          status: "failed",
          attemptCount: 0,
          errorCode: "retryable:QueueUnavailable",
          errorMessage: message,
          queuedAt: now,
          updatedAt: now,
        });
      }));
      return false;
    }
  }

  private async createDefaultSurface(project: Project, schema: EventSchema): Promise<void> {
    await this.repository.saveNotificationSurface({
      id: crypto.randomUUID(),
      projectId: project.id,
      eventType: schema.eventType,
      type: "notification",
      titleTemplate: humanizeEventType(schema.eventType),
      bodyTemplate: `New event from ${project.name}`,
      sound: "default",
      group: schema.eventType.split(".")[0] ?? "general",
      priority: "normal",
      enabled: true,
      version: 1,
      createdAt: new Date().toISOString(),
    });
  }

  private async redactEventPage(
    page: Awaited<ReturnType<BellwireRepository["listEvents"]>>,
  ) {
    return {
      ...page,
      events: page.events.map((event) => {
        const sensitiveFields = eventSensitiveFields(event);
        const sensitive = new Set(sensitiveFields);
        const data = Object.fromEntries(
          Object.entries(event.data).filter(([name]) => !sensitive.has(name)),
        );
        return { ...event, data, sensitiveFields };
      }),
    };
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.repository.getProject(projectId);
    if (!project) throw new ServiceError(404, "PROJECT_NOT_FOUND", "Project not found");
    return project;
  }

  private async requireIngestToken(projectId: string, bearerToken: string | undefined) {
    const rawToken = readBearerToken(bearerToken);
    if (!rawToken) throw invalidToken();
    const storedToken = await this.repository.findIngestTokenByHash(
      projectId,
      await hashSecret(rawToken),
    );
    if (!storedToken) throw invalidToken();
    return storedToken;
  }

  private async requirePrivateWakeToken(projectId: string, bearerToken: string | undefined) {
    const rawToken = readBearerToken(bearerToken);
    if (!rawToken?.startsWith("bw_wake_")) throw invalidToken("Invalid private wake token");
    const storedToken = await this.repository.findPrivateWakeTokenByHash(
      projectId,
      await hashSecret(rawToken),
    );
    if (!storedToken) throw invalidToken("Invalid private wake token");
    return storedToken;
  }

  private async requireOwnedProject(principal: Principal, projectId: string): Promise<Project> {
    const project = await this.requireProject(projectId);
    if (project.userId !== principal.userId) {
      throw new ServiceError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    return project;
  }

  private requireSignedInUser(principal: Principal): void {
    if (principal.kind !== "user") {
      throw new ServiceError(403, "FORBIDDEN", "This action requires a signed-in user");
    }
  }

  private requireHostedProject(project: Project): void {
    if (project.deliveryMode !== "hosted") {
      throw new ServiceError(409, "PROJECT_PRIVATE_MODE", "Project uses Private delivery");
    }
  }

  private requirePrivateProject(project: Project): void {
    if (project.deliveryMode !== "private") {
      throw new ServiceError(409, "PROJECT_HOSTED_MODE", "Project uses Hosted delivery");
    }
  }

  private async captureQuotaEvent(
    userId: string,
    deliveryMode: ProjectDeliveryMode,
    value: {
      plan: "free" | "pro";
      acceptedSignals: number;
      signalLimit: number;
    },
    state?: "rejected",
  ): Promise<void> {
    if (!this.analytics) return;
    const usagePercent = Math.round((value.acceptedSignals / value.signalLimit) * 10_000) / 100;
    const properties = { plan: value.plan, deliveryMode, usagePercent };
    if (state === "rejected") {
      await this.analytics.capture(userId, "quota_rejected", properties);
    } else if (value.acceptedSignals === Math.ceil(value.signalLimit * 0.8)) {
      await this.analytics.capture(userId, "quota_warning_80", properties);
    } else if (value.acceptedSignals === value.signalLimit) {
      await this.analytics.capture(userId, "quota_reached_100", properties);
    } else if (value.acceptedSignals === value.signalLimit + 1) {
      await this.analytics.capture(userId, "quota_grace_used", properties);
    }
  }
}

function deliveryHealthWindowStart(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
}

function eventSensitiveFields(event: BellwireEvent): string[] {
  return event.sensitiveFields ?? Object.keys(event.data);
}

function invalidRequest(message: string): ServiceError {
  return new ServiceError(400, "INVALID_REQUEST", message);
}

function repositoryErrorText(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  if (typeof error !== "object" || error === null || !("body" in error)) {
    return parts.join(" ");
  }

  const body = error.body;
  if (typeof body === "string") {
    parts.push(body);
  } else if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ["code", "message", "details", "hint"] as const) {
      if (typeof record[key] === "string") parts.push(record[key]);
    }
  }
  return parts.join(" ");
}

function readDeliveryModeRequestStatus(
  value: unknown,
): DeliveryModeChangeRequest["status"] | undefined {
  return value === "pending" || value === "approved" || value === "rejected" || value === "expired"
    ? value
    : undefined;
}

function planLimitReached(resource: string, entitlement: AccountEntitlement): ServiceError {
  return new ServiceError(
    409,
    "PLAN_LIMIT_REACHED",
    `Your ${entitlement.plan} plan limit for ${resource} has been reached`,
    undefined,
    {
      plan: entitlement.plan,
      resource,
      limits: entitlement.limits,
    },
  );
}

function monthlySignalLimitReached(value: {
  plan: "free" | "pro";
  acceptedSignals: number;
  signalLimit: number;
  courtesyLimit: number;
  resetAt: string;
}): ServiceError {
  return new ServiceError(
    429,
    "MONTHLY_SIGNAL_LIMIT_REACHED",
    "Monthly Signal limit reached",
    undefined,
    {
      plan: value.plan,
      limit: value.signalLimit,
      courtesyLimit: value.courtesyLimit,
      used: value.acceptedSignals,
      resetAt: value.resetAt,
    },
  );
}

function signalUsageResult(value: {
  plan: "free" | "pro";
  acceptedSignals: number;
  signalLimit: number;
  courtesyLimit: number;
  resetAt: string;
}): SignalUsageResult {
  return {
    plan: value.plan,
    used: value.acceptedSignals,
    limit: value.signalLimit,
    courtesyLimit: value.courtesyLimit,
    resetAt: value.resetAt,
  };
}

function invalidToken(message = "Invalid ingest token"): ServiceError {
  return new ServiceError(401, "INVALID_TOKEN", message);
}

function invalidBindingCode(): ServiceError {
  return new ServiceError(400, "INVALID_BINDING_CODE", "Binding code is invalid or expired");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asStrictRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest("A JSON object is required");
  }
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.includes(key));
  if (unknownKey) throw invalidRequest(`Unknown field: ${unknownKey}`);
  return record;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readIdempotencyKey(value: unknown): string {
  const key = readNonEmptyString(value);
  if (!key) {
    throw new ServiceError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
  }
  if (key.length > 200) throw invalidRequest("Idempotency-Key must be at most 200 characters");
  return key;
}

function readOpaqueReference(value: unknown): string {
  const reference = readNonEmptyString(value);
  if (!reference || !/^[A-Za-z0-9_-]{22,200}$/u.test(reference)) {
    throw invalidRequest(
      "reference must be a 22 to 200 character URL-safe opaque value",
    );
  }
  return reference;
}

function readUUID(value: unknown, name: string): string {
  const result = readNonEmptyString(value)?.toLowerCase();
  if (!result || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(result)) {
    throw invalidRequest(`${name} must be a UUID`);
  }
  return result;
}

function parseDeviceKey(value: Record<string, unknown>, userId: string): DeviceKey | undefined {
  if (Object.keys(value).length === 0) return undefined;
  if (value.algorithm !== "p256") throw invalidRequest("Device key algorithm must be p256");
  const now = new Date().toISOString();
  return {
    id: readUUID(value.id, "Device key ID"),
    userId,
    installationId: readUUID(value.installationId, "Installation ID"),
    agreementPublicKey: readP256PublicKey(
      value.agreementPublicKey,
      "Agreement public key",
    ),
    signingPublicKey: readP256PublicKey(value.signingPublicKey, "Signing public key"),
    algorithm: "p256",
    createdAt: now,
    lastActiveAt: now,
  };
}

function publicDeviceKey(value: DeviceKey) {
  return {
    id: value.id,
    installationId: value.installationId,
    agreementPublicKey: value.agreementPublicKey,
    signingPublicKey: value.signingPublicKey,
    algorithm: value.algorithm,
  };
}

function sameDeviceKeyDescriptor(left: DeviceKey, right: DeviceKey): boolean {
  return left.id === right.id &&
    left.userId === right.userId &&
    left.installationId === right.installationId &&
    left.agreementPublicKey === right.agreementPublicKey &&
    left.signingPublicKey === right.signingPublicKey &&
    left.algorithm === right.algorithm;
}

function directConnectionRecoveryResponse(value: DirectConnectionRecoveryRequest) {
  return {
    projectId: value.projectId,
    deviceKeyId: value.deviceKeyId,
    requestedAt: value.requestedAt,
    status: "pending" as const,
  };
}

function readNotificationAuthorizationDiagnostic(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !(NOTIFICATION_AUTHORIZATION_DIAGNOSTICS as readonly string[]).includes(value)
  ) {
    throw invalidRequest("Notification authorization diagnostic is invalid");
  }
  return value as (typeof NOTIFICATION_AUTHORIZATION_DIAGNOSTICS)[number];
}

function readP256PublicKey(value: unknown, name: string): string {
  const encoded = readBase64(value, name, 65, 65);
  const bytes = decodeBase64(encoded);
  if (bytes[0] !== 4) throw invalidRequest(`${name} must use uncompressed P-256 representation`);
  return encoded;
}

function readBase64(
  value: unknown,
  name: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  const encoded = readNonEmptyString(value);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw invalidRequest(`${name} must be valid base64`);
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(encoded);
  } catch {
    throw invalidRequest(`${name} must be valid base64`);
  }
  if (bytes.byteLength < minimumBytes || bytes.byteLength > maximumBytes) {
    throw invalidRequest(`${name} has an invalid size`);
  }
  return encoded;
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function withoutUserId(value: DirectConnectionEnvelope): Omit<DirectConnectionEnvelope, "userId"> {
  return {
    id: value.id,
    deviceKeyId: value.deviceKeyId,
    projectId: value.projectId,
    manifestVersion: value.manifestVersion,
    algorithm: value.algorithm,
    ephemeralPublicKey: value.ephemeralPublicKey,
    sealedBox: value.sealedBox,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function readDateTime(value: unknown): string | undefined {
  const dateTime = readNonEmptyString(value);
  return dateTime && !Number.isNaN(Date.parse(dateTime)) ? dateTime : undefined;
}

function readBoundedString(value: unknown, name: string, maximum: number): string {
  const result = readNonEmptyString(value);
  if (!result) throw invalidRequest(`${name} is required`);
  if (result.length > maximum) throw invalidRequest(`${name} must be at most ${maximum} characters`);
  return result;
}

function readOptionalBoundedString(
  value: unknown,
  name: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return readBoundedString(value, name, maximum);
}

function readProjectLogoUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const logoUrl = readBoundedString(value, "Project logo URL", 2_048);
  try {
    const parsed = new URL(logoUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) {
      throw new Error("invalid logo URL");
    }
  } catch {
    throw invalidRequest("Project logo URL must be a public HTTPS URL");
  }
  return logoUrl;
}

function parseDisplayOrder(value: unknown): number {
  const displayOrder = readInteger(value);
  if (displayOrder === undefined || displayOrder < 0 || displayOrder > 1_000_000) {
    throw invalidRequest("displayOrder must be an integer between 0 and 1000000");
  }
  return displayOrder;
}

function nextDisplayOrder(values: Array<{ displayOrder: number }>): number {
  return values.reduce((maximum, value) => Math.max(maximum, value.displayOrder), -1) + 1;
}

function compareDisplayOrder(
  left: { displayOrder: number; id: string },
  right: { displayOrder: number; id: string },
): number {
  return left.displayOrder - right.displayOrder || left.id.localeCompare(right.id);
}

function parseSurfaceKey(value: unknown): string {
  const key = readNonEmptyString(value);
  if (!key || key.length > 80 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(key)) {
    throw invalidRequest("surfaceKey must use lowercase letters, digits, dots, dashes, or underscores");
  }
  return key;
}

function parseLiveSurfaceType(value: unknown): LiveSurfaceType {
  if (typeof value !== "string" || !(LIVE_SURFACE_TYPES as readonly string[]).includes(value)) {
    throw invalidRequest(`Surface type must be one of: ${LIVE_SURFACE_TYPES.join(", ")}`);
  }
  return value as LiveSurfaceType;
}

const SURFACE_COLORS = [
  "lime", "green", "cyan", "blue", "purple", "magenta", "red", "orange", "yellow", "gray",
] as const;

const SURFACE_STATUS_STATES = [
  "neutral", "running", "success", "warning", "critical", "paused",
] as const;

const SURFACE_CHECKLIST_STATES = [
  "pending", "running", "completed", "failed", "skipped",
] as const;

const SURFACE_TREND_GOALS = ["up", "down", "neutral"] as const;

function parseLiveSurfaceContent(
  type: LiveSurfaceType,
  body: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case "stats":
      return { metrics: parseSurfaceMetrics(body.metrics, 8, false) };
    case "metrics":
      return { metrics: parseSurfaceMetrics(body.metrics, 4, true) };
    case "progress": {
      const percentage = readFiniteNumber(body.percentage);
      const value = readFiniteNumber(body.value);
      const upperLimit = readFiniteNumber(body.upperLimit);
      if (percentage !== undefined) {
        if (percentage < 0 || percentage > 100) throw invalidRequest("percentage must be between 0 and 100");
        return { percentage };
      }
      if (value === undefined || upperLimit === undefined || upperLimit <= 0 || value < 0 || value > upperLimit) {
        throw invalidRequest("progress requires percentage or value with a positive upperLimit");
      }
      return { value, upperLimit };
    }
    case "segmented_progress": {
      const numberOfSteps = readInteger(body.numberOfSteps);
      const currentStep = readInteger(body.currentStep);
      if (!numberOfSteps || numberOfSteps > 12) {
        throw invalidRequest("numberOfSteps must be between 1 and 12");
      }
      if (currentStep === undefined || currentStep < 0 || currentStep > numberOfSteps) {
        throw invalidRequest("currentStep must be between 0 and numberOfSteps");
      }
      const stepLabel = readOptionalBoundedString(body.stepLabel, "stepLabel", 80);
      return { numberOfSteps, currentStep, ...(stepLabel ? { stepLabel } : {}) };
    }
    case "alert": {
      const message = readBoundedString(body.message, "Alert message", 240);
      const icon = parseSurfaceAdornment(body.icon, "icon", true);
      const badge = parseSurfaceAdornment(body.badge, "badge", false);
      return { message, ...(icon ? { icon } : {}), ...(badge ? { badge } : {}) };
    }
    case "timer": {
      const durationSeconds = readInteger(body.durationSeconds);
      if (!durationSeconds || durationSeconds > 604_800) {
        throw invalidRequest("durationSeconds must be between 1 and 604800");
      }
      if (body.countsDown !== undefined && typeof body.countsDown !== "boolean") {
        throw invalidRequest("countsDown must be boolean");
      }
      return { durationSeconds, countsDown: body.countsDown !== false };
    }
    case "status": {
      const state = readEnumValue(
        body.state,
        SURFACE_STATUS_STATES,
        "state",
      );
      const label = readOptionalBoundedString(body.label, "label", 32);
      return { state, ...(label ? { label } : {}) };
    }
    case "checklist": {
      if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 8) {
        throw invalidRequest("items must contain between 1 and 8 checklist entries");
      }
      const ids = new Set<string>();
      const items = body.items.map((rawItem, index) => {
        const item = asRecord(rawItem);
        const id = readBoundedString(item.id, `items[${index}].id`, 64);
        if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(id)) {
          throw invalidRequest(`items[${index}].id must be a stable lowercase key`);
        }
        if (ids.has(id)) throw invalidRequest("Checklist item IDs must be unique");
        ids.add(id);
        const title = readBoundedString(item.title, `items[${index}].title`, 80);
        const detail = readOptionalBoundedString(item.detail, `items[${index}].detail`, 120);
        const state = readEnumValue(
          item.state,
          SURFACE_CHECKLIST_STATES,
          `items[${index}].state`,
        );
        return { id, title, state, ...(detail ? { detail } : {}) };
      });
      return { items };
    }
    case "trend": {
      if (!Array.isArray(body.points) || body.points.length < 2 || body.points.length > 30) {
        throw invalidRequest("points must contain between 2 and 30 trend points");
      }
      const points = body.points.map((rawPoint, index) => {
        const point = asRecord(rawPoint);
        const label = readBoundedString(point.label, `points[${index}].label`, 24);
        const value = readFiniteNumber(point.value);
        if (value === undefined) throw invalidRequest(`points[${index}].value must be a finite number`);
        return { label, value };
      });
      const goal = readEnumValue(body.goal, SURFACE_TREND_GOALS, "goal");
      const displayValue = readOptionalBoundedString(body.displayValue, "displayValue", 64);
      const unit = readOptionalBoundedString(body.unit, "unit", 16);
      return {
        points,
        goal,
        ...(displayValue ? { displayValue } : {}),
        ...(unit ? { unit } : {}),
      };
    }
  }
}

function readEnumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  name: string,
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw invalidRequest(`${name} must be one of: ${values.join(", ")}`);
  }
  return value as Values[number];
}

function parseSurfaceMetrics(value: unknown, maximum: number, numeric: boolean) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw invalidRequest(`metrics must contain between 1 and ${maximum} items`);
  }
  return value.map((rawMetric, index) => {
    const metric = asRecord(rawMetric);
    const label = readBoundedString(metric.label, `metrics[${index}].label`, 40);
    const rawValue = metric.value;
    if (numeric) {
      if (readFiniteNumber(rawValue) === undefined) {
        throw invalidRequest(`metrics[${index}].value must be a number`);
      }
    } else if (
      !(typeof rawValue === "number" && Number.isFinite(rawValue)) &&
      !(typeof rawValue === "string" && rawValue.trim().length > 0 && rawValue.length <= 64)
    ) {
      throw invalidRequest(`metrics[${index}].value must be a short string or number`);
    }
    const unit = readOptionalBoundedString(metric.unit, `metrics[${index}].unit`, 16);
    const color = parseSurfaceColor(metric.color, `metrics[${index}].color`);
    return { label, value: rawValue, ...(unit ? { unit } : {}), ...(color ? { color } : {}) };
  });
}

function parseSurfaceAdornment(value: unknown, name: string, usesSymbol: boolean) {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  const text = readBoundedString(
    usesSymbol ? record.symbol : record.title,
    `${name}.${usesSymbol ? "symbol" : "title"}`,
    usesSymbol ? 80 : 24,
  );
  if (usesSymbol && !/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u.test(text)) {
    throw invalidRequest("icon.symbol must be an SF Symbol name");
  }
  const color = parseSurfaceColor(record.color, `${name}.color`);
  return { [usesSymbol ? "symbol" : "title"]: text, ...(color ? { color } : {}) };
}

function parseSurfaceColor(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !(SURFACE_COLORS as readonly string[]).includes(value)) {
    throw invalidRequest(`${name} must be one of: ${SURFACE_COLORS.join(", ")}`);
  }
  return value;
}

function parseLiveSurfaceAction(value: unknown): LiveSurfaceAction | undefined {
  if (value === undefined || value === null) return undefined;
  const action = asRecord(value);
  if (action.type !== "open_url") throw invalidRequest("Surface action type must be open_url");
  const title = readBoundedString(action.title, "Action title", 40);
  const url = readBoundedString(action.url, "Action URL", 2_048);
  if (!isHttpUrl(url)) throw invalidRequest("Action URL must use http or https");
  return { type: "open_url", title, url };
}

function parseLiveActivityDirective(value: unknown): LiveActivityDirective | undefined {
  if (value === undefined || value === null) return undefined;
  const directive = asStrictRecord(value, ["sessionId", "state"]);
  const sessionId = parseLiveActivitySessionId(directive.sessionId);
  if (directive.state !== "active" && directive.state !== "ended") {
    throw invalidRequest("liveActivity.state must be active or ended");
  }
  return { sessionId, state: directive.state };
}

function parseLiveActivitySessionId(value: unknown): string {
  const sessionId = readBoundedString(value, "Live Activity session ID", 80);
  if (!/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u.test(sessionId)) {
    throw invalidRequest("Live Activity session ID must be a stable key");
  }
  return sessionId;
}

function readOptionalHexToken(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return readRequiredHexToken(value, name);
}

function readRequiredHexToken(value: unknown, name: string): string {
  const token = readNonEmptyString(value)?.toLowerCase();
  if (!token || !/^[a-f0-9]{32,512}$/u.test(token)) {
    throw invalidRequest(`${name} must be a hexadecimal APNs token`);
  }
  return token;
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function parseEventType(value: unknown): string {
  const eventType = readNonEmptyString(value);
  if (!eventType || !/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u.test(eventType)) {
    throw invalidRequest("A valid eventType is required");
  }
  return eventType;
}

function parseFields(input: unknown): Record<string, EventFieldDefinition> {
  const rawFields = asRecord(input);
  if (Object.keys(rawFields).length === 0) throw invalidRequest("At least one event field is required");
  const fields: Record<string, EventFieldDefinition> = {};
  for (const [fieldName, rawDefinition] of Object.entries(rawFields)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(fieldName)) {
      throw invalidRequest(`Invalid field name: ${fieldName}`);
    }
    const definition = asRecord(rawDefinition);
    const type = definition.type;
    if (!isEventFieldType(type)) throw invalidRequest(`Unsupported type for field ${fieldName}`);
    if (definition.required !== undefined && typeof definition.required !== "boolean") {
      throw invalidRequest(`required must be boolean for field ${fieldName}`);
    }
    if (definition.sensitive !== undefined && typeof definition.sensitive !== "boolean") {
      throw invalidRequest(`sensitive must be boolean for field ${fieldName}`);
    }
    const values = definition.values;
    if (
      type === "enum" &&
      (!Array.isArray(values) || values.length === 0 || values.some((item) => typeof item !== "string" || !item))
    ) {
      throw invalidRequest(`Enum field ${fieldName} requires non-empty string values`);
    }
    fields[fieldName] = {
      type,
      ...(definition.required === true ? { required: true } : {}),
      ...(definition.sensitive === true ? { sensitive: true } : {}),
      ...(type === "enum" ? { values: values as string[] } : {}),
    };
  }
  return fields;
}

function isEventFieldType(value: unknown): value is EventFieldType {
  return typeof value === "string" && (EVENT_FIELD_TYPES as readonly string[]).includes(value);
}

function validateEventData(
  fields: Record<string, EventFieldDefinition>,
  data: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [fieldName, definition] of Object.entries(fields)) {
    const value = data[fieldName];
    if (value === undefined || value === null) {
      if (definition.required) issues.push({ field: fieldName, message: "is required" });
      continue;
    }
    if (!matchesFieldType(definition, value)) {
      issues.push({
        field: fieldName,
        message: definition.type === "enum"
          ? `must be one of: ${definition.values?.join(", ")}`
          : `must be a valid ${definition.type}`,
      });
    }
  }
  const unexpected = Object.keys(data).filter((field) => fields[field] === undefined);
  for (const field of unexpected) issues.push({ field, message: "is not defined in the active schema" });
  return issues;
}

function matchesFieldType(definition: EventFieldDefinition, value: unknown): boolean {
  switch (definition.type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "datetime": return readDateTime(value) !== undefined;
    case "url": return isHttpUrl(value);
    case "enum": return typeof value === "string" && definition.values?.includes(value) === true;
  }
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validateTemplate(
  template: string,
  fields: Record<string, EventFieldDefinition>,
  fieldName: string,
): void {
  if (template.length > 240) throw invalidRequest(`${fieldName} template is too long`);
  const tokenPattern = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)(?:\s*\|\s*default:\s*(['"])(.*?)\2)?\s*\}\}/gu;
  const referenced = [...template.matchAll(tokenPattern)];
  const remainder = template.replace(tokenPattern, "");
  if (remainder.includes("{{") || remainder.includes("}}")) {
    throw invalidRequest(`${fieldName} template contains unsupported syntax`);
  }
  for (const match of referenced) {
    const key = match[1] as string;
    const definition = fields[key];
    if (!definition) throw invalidRequest(`${fieldName} template references unknown field ${key}`);
    if (definition.sensitive) {
      throw invalidRequest(`${fieldName} template cannot display sensitive field ${key}`);
    }
  }
}

function isCanonicalDemoEvent(event: BellwireEvent): boolean {
  return event.eventType === DEMO_EVENT_TYPE && sameJson(event.data, demoEventData);
}

function isCanonicalDemoConfiguration(
  schema: EventSchema | undefined,
  notification: NotificationSurface | undefined,
  liveSurface: LiveSurface | undefined,
): boolean {
  return schema !== undefined
    && sameJson(schema.fields, demoFields)
    && notification !== undefined
    && notification.titleTemplate === demoNotification.title
    && notification.bodyTemplate === demoNotification.body
    && notification.subtitleTemplate === undefined
    && notification.sound === "default"
    && notification.group === "deployment"
    && notification.priority === "normal"
    && notification.enabled
    && isCanonicalDemoStatusSurface(liveSurface);
}

function isCanonicalDemoStatusSurface(liveSurface: LiveSurface | undefined): boolean {
  if (!liveSurface || liveSurface.type !== "stats" || liveSurface.action !== undefined) return false;
  const isCurrent = liveSurface.title === "Production services"
    && liveSurface.subtitle === "All systems operational"
    && sameJson(liveSurface.content, demoSurfaceContent);
  const isLegacy = liveSurface.title === "Bellwire is connected"
    && liveSurface.subtitle === "Live sample data"
    && sameJson(liveSurface.content, legacyDemoSurfaceContent);
  return isCurrent || isLegacy;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
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

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 40);
  return slug || "project";
}

function userProjectSlug(name: string, id: string): string {
  const candidate = `${slugify(name)}-${id.slice(0, 6)}`;
  return candidate === DEMO_PROJECT_SLUG ? `${slugify(name)}-user-${id}` : candidate;
}

function relocatedUserProjectSlug(project: Project): string {
  return `${slugify(project.name)}-user-${project.id}`;
}

function humanizeEventType(value: string): string {
  return value
    .split(/[._-]/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function allAgentScopes(): AgentScope[] {
  return [...AGENT_SCOPES];
}
