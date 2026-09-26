import assert from "node:assert/strict";
import test from "node:test";
import { auditCalibration } from "./calibration.mjs";
import { summarizeJevObservations } from "./collect-jev.mjs";

test("uncertain gold cases remain visible but are excluded from binary calibration", () => {
  const report = summarizeJevObservations({
    observations: [
      {
        id: "uncertain",
        gold: "uncertain",
        predictedSufficient: false,
        yesProbability: 0.1,
        predictedLabelConfidence: 0.9,
      },
      {
        id: "sufficient",
        gold: "sufficient",
        predictedSufficient: false,
        yesProbability: 0.2,
        predictedLabelConfidence: 0.8,
      },
    ],
  });
  assert.equal(report.responseCount, 2);
  assert.equal(report.sampleCount, 1);
  assert.equal(report.observations[0].correct, null);
  assert.equal(report.observations[1].correct, false);
  assert.ok(Math.abs(report.predictedLabelCorrectness.brier - 0.64) < 1e-9);
});

test("small synthetic provider evidence cannot promote any threshold or balanced default", () => {
  const report = auditCalibration(
    {
      contextRelevance: { totalMissedRelevant: 2 },
      contextSufficiency: { falsePositiveSufficient: [] },
    },
    {
      category: "context_sufficiency",
      kind: "binary",
      backendId: "jev",
      modelVersion: "1",
      observations: [
        { id: "one", gold: "insufficient", predictedLabelConfidence: 0.99, correct: true },
        { id: "two", gold: "sufficient", predictedLabelConfidence: 0.92, correct: false },
      ],
      predictedLabelCorrectness: { brier: 0.4, ece: 0.3 },
    },
  );
  assert.equal(report.balancedDefault, false);
  assert.equal(report.profilesFinalized, false);
  assert.ok(report.scopes.every((scope) => scope.readiness === "blocked"));
  assert.equal(report.scopes.find((scope) => scope.name === "context_sufficiency").sampleCount, 2);
  assert.ok(
    report.scopes
      .find((scope) => scope.name === "context_relevance")
      .blockers.includes("context_false_negative_pruning_observed"),
  );
  assert.equal(
    report.scopes.find((scope) => scope.name === "context_sufficiency").thresholds.safe.status,
    "provisional",
  );
});
