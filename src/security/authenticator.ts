// SPDX-License-Identifier: AGPL-3.0-only
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

import { AGENT_SCOPES, type Principal } from "../domain/models";
import type { BellwireRepository } from "../repositories/bellwire-repository";
import { hashSecret, readBearerToken } from "./tokens";

const remoteJwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export class AuthenticationError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "UNAUTHORIZED" | "FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<Principal>;
}

export class PrincipalAuthenticator implements Authenticator {
  private readonly issuer?: string;
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly repository: BellwireRepository,
    options: {
      issuer?: string;
      audience?: string;
      allowDevelopmentTokens?: boolean;
      authService?: Fetcher;
    },
  ) {
    this.allowDevelopmentTokens = options.allowDevelopmentTokens === true;
    this.audience = options.audience;
    if (options.issuer) {
      this.issuer = options.issuer.replace(/\/$/u, "");
      this.jwks = remoteJwksForIssuer(this.issuer, options.authService);
    }
  }

  private readonly allowDevelopmentTokens: boolean;
  private readonly audience?: string;

  async authenticate(authorization: string | undefined): Promise<Principal> {
    const token = readBearerToken(authorization);
    if (!token) throw unauthorized();

    if (token.startsWith("bw_agent_")) {
      const stored = await this.repository.findAgentTokenByHash(await hashSecret(token));
      if (!stored) throw unauthorized();
      await this.repository.markAgentTokenUsed(stored.id, new Date().toISOString());
      return {
        kind: "agent",
        userId: stored.userId,
        tokenId: stored.id,
        scopes: stored.scopes,
      };
    }

    if (this.allowDevelopmentTokens && token.startsWith("bw_dev_")) {
      const userId = token.slice("bw_dev_".length).trim();
      if (!userId) throw unauthorized();
      return { kind: "user", userId, scopes: [...AGENT_SCOPES] };
    }

    if (!this.jwks || !this.issuer) throw unauthorized();
    try {
      const verified = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      const userId = verified.payload.sub;
      if (!userId) throw unauthorized();
      return { kind: "user", userId, scopes: [...AGENT_SCOPES] };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw unauthorized();
    }
  }
}

function remoteJwksForIssuer(
  issuer: string,
  authService?: Fetcher,
): ReturnType<typeof createRemoteJWKSet> {
  const cacheKey = `${issuer}:${authService ? "service" : "public"}`;
  const existing = remoteJwksByIssuer.get(cacheKey);
  if (existing) return existing;
  const created = createRemoteJWKSet(
    new URL(`${issuer}/api/auth/jwks`),
    authService ? {
      [customFetch]: (url, options) => authService.fetch(new Request(url, options)),
    } : undefined,
  );
  remoteJwksByIssuer.set(cacheKey, created);
  return created;
}

export class StaticAuthenticator implements Authenticator {
  constructor(private readonly principal: Principal) {}

  async authenticate(): Promise<Principal> {
    return structuredClone(this.principal);
  }
}

export function requireScope(principal: Principal, scope: Principal["scopes"][number]): void {
  if (principal.kind === "agent" && !principal.scopes.includes(scope)) {
    throw new AuthenticationError(403, "FORBIDDEN", `Missing required scope: ${scope}`);
  }
}

function unauthorized(): AuthenticationError {
  return new AuthenticationError(401, "UNAUTHORIZED", "Authentication is required");
}
