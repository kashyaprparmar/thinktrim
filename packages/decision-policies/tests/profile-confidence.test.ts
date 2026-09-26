import { describe, expect, it } from "vitest";
import { CONTRACT_SCHEMA_VERSION, CoreDecisionEngine, FakeBackend } from "@thinktrim/core";
import type {
  BackendPrediction,
  BackendIdentity,
  ConfidenceProfile,
  DecisionPolicy,
  DecisionRequest,
} from "@thinktrim/core";
import { ProfileConfidencePolicy } from "../src/index.js";
import type { ConfidenceCalibrator } from "../src/index.js";

const backend = { id: "fake", modelVersion: "test", locality: "local" } as const;
const prediction: BackendPrediction<"binary"> = {
  value: { kind: "binary", value: true },
  rawSignal: 0.999999,
};

function request(
  profile: ConfidenceProfile = "safe",
  category = "context_sufficiency",
): DecisionRequest<"binary"> {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    id: "confidence-test",
    category,
    kind: "binary",
    task: "Is the evidence sufficient?",
    dataClasses: ["task"],
    constraints: {
      locality: "local_only",
      allowedRemoteData: [],
      profile,
      deadlineMs: 1000,
      maxCandidates: 10,
    },
  };
}

function calibrator(mapSignal: (rawSignal: number) => number | null): ConfidenceCalibrator {
  return {
    backendId: "fake",
    modelVersion: "test",
    category: "context_sufficiency",
    kind: "binary",
    evidence: {
      datasetId: "held-out-v1",
      evaluationRunId: "eval-123",
      sampleCount: 250,
      calibratorVersion: "1",
    },
    mapSignal,
  };
}

function assess(
  policy: ProfileConfidencePolicy,
  profile: ConfidenceProfile = "safe",
  category = "context_sufficiency",
  identity: BackendIdentity = backend,
) {
  return policy.assess({
    request: request(profile, category),
    prediction,
    deterministic: false,
    risk: "low",
    backend: identity,
  });
}

describe("ProfileConfidencePolicy", () => {
  it("exposes distinct provisional thresholds by profile, kind, category, and risk", () => {
    const policy = new ProfileConfidencePolicy();
    const base = { category: "other", risk: "low" } as const;
    expect(policy.thresholdFor({ ...base, profile: "safe", kind: "binary" })).toMatchObject({
      value: 0.98,
      status: "provisional",
    });
    expect(policy.thresholdFor({ ...base, profile: "safe", kind: "score" }).value).toBe(0.96);
    expect(policy.thresholdFor({ ...base, profile: "balanced", kind: "binary" }).value).toBe(0.95);
    expect(policy.thresholdFor({ ...base, profile: "aggressive", kind: "binary" }).value).toBe(0.9);
    expect(
      policy.thresholdFor({
        ...base,
        category: "context_sufficiency",
        profile: "safe",
        kind: "binary",
      }).value,
    ).toBe(0.995);
    expect(
      policy.thresholdFor({ ...base, risk: "high", profile: "balanced", kind: "score" }).value,
    ).toBe(0.98);
  });

  it("never treats a large raw signal as calibrated confidence", () => {
    const policy = new ProfileConfidencePolicy();
    expect(assess(policy)).toEqual({
      outcome: "retrieve_more",
      confidence: null,
      calibrated: false,
      reasonCode: "calibration_unavailable",
    });
    expect(assess(policy, "safe", "failure_classification").outcome).toBe("unknown");
  });

  it("requires exact backend, model, category, and kind calibration scope", () => {
    const policy = new ProfileConfidencePolicy([calibrator(() => 1)]);
    expect(assess(policy, "safe", "other").calibrated).toBe(false);
    expect(
      assess(policy, "safe", "context_sufficiency", { ...backend, modelVersion: "next" })
        .calibrated,
    ).toBe(false);
    expect(assess(policy).outcome).toBe("accept");
  });

  it("applies provisional profile floors only to explicitly calibrated scores", () => {
    const policy = new ProfileConfidencePolicy([calibrator(() => 0.97)]);
    expect(assess(policy, "safe")).toMatchObject({
      outcome: "retrieve_more",
      confidence: 0.97,
      calibrated: true,
      reasonCode: "provisional_threshold_unmet",
    });
    expect(assess(policy, "aggressive")).toMatchObject({
      outcome: "accept",
      confidence: 0.97,
      calibrated: true,
      reasonCode: "provisional_threshold_met",
    });
  });

  it("calibrates the selected binary answer, including a false answer", () => {
    const policy = new ProfileConfidencePolicy([calibrator((signal) => signal)]);
    const result = policy.assess({
      request: request("aggressive"),
      prediction: { value: { kind: "binary", value: false }, rawSignal: 0.02 },
      deterministic: false,
      risk: "low",
      backend,
    });
    expect(result.confidence).toBeCloseTo(0.98);
    expect(result.outcome).toBe("accept");
    const contradictory = policy.assess({
      request: request("aggressive"),
      prediction: { value: { kind: "binary", value: false }, rawSignal: 0.98 },
      deterministic: false,
      risk: "low",
      backend,
    });
    expect(contradictory.confidence).toBeCloseTo(0.02);
    expect(contradictory.outcome).toBe("retrieve_more");
  });

  it.each([null, Number.NaN, -0.1, 1.1])("bypasses invalid calibrator output %s", (value) => {
    expect(assess(new ProfileConfidencePolicy([calibrator(() => value)])).calibrated).toBe(false);
  });

  it("bypasses a throwing calibrator and rejects duplicate calibration records", () => {
    expect(
      assess(
        new ProfileConfidencePolicy([
          calibrator(() => {
            throw new Error("private details");
          }),
        ]),
      ),
    ).toMatchObject({ outcome: "retrieve_more", confidence: null });
    expect(
      () => new ProfileConfidencePolicy([calibrator(() => 0.9), calibrator(() => 0.8)]),
    ).toThrow("Duplicate calibration scope");
  });

  it("accepts exact deterministic policy results without inventing a probability", () => {
    const policy = new ProfileConfidencePolicy();
    expect(
      policy.assess({
        request: request(),
        prediction: { value: { kind: "binary", value: false } },
        deterministic: true,
        risk: "high",
      }),
    ).toEqual({
      outcome: "accept",
      confidence: null,
      calibrated: false,
      reasonCode: "exact_deterministic",
    });
  });

  it("keeps the core engine conservative without a calibrator", async () => {
    const fake = new FakeBackend();
    fake.enqueue(prediction);
    const decisionPolicy: DecisionPolicy = {
      resolveExactly: () => undefined,
      validate: () => undefined,
      risk: () => "low",
    };
    const engine = new CoreDecisionEngine({
      backends: [fake],
      decisionPolicy,
      confidencePolicy: new ProfileConfidencePolicy(),
    });
    const result = await engine.decide(request());
    expect(result).toMatchObject({
      outcome: "retrieve_more",
      calibrated: false,
      confidence: null,
      provenance: "backend",
    });
  });
});
