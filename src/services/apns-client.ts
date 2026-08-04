// SPDX-License-Identifier: AGPL-3.0-only
import { importPKCS8, SignJWT } from "jose";

export interface ApnsConfiguration {
  keyId: string;
  teamId: string;
  bundleId: string;
  urlScheme: string;
  privateKey: string;
  environment: "sandbox" | "production";
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
  private signingKey?: CryptoKey;
  private providerToken?: { value: string; expiresAt: number };
  private providerTokenPromise?: Promise<{ value: string; expiresAt: number }>;

  constructor(
    private readonly config: ApnsConfiguration,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async send(deviceToken: string, notification: ApnsNotification): Promise<ApnsResult> {
    const host = this.config.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
    const providerToken = await this.getProviderToken();
    const response = await this.fetchImpl(`${host}/3/device/${encodeURIComponent(deviceToken)}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${providerToken}`,
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
                body: notification.body ?? "Open Bellwire to review this request.",
                ...(notification.subtitle ? { subtitle: notification.subtitle } : {}),
              }
            : notification.deliveryMode === "hosted"
            ? {
                title: notification.title ?? "Bellwire",
                body: notification.body ?? "",
                ...(notification.subtitle ? { subtitle: notification.subtitle } : {}),
              }
            : {
                title: "Bellwire",
                "loc-key": "BELLWIRE_PRIVATE_NOTIFICATION_BODY",
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
        if (this.providerToken?.value === providerToken) this.providerToken = undefined;
      }
      throw new ApnsError(response.status, reason, isRetryable(response.status, reason));
    }
    return { providerMessageId: response.headers.get("apns-id") ?? undefined };
  }

  private async getProviderToken(): Promise<string> {
    const now = Date.now();
    if (this.providerToken && this.providerToken.expiresAt > now) return this.providerToken.value;
    if (this.providerTokenPromise) return (await this.providerTokenPromise).value;

    const pending = this.createProviderToken(now);
    this.providerTokenPromise = pending;
    try {
      const providerToken = await pending;
      this.providerToken = providerToken;
      return providerToken.value;
    } finally {
      if (this.providerTokenPromise === pending) this.providerTokenPromise = undefined;
    }
  }

  private async createProviderToken(now: number): Promise<{ value: string; expiresAt: number }> {
    this.signingKey ??= await importPKCS8(normalizePrivateKey(this.config.privateKey), "ES256");
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt()
      .sign(this.signingKey);
    return { value, expiresAt: now + 50 * 60 * 1_000 };
  }
}

export class ApnsClientPool {
  private readonly clients = new Map<
    ApnsConfiguration["environment"],
    { config: ApnsConfiguration; client: ApnsClient }
  >();

  constructor(
    private readonly createClient: (config: ApnsConfiguration) => ApnsClient =
      (config) => new ApnsClient(config),
  ) {}

  get(config: ApnsConfiguration): ApnsClient {
    const cached = this.clients.get(config.environment);
    if (cached && sameConfiguration(cached.config, config)) return cached.client;

    const savedConfig = { ...config };
    const client = this.createClient(savedConfig);
    this.clients.set(config.environment, { config: savedConfig, client });
    return client;
  }
}

function sameConfiguration(left: ApnsConfiguration, right: ApnsConfiguration): boolean {
  return left.keyId === right.keyId &&
    left.teamId === right.teamId &&
    left.bundleId === right.bundleId &&
    left.urlScheme === right.urlScheme &&
    left.privateKey === right.privateKey &&
    left.environment === right.environment;
}

function normalizePrivateKey(value: string): string {
  return value.replaceAll("\\n", "\n").trim();
}

function isRetryable(status: number, reason: string): boolean {
  return status === 429 || status >= 500 || reason === "ExpiredProviderToken";
}
