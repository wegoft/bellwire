// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { Principal } from "../src/domain/models";
import { InMemoryBellwireRepository } from "../src/repositories/in-memory-bellwire-repository";
import { SupabaseRequestError } from "../src/repositories/supabase-bellwire-repository";
import { BellwireService } from "../src/services/bellwire-service";

const user: Principal = {
  kind: "user",
  userId: "11111111-1111-4111-8111-111111111111",
  scopes: ["project:read", "project:write", "config:read", "config:write", "event:test"],
};

describe("repository error mapping", () => {
  it("maps a Supabase readiness error body to the recoverable service error", async () => {
    const repository = new InMemoryBellwireRepository();
    repository.resolveDeliveryModeChangeRequest = async () => {
      throw new SupabaseRequestError(400, {
        code: "P0001",
        details: null,
        hint: null,
        message: "PRIVATE_READINESS_REQUIRED",
      });
    };
    const service = new BellwireService(repository);

    await expect(service.resolveDeliveryModeChangeRequest(
      user,
      "22222222-2222-4222-8222-222222222222",
      true,
    )).rejects.toMatchObject({
      status: 409,
      code: "PRIVATE_READINESS_REQUIRED",
    });
  });
});
