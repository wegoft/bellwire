// SPDX-License-Identifier: AGPL-3.0-only
import { betterAuth } from "better-auth";
import { bearer, jwt } from "better-auth/plugins";
import { Hono } from "hono";

import { D1AppleRefreshTokenStore } from "./apple-token-store";
import {
  AppleAuthService,
  AppleTokenClient,
  decryptAppleRefreshToken,
  encryptAppleRefreshToken,
} from "../services/apple-auth-service";

export interface AuthEnv {
  AUTH_DB: D1Database;
  AUTH_ENVIRONMENT: "development" | "staging" | "production";
  AUTH_ISSUER: string;
  AUTH_AUDIENCE: string;
  BETTER_AUTH_SECRET: string;
  AUTH_INTERNAL_SECRET: string;
  APPLE_SIGN_IN_KEY_ID: string;
  APPLE_SIGN_IN_TEAM_ID: string;
  APPLE_SIGN_IN_CLIENT_ID: string;
  APPLE_APP_BUNDLE_ID: string;
  APPLE_SIGN_IN_PRIVATE_KEY: string;
  APPLE_TOKEN_ENCRYPTION_KEY: string;
  APPLE_TOKEN_REWRAP_SECRET?: string;
  CUTOVER_WRITE_FREEZE?: "true" | "false";
}

interface NativeSignInBody {
  identityToken?: unknown;
  nonce?: unknown;
  authorizationCode?: unknown;
  email?: unknown;
  firstName?: unknown;
  lastName?: unknown;
}

interface BetterAuthUser {
  id: string;
  email?: string | null;
}

const SESSION_SECONDS = 60 * 60 * 24 * 30;
const JWT_SECONDS = 60 * 15;
const APPLE_CLIENT_SECRET_CACHE_SECONDS = 60 * 60 * 24 * 30;
let appleClientSecretCache: {
  keyId: string;
  teamId: string;
  clientId: string;
  privateKey: string;
  value: string;
  expiresAt: number;
} | undefined;
const app = new Hono<{ Bindings: AuthEnv }>();

app.get("/", (context) => context.json({
  service: "bellwire-auth",
  issuer: normalizedIssuer(context.env.AUTH_ISSUER),
  audience: context.env.AUTH_AUDIENCE,
  authBasePath: "/api/auth",
  nativeBasePath: "/v1/native",
}));

app.get("/health", async (context) => {
  const row = await context.env.AUTH_DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return context.json({
    ok: row?.ok === 1,
    service: "bellwire-auth",
    issuer: normalizedIssuer(context.env.AUTH_ISSUER),
  });
});

app.post("/v1/native/apple/sign-in", async (context) => {
  const body = await readJson<NativeSignInBody>(context.req.raw);
  const identityToken = nonEmptyString(body.identityToken);
  const nonce = nonEmptyString(body.nonce);
  if (!identityToken || !nonce) {
    return authError(context, 400, "AUTH_INVALID_REQUEST", "Apple identity token and nonce are required.");
  }

  const auth = await createBellwireAuth(context.env);
  const issuer = normalizedIssuer(context.env.AUTH_ISSUER);
  const appleUser = readAppleUser(body);
  const signInResponse = await auth.handler(new Request(`${issuer}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "apple",
      idToken: {
        token: identityToken,
        nonce,
        ...(appleUser ? { user: appleUser } : {}),
      },
    }),
  }));
  if (!signInResponse.ok) return normalizeBetterAuthError(signInResponse);

  const signIn = await signInResponse.json<{ user?: BetterAuthUser }>().catch(() => null);
  const sessionToken = signInResponse.headers.get("set-auth-token");
  if (!sessionToken || !signIn?.user?.id) {
    return authError(context, 502, "AUTH_SESSION_MISSING", "Authentication did not create a session.");
  }

  const authorizationCode = nonEmptyString(body.authorizationCode);
  if (authorizationCode) {
    try {
      await appleAuthService(context.env).saveAuthorizationCode(signIn.user.id, authorizationCode);
    } catch {
      await context.env.AUTH_DB.prepare('DELETE FROM "session" WHERE "token" = ?')
        .bind(sessionDatabaseToken(sessionToken))
        .run();
      return authError(
        context,
        502,
        "APPLE_AUTHORIZATION_EXCHANGE_FAILED",
        "Apple authorization could not be completed. Please try again.",
      );
    }
  }

  return issueNativeSession(auth, issuer, sessionToken, signIn.user);
});

app.post("/v1/native/session/refresh", async (context) => {
  const body = await readJson<{ refreshToken?: unknown }>(context.req.raw);
  const sessionToken = nonEmptyString(body.refreshToken);
  if (!sessionToken) {
    return authError(context, 400, "AUTH_INVALID_REQUEST", "Refresh token is required.");
  }
  const auth = await createBellwireAuth(context.env);
  const issuer = normalizedIssuer(context.env.AUTH_ISSUER);
  const sessionResponse = await auth.handler(new Request(`${issuer}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  }));
  if (!sessionResponse.ok) return normalizeBetterAuthError(sessionResponse);
  const session = await sessionResponse.json<{ user?: BetterAuthUser } | null>().catch(() => null);
  if (!session?.user?.id) {
    return authError(context, 401, "AUTH_SESSION_EXPIRED", "The session has expired.");
  }
  const rolledToken = sessionResponse.headers.get("set-auth-token") ?? sessionToken;
  return issueNativeSession(auth, issuer, rolledToken, session.user);
});

app.post("/v1/native/session/revoke", async (context) => {
  const sessionToken = readBearer(context.req.header("authorization"));
  if (!sessionToken) {
    return authError(context, 401, "AUTH_REQUIRED", "Authentication is required.");
  }
  const auth = await createBellwireAuth(context.env);
  const response = await auth.handler(new Request(
    `${normalizedIssuer(context.env.AUTH_ISSUER)}/api/auth/sign-out`,
    { method: "POST", headers: { authorization: `Bearer ${sessionToken}` } },
  ));
  if (!response.ok) return normalizeBetterAuthError(response);
  return context.body(null, 204);
});

app.delete("/internal/users/:userId", async (context) => {
  if (!await secretsMatch(
    readBearer(context.req.header("authorization")) ?? "",
    context.env.AUTH_INTERNAL_SECRET,
  )) {
    return context.json({ error: "unauthorized" }, 401);
  }
  const userId = context.req.param("userId");
  const tokenStore = new D1AppleRefreshTokenStore(context.env.AUTH_DB);
  if (await tokenStore.getAppleRefreshToken(userId)) {
    await appleAuthService(context.env).revokeForUser(userId);
  }
  await context.env.AUTH_DB.prepare('DELETE FROM "user" WHERE "id" = ?').bind(userId).run();
  return context.body(null, 204);
});

app.post("/internal/migrations/apple-refresh-tokens", async (context) => {
  const migrationSecret = context.env.APPLE_TOKEN_REWRAP_SECRET?.trim();
  if (!migrationSecret) return context.notFound();
  if (!await secretsMatch(
    readBearer(context.req.header("authorization")) ?? "",
    migrationSecret,
  )) {
    return context.json({ error: "unauthorized" }, 401);
  }

  const body = await readJson<{ tokens?: unknown }>(context.req.raw);
  const tokens = parseAppleRefreshTokens(body.tokens);
  if (!tokens) {
    return context.json({ error: "invalid apple refresh token migration payload" }, 400);
  }

  const updatedAt = new Date().toISOString();
  const encrypted = await Promise.all(tokens.map(async (token) => ({
    userId: token.userId,
    refreshToken: token.refreshToken,
    ciphertext: await encryptAppleRefreshToken(
      token.refreshToken,
      context.env.APPLE_TOKEN_ENCRYPTION_KEY,
    ),
  })));
  if (encrypted.length > 0) {
    await context.env.AUTH_DB.batch(encrypted.map((token) => context.env.AUTH_DB.prepare(`
      INSERT INTO apple_auth_tokens (user_id, encrypted_refresh_token, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        encrypted_refresh_token = excluded.encrypted_refresh_token,
        updated_at = excluded.updated_at
    `).bind(token.userId, token.ciphertext, updatedAt)));
  }

  let verified = 0;
  for (const token of encrypted) {
    const row = await context.env.AUTH_DB.prepare(`
      SELECT encrypted_refresh_token FROM apple_auth_tokens WHERE user_id = ?
    `).bind(token.userId).first<{ encrypted_refresh_token: string }>();
    if (!row || await decryptAppleRefreshToken(
      row.encrypted_refresh_token,
      context.env.APPLE_TOKEN_ENCRYPTION_KEY,
    ) !== token.refreshToken) {
      throw new Error("Apple refresh token migration verification failed");
    }
    verified += 1;
  }

  return context.json({ migrated: encrypted.length, verified });
});

app.all("/api/auth/*", async (context) => {
  const auth = await createBellwireAuth(context.env);
  return auth.handler(context.req.raw);
});

export async function createBellwireAuth(env: AuthEnv) {
  requireAuthConfiguration(env);
  const issuer = normalizedIssuer(env.AUTH_ISSUER);
  const appleClientSecret = await appleClientSecretFor(env);

  return betterAuth({
    appName: "Bellwire",
    baseURL: issuer,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.AUTH_DB,
    trustedOrigins: [issuer, "bellwire://"],
    telemetry: { enabled: false },
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: env.AUTH_ENVIRONMENT !== "development",
      cookiePrefix: "bellwire_auth",
    },
    session: {
      expiresIn: SESSION_SECONDS,
      updateAge: 60 * 60 * 24,
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["apple"],
        allowDifferentEmails: false,
      },
    },
    socialProviders: {
      apple: {
        clientId: env.APPLE_SIGN_IN_CLIENT_ID,
        clientSecret: appleClientSecret,
        appBundleIdentifier: env.APPLE_APP_BUNDLE_ID,
      },
    },
    plugins: [
      bearer({ requireSignature: true }),
      jwt({
        disableSettingJwtHeader: true,
        jwks: {
          keyPairConfig: { alg: "ES256" },
          rotationInterval: 60 * 60 * 24 * 30,
          gracePeriod: 60 * 60 * 24 * 7,
        },
        jwt: {
          issuer,
          audience: env.AUTH_AUDIENCE,
          expirationTime: "15m",
          definePayload: ({ user }) => ({
            email: user.email,
            email_verified: user.emailVerified,
          }),
        },
      }),
    ],
  });
}

async function appleClientSecretFor(env: AuthEnv): Promise<string> {
  const cached = appleClientSecretCache;
  if (
    cached
    && cached.expiresAt > Date.now()
    && cached.keyId === env.APPLE_SIGN_IN_KEY_ID
    && cached.teamId === env.APPLE_SIGN_IN_TEAM_ID
    && cached.clientId === env.APPLE_SIGN_IN_CLIENT_ID
    && cached.privateKey === env.APPLE_SIGN_IN_PRIVATE_KEY
  ) return cached.value;
  const value = await new AppleTokenClient({
    keyId: env.APPLE_SIGN_IN_KEY_ID,
    teamId: env.APPLE_SIGN_IN_TEAM_ID,
    clientId: env.APPLE_SIGN_IN_CLIENT_ID,
    privateKey: env.APPLE_SIGN_IN_PRIVATE_KEY,
  }).createClientSecret();
  appleClientSecretCache = {
    keyId: env.APPLE_SIGN_IN_KEY_ID,
    teamId: env.APPLE_SIGN_IN_TEAM_ID,
    clientId: env.APPLE_SIGN_IN_CLIENT_ID,
    privateKey: env.APPLE_SIGN_IN_PRIVATE_KEY,
    value,
    expiresAt: Date.now() + APPLE_CLIENT_SECRET_CACHE_SECONDS * 1_000,
  };
  return value;
}

async function issueNativeSession(
  auth: Awaited<ReturnType<typeof createBellwireAuth>>,
  issuer: string,
  sessionToken: string,
  user: BetterAuthUser,
): Promise<Response> {
  const tokenResponse = await auth.handler(new Request(`${issuer}/api/auth/token`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  }));
  if (!tokenResponse.ok) return normalizeBetterAuthError(tokenResponse);
  const tokenBody = await tokenResponse.json<{ token?: unknown }>().catch(() => null);
  if (typeof tokenBody?.token !== "string") {
    return jsonError(502, "AUTH_JWT_MISSING", "Authentication did not issue an access token.");
  }
  return Response.json({
    accessToken: tokenBody.token,
    refreshToken: sessionToken,
    expiresIn: JWT_SECONDS,
    user: { id: user.id, email: user.email ?? null },
  }, { headers: { "cache-control": "no-store" } });
}

function appleAuthService(env: AuthEnv): AppleAuthService {
  return new AppleAuthService(
    new D1AppleRefreshTokenStore(env.AUTH_DB),
    new AppleTokenClient({
      keyId: env.APPLE_SIGN_IN_KEY_ID,
      teamId: env.APPLE_SIGN_IN_TEAM_ID,
      clientId: env.APPLE_SIGN_IN_CLIENT_ID,
      privateKey: env.APPLE_SIGN_IN_PRIVATE_KEY,
    }),
    env.APPLE_TOKEN_ENCRYPTION_KEY,
  );
}

function requireAuthConfiguration(env: AuthEnv): void {
  const required: Array<[string, string | undefined, number]> = [
    ["AUTH_ISSUER", env.AUTH_ISSUER, 8],
    ["AUTH_AUDIENCE", env.AUTH_AUDIENCE, 3],
    ["BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET, 32],
    ["AUTH_INTERNAL_SECRET", env.AUTH_INTERNAL_SECRET, 32],
    ["APPLE_SIGN_IN_KEY_ID", env.APPLE_SIGN_IN_KEY_ID, 3],
    ["APPLE_SIGN_IN_TEAM_ID", env.APPLE_SIGN_IN_TEAM_ID, 10],
    ["APPLE_SIGN_IN_CLIENT_ID", env.APPLE_SIGN_IN_CLIENT_ID, 3],
    ["APPLE_APP_BUNDLE_ID", env.APPLE_APP_BUNDLE_ID, 3],
    ["APPLE_SIGN_IN_PRIVATE_KEY", env.APPLE_SIGN_IN_PRIVATE_KEY, 64],
    ["APPLE_TOKEN_ENCRYPTION_KEY", env.APPLE_TOKEN_ENCRYPTION_KEY, 32],
  ];
  for (const [name, value, minimum] of required) {
    if (!value || value.length < minimum) throw new Error(`${name} is missing or invalid`);
  }
}

function normalizedIssuer(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AUTH_ISSUER must be an origin without a path, query, or fragment");
  }
  return url.origin;
}

function readAppleUser(body: NativeSignInBody) {
  const email = nonEmptyString(body.email);
  const firstName = nonEmptyString(body.firstName);
  const lastName = nonEmptyString(body.lastName);
  if (!email && !firstName && !lastName) return undefined;
  return {
    ...(email ? { email } : {}),
    ...((firstName || lastName) ? { name: { firstName, lastName } } : {}),
  };
}

async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return {} as T;
  return request.json<T>().catch(() => ({} as T));
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseAppleRefreshTokens(value: unknown): Array<{
  userId: string;
  refreshToken: string;
}> | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const tokens: Array<{ userId: string; refreshToken: string }> = [];
  const userIds = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return undefined;
    const record = candidate as Record<string, unknown>;
    const userId = nonEmptyString(record.userId);
    const refreshToken = nonEmptyString(record.refreshToken);
    if (
      !userId || userId.length > 256
      || !refreshToken || refreshToken.length > 16_384
      || userIds.has(userId)
    ) return undefined;
    userIds.add(userId);
    tokens.push({ userId, refreshToken });
  }
  return tokens;
}

function readBearer(value: string | undefined): string | undefined {
  if (!value?.toLowerCase().startsWith("bearer ")) return undefined;
  return nonEmptyString(value.slice(7));
}

function sessionDatabaseToken(value: string): string {
  try {
    return decodeURIComponent(value).split(".")[0] ?? value;
  } catch {
    return value.split(".")[0] ?? value;
  }
}

async function secretsMatch(left: string, right: string): Promise<boolean> {
  if (!left || !right) return false;
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function normalizeBetterAuthError(response: Response): Promise<Response> {
  const body = await response.json<{ code?: unknown; message?: unknown }>().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "AUTH_FAILED";
  const message = typeof body?.message === "string" ? body.message : "Authentication failed.";
  return jsonError(response.status >= 400 && response.status < 600 ? response.status : 401, code, message);
}

function authError(
  context: { json: (body: object, status: 400 | 401 | 502) => Response },
  status: 400 | 401 | 502,
  code: string,
  message: string,
): Response {
  return context.json({ error: { code, message } }, status);
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export default {
  async fetch(request: Request, env: AuthEnv, executionContext: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const freezeAllowed = request.method === "GET" && (
      url.pathname === "/health" || url.pathname === "/api/auth/jwks"
    ) || (
      request.method === "POST"
      && url.pathname === "/internal/migrations/apple-refresh-tokens"
    );
    const response = env.CUTOVER_WRITE_FREEZE === "true" && !freezeAllowed
      ? Response.json({
        error: {
          code: "CUTOVER_WRITE_FREEZE",
          message: "Bellwire authentication is completing a scheduled storage migration.",
        },
      }, {
        status: 503,
        headers: { "retry-after": "120" },
      })
      : await app.fetch(request, env, executionContext);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (env.AUTH_ENVIRONMENT !== "development") {
      headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<AuthEnv>;
