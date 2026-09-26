import { describe, expect, it } from "vitest";
import { CoreDecisionEngine, FakeBackend, createCandidateId } from "../src/index.js";
import type {
  ConfidenceAssessment,
  ConfidencePolicy,
  DecisionOutcome,
  DecisionPolicy,
  DecisionRequest,
  DecisionValue,
} from "../src/index.js";
import { candidateA, candidateB, predictions, requests } from "./fixtures.js";

const noExactPolicy: DecisionPolicy = {
  resolveExactly: () => undefined,
  validate: () => undefined,
  risk: () => "low",
};

function assessment(outcome: DecisionOutcome = "accept"): ConfidenceAssessment {
  return {
    outcome,
    confidence: outcome === "accept" ? 0.9 : null,
    calibrated: outcome === "accept",
    reasonCode: `test_${outcome}`,
  };
}

function engine(
  backends: readonly FakeBackend[],
  confidence: ConfidencePolicy = { assess: () => assessment() },
  policy: DecisionPolicy = noExactPolicy,
): CoreDecisionEngine {
  return new CoreDecisionEngine({
    backends,
    decisionPolicy: policy,
    confidencePolicy: confidence,
    createTraceId: () => "trace-1",
  });
}

describe("CoreDecisionEngine", () => {
  it.each(["binary", "choice", "score", "ranking"] as const)(
    "accepts validated %s predictions with metadata and a redacted trace",
    async (kind) => {
      const backend = new FakeBackend();
      backend.enqueue({
        ...predictions[kind],
        usage: { unit: "tokens", inputUnits: 4, outputUnits: 1 },
        metadata: { internal: "not copied to the trace" },
      });
      const result = await engine([backend]).decide(requests[kind]);

      expect(result.outcome).toBe("accept");
      expect(result.value?.kind).toBe(kind);
      expect(result.backend).toEqual({ id: "fake", modelVersion: "test", locality: "local" });
      expect(result.usage).toEqual({ unit: "tokens", inputUnits: 4, outputUnits: 1 });
      expect(result.confidence).toBe(0.9);
      expect(result.calibrated).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.trace.traceId).toBe("trace-1");
      expect(JSON.stringify(result.trace)).not.toContain("not copied to the trace");
      expect(backend.calls).toHaveLength(1);
    },
  );

  it.each(["accept", "reject", "retrieve_more", "escalate", "unknown"] as const)(
    "preserves a policy's %s outcome",
    async (outcome) => {
      const backend = new FakeBackend();
      backend.enqueue(predictions.binary);
      const confidence: ConfidencePolicy = { assess: () => assessment(outcome) };
      const result = await engine([backend], confidence).decide(requests.binary);
      expect(result.outcome).toBe(outcome);
      expect(result.trace.outcome).toBe(outcome);
    },
  );

  it("uses an exact policy before consulting a backend", async () => {
    const backend = new FakeBackend();
    const exactPolicy: DecisionPolicy = {
      ...noExactPolicy,
      resolveExactly: <K extends DecisionRequest["kind"]>(): DecisionValue<K> =>
        ({ kind: "binary", value: false }) as DecisionValue<K>,
    };
    const confidence: ConfidencePolicy = {
      assess: () => ({
        outcome: "reject",
        confidence: null,
        calibrated: false,
        reasonCode: "exact",
      }),
    };
    const result = await engine([backend], confidence, exactPolicy).decide(requests.binary);
    expect(result.outcome).toBe("reject");
    expect(result.provenance).toBe("deterministic");
    expect(result.confidence).toBeNull();
    expect(backend.healthCalls).toBe(0);
    expect(backend.calls).toHaveLength(0);
  });

  it("rejects duplicate candidate IDs before a backend call", async () => {
    const backend = new FakeBackend();
    const request: DecisionRequest<"ranking"> = {
      ...requests.ranking,
      candidates: [candidateA, { ...candidateB, id: candidateA.id }],
    };
    const result = await engine([backend]).decide(request);
    expect(result.outcome).toBe("unknown");
    expect(result.error).toMatchObject({ code: "invalid_request", field: "candidates[1].id" });
    expect(backend.calls).toHaveLength(0);
  });

  it("rejects undeclared request fields before any remote call", async () => {
    const backend = new FakeBackend({ capabilities: { locality: "remote" } });
    const request = {
      ...requests.binary,
      unexpectedSecret: "must never be sent",
    } as unknown as DecisionRequest<"binary">;
    const result = await engine([backend]).decide(request);
    expect(result.error).toMatchObject({ code: "invalid_request", field: "request" });
    expect(backend.calls).toHaveLength(0);
  });

  it("snapshots candidate IDs before asynchronous backend work", async () => {
    const backend = new FakeBackend();
    backend.enqueue(predictions.choice);
    const mutableCandidates = [{ ...candidateA }, { ...candidateB }];
    const request: DecisionRequest<"choice"> = {
      ...requests.choice,
      candidates: mutableCandidates,
    };
    const pending = engine([backend]).decide(request);
    mutableCandidates[0]!.id = createCandidateId("changed.ts");
    const result = await pending;
    expect(result.outcome).toBe("accept");
    expect(backend.calls[0]?.request.candidates?.[0]?.id).toBe(candidateA.id);
  });

  it("rejects candidate IDs introduced by a backend", async () => {
    const backend = new FakeBackend();
    backend.enqueue({ value: { kind: "choice", selectedId: createCandidateId("outside.ts") } });
    const result = await engine([backend]).decide(requests.choice);
    expect(result.outcome).toBe("unknown");
    expect(result.error).toMatchObject({ code: "invalid_output", field: "value.selectedId" });
  });

  it("rejects incomplete score sets and duplicate ranking IDs", async () => {
    const scoreBackend = new FakeBackend();
    scoreBackend.enqueue({ value: { kind: "score", scores: [{ id: candidateA.id, score: 0.5 }] } });
    expect((await engine([scoreBackend]).decide(requests.score)).error?.code).toBe(
      "invalid_output",
    );

    const rankingBackend = new FakeBackend();
    rankingBackend.enqueue({
      value: { kind: "ranking", orderedIds: [candidateA.id, candidateA.id] },
    });
    expect((await engine([rankingBackend]).decide(requests.ranking)).error?.code).toBe(
      "invalid_output",
    );
  });

  it("does not route repository data to an unapproved remote backend", async () => {
    const remote = new FakeBackend({ capabilities: { id: "remote", locality: "remote" } });
    remote.enqueue(predictions.binary);
    const denied = await engine([remote]).decide(requests.binary);
    expect(denied.error?.code).toBe("privacy_denied");
    expect(remote.calls).toHaveLength(0);

    const permitted: DecisionRequest<"binary"> = {
      ...requests.binary,
      constraints: {
        ...requests.binary.constraints,
        locality: "remote_allowed",
        allowedRemoteData: ["task"],
      },
    };
    const allowed = await engine([remote]).decide(permitted);
    expect(allowed.outcome).toBe("accept");
    expect(remote.calls).toHaveLength(1);
  });

  it("fails over in configured order after an unavailable backend", async () => {
    const first = new FakeBackend({ capabilities: { id: "first" }, health: "unavailable" });
    const second = new FakeBackend({ capabilities: { id: "second" } });
    second.enqueue(predictions.binary);
    const result = await engine([first, second]).decide(requests.binary);
    expect(result.outcome).toBe("accept");
    expect(result.backend?.id).toBe("second");
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(1);
  });

  it("skips backends whose capabilities cannot handle the request", async () => {
    const backend = new FakeBackend({ capabilities: { kinds: ["choice"], maxInputBytes: 1 } });
    const result = await engine([backend]).decide(requests.binary);
    expect(result.error?.code).toBe("unsupported");
    expect(backend.healthCalls).toBe(0);
  });

  it("returns a sanitized backend error", async () => {
    const backend = new FakeBackend();
    backend.enqueue(new Error("secret API_KEY=abc"));
    const result = await engine([backend]).decide(requests.binary);
    expect(result.error).toMatchObject({ code: "backend_failure", retryable: true });
    expect(JSON.stringify(result)).not.toContain("API_KEY=abc");
  });

  it("rejects rankings beyond the requested output budget", async () => {
    const backend = new FakeBackend();
    backend.enqueue(predictions.ranking);
    const request: DecisionRequest<"ranking"> = {
      ...requests.ranking,
      constraints: { ...requests.ranking.constraints, maxOutputItems: 1 },
    };
    const result = await engine([backend]).decide(request);
    expect(result.error).toMatchObject({ code: "invalid_output", field: "value.orderedIds" });
  });

  it("returns promptly on timeout even if a backend ignores abort", async () => {
    const backend = new FakeBackend();
    backend.enqueue(() => new Promise(() => undefined));
    const request: DecisionRequest<"binary"> = {
      ...requests.binary,
      constraints: { ...requests.binary.constraints, deadlineMs: 20 },
    };
    const result = await engine([backend]).decide(request);
    expect(result.error?.code).toBe("timeout");
    expect(result.outcome).toBe("unknown");
    expect(backend.calls[0]?.signal?.aborted).toBe(true);
  });

  it("propagates external cancellation and records it structurally", async () => {
    const backend = new FakeBackend();
    backend.enqueue(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = engine([backend]).decide(requests.binary, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result.error?.code).toBe("cancelled");
    expect(backend.calls[0]?.signal?.aborted).toBe(true);
  });

  it("does no backend work for a pre-aborted request", async () => {
    const backend = new FakeBackend();
    const controller = new AbortController();
    controller.abort();
    const result = await engine([backend]).decide(requests.binary, controller.signal);
    expect(result.error?.code).toBe("cancelled");
    expect(backend.healthCalls).toBe(0);
  });

  it("rejects uncalibrated acceptance from a confidence policy", async () => {
    const backend = new FakeBackend();
    backend.enqueue(predictions.binary);
    const confidence: ConfidencePolicy = {
      assess: () => ({ outcome: "accept", confidence: null, calibrated: false, reasonCode: "bad" }),
    };
    const result = await engine([backend], confidence).decide(requests.binary);
    expect(result.error?.code).toBe("policy_failure");
    expect(result.outcome).toBe("unknown");
  });
});
