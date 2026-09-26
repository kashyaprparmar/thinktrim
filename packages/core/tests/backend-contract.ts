import { describe, expect, it } from "vitest";
import type { BackendPrediction, DecisionBackend, DecisionKind } from "../src/index.js";
import { predictions, requests } from "./fixtures.js";

/** Reuse this suite with each backend's deterministic test transport. */
export function runBackendContract(
  name: string,
  create: (prediction: BackendPrediction) => DecisionBackend,
): void {
  describe(`${name} DecisionBackend contract`, () => {
    const kinds: DecisionKind[] = ["binary", "choice", "score", "ranking"];

    it.each(kinds)("predicts a typed %s decision", async (kind) => {
      const backend = create(predictions[kind]);
      expect(backend.capabilities.kinds).toContain(kind);
      expect(backend.capabilities.schemaVersion).toBe(requests[kind].schemaVersion);
      expect(await backend.health()).toBe("healthy");

      const result = await backend.predict(requests[kind]);
      expect(result.value.kind).toBe(kind);
    });

    it("honors a pre-aborted signal when cancellation is advertised", async () => {
      const backend = create(predictions.binary);
      if (!backend.capabilities.supportsCancellation) {
        return;
      }
      const controller = new AbortController();
      controller.abort();
      await expect(backend.predict(requests.binary, controller.signal)).rejects.toThrow();
    });
  });
}
