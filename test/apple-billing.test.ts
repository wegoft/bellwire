// SPDX-License-Identifier: AGPL-3.0-only
import { Environment, Status } from "@apple/app-store-server-library";
import { describe, expect, it, vi } from "vitest";

import type { Principal } from "../src/domain/models";
import { InMemoryBellwireRepository } from "../src/repositories/in-memory-bellwire-repository";
import {
  AppleBillingService,
  type AppleBillingVerifier,
} from "../src/services/apple-billing-service";

const userId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-07-25T10:00:00.000Z");
const signedValue = "signed.".padEnd(120, "x");
const principal: Principal = {
  kind: "user",
  userId,
  scopes: [],
};

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "transaction-1",
    originalTransactionId: "original-1",
    appAccountToken: userId,
    productId: "app.bellwire.pro.yearly",
    environment: Environment.SANDBOX,
    purchaseDate: Date.parse("2026-07-24T10:00:00Z"),
    expiresDate: Date.parse("2027-07-24T10:00:00Z"),
    signedDate: Date.parse("2026-07-25T09:00:00Z"),
    ...overrides,
  };
}

function verifier(overrides: Partial<AppleBillingVerifier> = {}): AppleBillingVerifier {
  return {
    verifyTransaction: vi.fn().mockResolvedValue(transaction()),
    verifyNotification: vi.fn().mockResolvedValue({
      notificationUUID: "22222222-2222-4222-8222-222222222222",
      notificationType: "DID_RENEW",
      signedDate: Date.parse("2026-07-25T09:00:00Z"),
      data: {
        status: Status.ACTIVE,
        signedTransactionInfo: signedValue,
      },
    }),
    ...overrides,
  };
}

describe("Apple billing verification", () => {
  it("makes a verified matching StoreKit transaction authoritative for Pro", async () => {
    const repository = new InMemoryBellwireRepository();
    const service = new AppleBillingService(repository, verifier(), () => now);

    const entitlement = await service.submitTransaction(principal, signedValue);

    expect(entitlement).toMatchObject({
      plan: "pro",
      status: "active",
      productId: "app.bellwire.pro.yearly",
      limits: { monthlySignals: 50_000, activeProjects: 20, surfacesPerProject: null },
    });
  });

  it("records purchase intent once but never treats background entitlement sync as a purchase", async () => {
    const repository = new InMemoryBellwireRepository();
    const analytics = { capture: vi.fn().mockResolvedValue(undefined) };
    const trialVerifier = verifier({
      verifyTransaction: vi.fn().mockResolvedValue(transaction({ offerType: 1 })),
    });
    const service = new AppleBillingService(repository, trialVerifier, () => now, analytics);

    await service.submitTransaction(principal, signedValue, "sync");
    expect(analytics.capture).not.toHaveBeenCalled();

    await service.submitTransaction(principal, signedValue, "purchase");
    expect(analytics.capture).toHaveBeenLastCalledWith(
      userId,
      "trial_started",
      expect.objectContaining({ source: "purchase" }),
    );

    await service.submitTransaction(principal, signedValue, "restore");
    expect(analytics.capture).toHaveBeenLastCalledWith(
      userId,
      "subscription_restored",
      expect.objectContaining({ source: "restore" }),
    );
    expect(analytics.capture).toHaveBeenCalledTimes(2);
  });

  it("rejects another account token and an unknown product", async () => {
    const repository = new InMemoryBellwireRepository();
    const wrongAccount = verifier({
      verifyTransaction: vi.fn().mockResolvedValue(transaction({
        appAccountToken: "33333333-3333-4333-8333-333333333333",
      })),
    });
    await expect(
      new AppleBillingService(repository, wrongAccount, () => now)
        .submitTransaction(principal, signedValue),
    ).rejects.toThrow("does not match");

    const wrongProduct = verifier({
      verifyTransaction: vi.fn().mockResolvedValue(transaction({ productId: "other.product" })),
    });
    await expect(
      new AppleBillingService(repository, wrongProduct, () => now)
        .submitTransaction(principal, signedValue),
    ).rejects.toThrow("not a Bellwire Pro plan");
  });

  it("verifies notification transaction data before consuming its deduplication receipt", async () => {
    const repository = new InMemoryBellwireRepository();
    const failingVerifier = verifier({
      verifyTransaction: vi.fn().mockRejectedValue(new Error("invalid nested JWS")),
    });
    const firstService = new AppleBillingService(repository, failingVerifier, () => now);
    await expect(firstService.processNotification(signedValue)).rejects.toThrow("invalid nested JWS");

    const validVerifier = verifier();
    const retryService = new AppleBillingService(repository, validVerifier, () => now);
    await expect(retryService.processNotification(signedValue)).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    await expect(retryService.processNotification(signedValue)).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(await repository.getAccountEntitlement(userId, now.toISOString()))
      .toMatchObject({ plan: "pro", status: "active" });
  });

  it("does not consume the notification receipt before its transaction is durable", async () => {
    const repository = new InMemoryBellwireRepository();
    const save = vi.spyOn(repository, "saveAppleTransaction");
    save.mockRejectedValueOnce(new Error("database unavailable"));
    const service = new AppleBillingService(repository, verifier(), () => now);

    await expect(service.processNotification(signedValue)).rejects.toThrow("database unavailable");
    await expect(service.processNotification(signedValue)).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(await repository.getAccountEntitlement(userId, now.toISOString()))
      .toMatchObject({ plan: "pro", status: "active" });
  });

  it("maps billing retry notifications to grace without trusting the client", async () => {
    const repository = new InMemoryBellwireRepository();
    const graceVerifier = verifier({
      verifyNotification: vi.fn().mockResolvedValue({
        notificationUUID: "44444444-4444-4444-8444-444444444444",
        notificationType: "DID_FAIL_TO_RENEW",
        signedDate: Date.parse("2026-07-25T09:30:00Z"),
        data: {
          status: Status.BILLING_GRACE_PERIOD,
          signedTransactionInfo: signedValue,
        },
      }),
    });
    await new AppleBillingService(repository, graceVerifier, () => now)
      .processNotification(signedValue);
    expect(await repository.getAccountEntitlement(userId, now.toISOString()))
      .toMatchObject({ plan: "pro", status: "grace" });
  });

  it("does not let an older transaction from another subscription chain replace newer entitlement", async () => {
    const repository = new InMemoryBellwireRepository();
    const newer = verifier({
      verifyTransaction: vi.fn().mockResolvedValue(transaction({
        transactionId: "transaction-new",
        originalTransactionId: "chain-new",
        signedDate: Date.parse("2026-07-25T09:45:00Z"),
      })),
    });
    await new AppleBillingService(repository, newer, () => now)
      .submitTransaction(principal, signedValue);

    const olderRevoked = verifier({
      verifyTransaction: vi.fn().mockResolvedValue(transaction({
        transactionId: "transaction-old",
        originalTransactionId: "chain-old",
        signedDate: Date.parse("2026-07-24T09:45:00Z"),
        revocationDate: Date.parse("2026-07-24T09:46:00Z"),
      })),
    });
    await new AppleBillingService(repository, olderRevoked, () => now)
      .submitTransaction(principal, signedValue);

    expect(await repository.getAccountEntitlement(userId, now.toISOString()))
      .toMatchObject({ plan: "pro", status: "active" });
  });
});
