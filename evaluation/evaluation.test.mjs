import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "./run.mjs";
import { binaryMetrics, calibrationMetrics, rankingMetrics } from "./metrics.mjs";

test("binary metrics expose false positives and false negatives", () => {
  const result = binaryMetrics([
    { gold: true, predicted: true },
    { gold: true, predicted: false },
    { gold: false, predicted: true },
    { gold: false, predicted: false },
  ]);
  assert.deepEqual(result, { tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5, f1: 0.5 });
});

test("ranking metrics count hidden relevant files omitted from top k", () => {
  const result = rankingMetrics(
    [{ ranked: ["decoy", "other", "target"], grades: { decoy: 0, other: 0, target: 3 } }],
    2,
  );
  assert.equal(result.topKRecall, 0);
  assert.equal(result.mrr, 1 / 3);
  assert.deepEqual(result.details[0].missedRelevant, ["target"]);
});

test("Brier and ECE require real probability rows", () => {
  assert.deepEqual(calibrationMetrics([]), { sampleCount: 0, brier: null, ece: null });
  const result = calibrationMetrics([
    { probability: 0.9, correct: true },
    { probability: 0.1, correct: false },
  ]);
  assert.ok(Math.abs(result.brier - 0.01) < 1e-9);
  assert.ok(Math.abs(result.ece - 0.1) < 1e-9);
  assert.throws(() => calibrationMetrics([{ probability: 1.1, correct: true }]));
});

test("actual policy evaluation records pruning misses and conservative gates", async () => {
  const report = await evaluate();
  assert.equal(report.contextRelevance.count, 10);
  assert.equal(report.contextRelevance.totalMissedRelevant, 2);
  assert.equal(report.contextSufficiency.falsePositiveSufficient.length, 0);
  assert.equal(report.contextSufficiency.unsafeStopCount, 0);
  assert.equal(report.retry.unsafeAutomaticRetries.length, 0);
  assert.equal(report.calibrationEvidence.status, "unavailable");
  assert.equal(report.contextRelevance.calibratedProbabilities.ece, null);
});
