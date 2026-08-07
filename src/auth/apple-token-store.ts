// SPDX-License-Identifier: AGPL-3.0-only
import type { AppleRefreshTokenStore } from "../services/apple-auth-service";

export class D1AppleRefreshTokenStore implements AppleRefreshTokenStore {
  constructor(private readonly database: D1Database) {}

  async saveAppleRefreshToken(userId: string, encryptedRefreshToken: string): Promise<void> {
    await this.database.prepare(`
      INSERT INTO apple_auth_tokens (user_id, encrypted_refresh_token, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        encrypted_refresh_token = excluded.encrypted_refresh_token,
        updated_at = excluded.updated_at
    `).bind(userId, encryptedRefreshToken, new Date().toISOString()).run();
  }

  async getAppleRefreshToken(userId: string): Promise<string | undefined> {
    const row = await this.database.prepare(`
      SELECT encrypted_refresh_token FROM apple_auth_tokens WHERE user_id = ?
    `).bind(userId).first<{ encrypted_refresh_token: string }>();
    return row?.encrypted_refresh_token;
  }

  async deleteAppleRefreshToken(userId: string): Promise<void> {
    await this.database.prepare("DELETE FROM apple_auth_tokens WHERE user_id = ?")
      .bind(userId)
      .run();
  }
}
