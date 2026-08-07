// SPDX-License-Identifier: AGPL-3.0-only

export interface AccountIdentityService {
  deleteUser(userId: string): Promise<void>;
}

export class AuthAdminClient implements AccountIdentityService {
  constructor(
    private readonly issuer: string,
    private readonly internalSecret: string,
    private readonly service?: Fetcher,
  ) {}

  async deleteUser(userId: string): Promise<void> {
    const request = new Request(
      new URL(`/internal/users/${encodeURIComponent(userId)}`, this.issuer),
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.internalSecret}` },
      },
    );
    const response = this.service ? await this.service.fetch(request) : await fetch(request);
    if (!response.ok) {
      throw new Error(`Auth user deletion failed with status ${response.status}`);
    }
  }
}
