import { expect, it } from "vitest";
import { RetryPolicy } from "../src/retry-policy.js";

it("does not retry a write unless the failed attempt used the same idempotency key", async () => {
  const policy = new RetryPolicy();
  const input = {
    failureCategory: "network_error",
    attempt: 1,
    operationType: "write",
    idempotency: "idempotency_key",
    idempotencyKey: "request-123",
    sideEffectRisk: "medium",
  } as const;
  expect(await policy.evaluate(input)).toMatchObject({
    action: "stop",
    automatic: false,
    reasonCode: "previous_attempt_key_unverified",
  });
  expect(
    await policy.evaluate({
      ...input,
      previousResult: { status: "failed", idempotencyKey: "other" },
    }),
  ).toMatchObject({ action: "stop", reasonCode: "idempotency_key_changed" });
  expect(
    await policy.evaluate({
      ...input,
      previousResult: { status: "failed", idempotencyKey: "request-123" },
    }),
  ).toMatchObject({ action: "retry", automatic: true });
});
