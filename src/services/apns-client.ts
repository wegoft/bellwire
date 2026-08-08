// SPDX-License-Identifier: AGPL-3.0-only

export interface ApnsConfiguration {
  bundleId: string;
  urlScheme: string;
  appName: string;
  environment: "sandbox" | "production";
}

export interface ApnsProviderToken {
  value: string;
  expiresAt: number;
  generation: string;
}

export interface ApnsProviderTokenSource {
  getProviderToken(): Promise<ApnsProviderToken>;
  invalidateProviderToken(generation: string): Promise<void>;
}

export interface ApnsNotification {
  title?: string;
  body?: string;
  subtitle?: string;
  sound?: string;
  threadId: string;
  priority: "normal" | "high";
  signalId: string;
  projectId: string;
  logoUrl?: string;
  deliveryMode: "private" | "hosted";
  eventId?: string;
  wakeId?: string;
  reference?: string;
  modeRequest?: {
    id: string;
    toMode: "private" | "hosted";
  };
}

export interface ApnsResult {
  providerMessageId?: string;
}

export interface ApnsLiveActivityNotification {
  event: "start" | "update" | "end";
  timestamp: number;
  contentState: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  priority: 5 | 10;
  collapseId: string;
  dismissalDate?: number;
}

export class ApnsError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly retryable: boolean,
  ) {
    super(`APNs returned ${status}: ${reason}`);
    this.name = "ApnsError";
  }
}

export class ApnsClient {
  constructor(
    private readonly config: ApnsConfiguration,
    private readonly providerTokens: ApnsProviderTokenSource,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async send(deviceToken: string, notification: ApnsNotification): Promise<ApnsResult> {
    const host = this.config.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
    const providerToken = await this.providerTokens.getProviderToken();
    const response = await this.fetchImpl(`${host}/3/device/${encodeURIComponent(deviceToken)}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${providerToken.value}`,
        "apns-topic": this.config.bundleId,
        "apns-push-type": "alert",
        "apns-priority": notification.priority === "high" ? "10" : "5",
        "apns-collapse-id": notification.signalId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aps: {
          alert: notification.modeRequest
            ? {
                title: notification.title ?? "Approval needed",
                body: notification.body ?? `Open ${this.config.appName} to review this request.`,
                ...(notification.subtitle ? { subtitle: notification.subtitle } : {}),
              }
            : notification.deliveryMode === "hosted"
            ? {
                title: notification.title ?? this.config.appName,
                body: notification.body ?? "",
                ...(notification.subtitle ? { subtitle: notification.subtitle } : {}),
              }
            : {
                title: this.config.appName,
                "loc-key": "BELLWIRE_PRIVATE_NOTIFICATION_BODY",
                "loc-args": [this.config.appName],
              },
          sound: notification.sound ?? "default",
          "thread-id": notification.threadId,
          ...(notification.logoUrl || notification.deliveryMode === "private"
            ? { "mutable-content": 1 }
            : {}),
        },
        projectId: notification.projectId,
        bellwireDeliveryMode: notification.deliveryMode,
        protocolVersion: 2,
        ...(notification.modeRequest
          ? {
              bellwireControlAction: "mode_request",
              modeRequestId: notification.modeRequest.id,
              requestedDeliveryMode: notification.modeRequest.toMode,
              deepLink: `${this.config.urlScheme}://settings/mode-requests`,
            }
          : {}),
        ...(notification.deliveryMode === "hosted" && notification.eventId
          ? {
              eventId: notification.eventId,
              deepLink: `${this.config.urlScheme}://events/${notification.eventId}`,
              ...(notification.logoUrl ? { projectLogoUrl: notification.logoUrl } : {}),
            }
          : {}),
        ...(notification.deliveryMode === "private" && notification.reference
          ? {
              privateWakeRef: notification.reference,
              deepLink: `${this.config.urlScheme}://private/${notification.projectId}/${notification.reference}`,
            }
          : {}),
      }),
    });
    if (!response.ok) {
      const error: { reason?: string } = await response
        .json<{ reason?: string }>()
        .catch(() => ({}));
      const reason = error.reason ?? "UnknownApnsError";
      if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") {
        await this.providerTokens.invalidateProviderToken(providerToken.generation)
          .catch(() => undefined);
      }
      throw new ApnsError(response.status, reason, isRetryable(response.status, reason));
    }
    return { providerMessageId: response.headers.get("apns-id") ?? undefined };
  }

  async sendLiveActivity(
    token: string,
    notification: ApnsLiveActivityNotification,
  ): Promise<ApnsResult> {
    const host = this.config.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
    const providerToken = await this.providerTokens.getProviderToken();
    const response = await this.fetchImpl(`${host}/3/device/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${providerToken.value}`,
        "apns-topic": `${this.config.bundleId}.push-type.liveactivity`,
        "apns-push-type": "liveactivity",
        "apns-priority": String(notification.priority),
        "apns-collapse-id": notification.collapseId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aps: {
          timestamp: notification.timestamp,
          event: notification.event,
          "content-state": notification.contentState,
          ...(notification.event === "start"
            ? {
                "attributes-type": "BellwireActivityAttributes",
                attributes: notification.attributes,
              }
            : {}),
          ...(notification.dismissalDate === undefined
            ? {}
            : { "dismissal-date": notification.dismissalDate }),
        },
      }),
    });
    if (!response.ok) {
      const error: { reason?: string } = await response
        .json<{ reason?: string }>()
        .catch(() => ({}));
      const reason = error.reason ?? "UnknownApnsError";
      if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") {
        await this.providerTokens.invalidateProviderToken(providerToken.generation)
          .catch(() => undefined);
      }
      throw new ApnsError(response.status, reason, isRetryable(response.status, reason));
    }
    return { providerMessageId: response.headers.get("apns-id") ?? undefined };
  }
}

export class ApnsClientPool {
  private readonly clients = new Map<
    ApnsConfiguration["environment"],
    { config: ApnsConfiguration; client: ApnsClient }
  >();

  constructor(
    private readonly createClient: (
      config: ApnsConfiguration,
      providerTokens: ApnsProviderTokenSource,
    ) => ApnsClient = (config, providerTokens) => new ApnsClient(config, providerTokens),
  ) {}

  get(config: ApnsConfiguration, providerTokens: ApnsProviderTokenSource): ApnsClient {
    const cached = this.clients.get(config.environment);
    if (cached && sameConfiguration(cached.config, config)) return cached.client;

    const savedConfig = { ...config };
    const client = this.createClient(savedConfig, providerTokens);
    this.clients.set(config.environment, { config: savedConfig, client });
    return client;
  }
}

function sameConfiguration(left: ApnsConfiguration, right: ApnsConfiguration): boolean {
  return left.bundleId === right.bundleId &&
    left.urlScheme === right.urlScheme &&
    left.appName === right.appName &&
    left.environment === right.environment;
}

function isRetryable(status: number, reason: string): boolean {
  return status === 429 ||
    status >= 500 ||
    reason === "ExpiredProviderToken" ||
    reason === "InvalidProviderToken";
}
