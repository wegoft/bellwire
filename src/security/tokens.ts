// SPDX-License-Identifier: AGPL-3.0-only
export type TokenKind = "agent" | "ingest" | "wake";

export function createOpaqueToken(kind: TokenKind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  const prefix = kind === "agent"
    ? "bw_agent"
    : kind === "wake"
      ? "bw_wake"
      : "bw_live";
  return `${prefix}_${encoded}`;
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function createPairingCode(): string {
  const modulus = 1_000_000;
  const unbiasedUpperBound = Math.floor(2 ** 32 / modulus) * modulus;
  const bytes = new Uint32Array(1);
  do {
    crypto.getRandomValues(bytes);
  } while ((bytes[0] ?? 0) >= unbiasedUpperBound);
  return String((bytes[0] ?? 0) % modulus).padStart(6, "0");
}

export function readBearerToken(value: string | undefined): string | undefined {
  return value?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
}
