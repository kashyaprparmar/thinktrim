#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ContextRankingPolicy } from "../packages/context-ranker/dist/index.js";
import {
  ContextSufficiencyPolicy,
  FailureClassificationPolicy,
  RetryPolicy,
  TestSelectionPolicy,
} from "../packages/decision-policies/dist/index.js";
import { indexWorkspace } from "../packages/repo-indexer/dist/index.js";
import {
  binaryMetrics,
  calibrationMetrics,
  classificationMetrics,
  rankingMetrics,
} from "./metrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function metadata(raw) {
  return {
    id: `file:${createHash("sha256").update(raw.path).digest("hex").slice(0, 32)}`,
    path: raw.path,
    language: "typescript",
    symbols: raw.symbols.map((symbol) => ({
      id: `${raw.path}#${symbol.name}:1`,
      filePath: raw.path,
      name: symbol.name,
      kind: symbol.kind,
      line: 1,
    })),
    imports: raw.imports.map((specifier) => ({ specifier, line: 1, resolvedPath: null })),
    contentFingerprint: createHash("sha256").update(raw.path).digest("hex"),
    score: raw.retrievalScore,
    sources: ["lexical"],
    matchedTerms: [],
    description: raw.path,
  };
}

async function contextRelevance(cases, adversarialCases) {
  const policy = new ContextRankingPolicy();
  const observations = [];
  for (const item of [...cases, ...adversarialCases]) {
    const candidates = item.candidates.map(metadata);
    const result = await policy.rank({
      task: item.task,
      candidates,
      ...(item.changedFiles ? { changedFiles: item.changedFiles } : {}),
      ...(item.currentEvidence ? { currentEvidence: item.currentEvidence } : {}),
    });
    const grades = Object.fromEntries(
      item.candidates.map((candidate) => [candidate.path, candidate.gold]),
    );
    observations.push({
      id: item.name,
      source: adversarialCases.includes(item) ? "adversarial" : "step11_regression",
      ranked: result.ranked.map((candidate) => candidate.path),
      grades,
      strategy: result.metadata.strategy,
    });
  }
  const metrics = rankingMetrics(observations, 3);
  const pr = binaryMetrics(
    observations.flatMap((item) =>
      Object.entries(item.grades).map(([file, grade]) => ({
        gold: grade >= 2,
        predicted: item.ranked.slice(0, 3).includes(file),
      })),
    ),
  );
  return {
    dataset: "step11_regression_plus_independent_synthetic_pruning_cases",
    count: observations.length,
    precision: pr.precision,
    recall: pr.recall,
    f1: pr.f1,
    mrr: metrics.mrr,
    ndcgAt3: metrics.ndcg,
    top3Recall: metrics.topKRecall,
    falseNegativePruning: observations
      .map((item, index) => ({ id: item.id, missed: metrics.details[index].missedRelevant }))
      .filter((item) => item.missed.length),
    adversarialFalseNegativePruning: observations
      .map((item, index) => ({
        id: item.id,
        source: item.source,
        missed: metrics.details[index].missedRelevant,
      }))
      .filter((item) => item.source === "adversarial" && item.missed.length),
    totalMissedRelevant: metrics.details.reduce((sum, item) => sum + item.missedRelevant.length, 0),
    calibratedProbabilities: calibrationMetrics([]),
  };
}

async function contextSufficiency(cases) {
  const engine = {
    decide: async () => ({ outcome: "unknown", calibrated: false, confidence: null, latencyMs: 0 }),
  };
  const policy = new ContextSufficiencyPolicy({ engine });
  const observations = [];
  for (const item of cases) {
    const result = await policy.assess({
      task: item.task,
      retrievedEvidence: item.retrieved.map((id) => ({
        id,
        source: `fixture:${id}`,
        summary: `Known ${id} evidence`,
        fingerprint: `sha256:${id}`,
      })),
      requiredEvidenceIds: item.required,
      ...(item.openQuestions ? { openQuestions: item.openQuestions } : {}),
    });
    observations.push({
      id: item.id,
      gold: item.gold,
      predicted: result.status,
      continueSearch: result.continueSearch,
    });
  }
  const safeToStop = binaryMetrics(
    observations.map((item) => ({
      gold: item.gold === "sufficient",
      predicted: item.predicted === "sufficient",
    })),
  );
  return {
    dataset: "synthetic_sufficiency_regression",
    count: observations.length,
    safeToStop,
    falsePositiveSufficient: observations.filter(
      (item) => item.predicted === "sufficient" && item.gold !== "sufficient",
    ),
    uncertainCount: observations.filter((item) => item.predicted === "uncertain").length,
    unsafeStopCount: observations.filter(
      (item) => item.predicted !== "sufficient" && !item.continueSearch,
    ).length,
    observations,
    calibratedProbabilities: calibrationMetrics([]),
  };
}

async function testRelevance(cases) {
  const root = await mkdtemp(path.join(os.tmpdir(), "thinktrim-eval-tests-"));
  if (
    path.dirname(root) !== os.tmpdir() ||
    !path.basename(root).startsWith("thinktrim-eval-tests-")
  )
    throw new Error("Unsafe evaluation cleanup path");
  try {
    const files = {
      "package.json": '{"type":"module"}\n',
      "src/session.mjs": "export function refreshSession() { return true; }\n",
      "src/discount.mjs": "export function discount() { return 1; }\n",
      "tests/session.test.mjs": 'import { refreshSession } from "../src/session.mjs";\n',
      "tests/discount.test.mjs": 'import { discount } from "../src/discount.mjs";\n',
      "tests/unrelated.test.mjs": "export const unrelated = true;\n",
    };
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    const index = await indexWorkspace(root);
    const policy = new TestSelectionPolicy();
    const observations = [];
    for (const item of cases) {
      const result = await policy.select(index, { task: item.task, changedFiles: item.changed });
      observations.push({
        id: item.id,
        ranked: result.candidates.map((candidate) => candidate.path),
        grades: Object.fromEntries(item.gold.map((file) => [file, 3])),
        fullCiRequired: result.alwaysRunFullCi,
      });
    }
    const metrics = rankingMetrics(
      observations.filter((item) => Object.keys(item.grades).length),
      3,
    );
    const pr = binaryMetrics(
      observations.flatMap((item) =>
        [...new Set([...item.ranked, ...Object.keys(item.grades)])].map((file) => ({
          gold: file in item.grades,
          predicted: item.ranked.slice(0, 3).includes(file),
        })),
      ),
    );
    return {
      dataset: "synthetic_test_selection_regression",
      count: observations.length,
      precision: pr.precision,
      recall: pr.recall,
      f1: pr.f1,
      mrr: metrics.mrr,
      ndcgAt3: metrics.ndcg,
      top3Recall: metrics.topKRecall,
      missedTests: observations
        .map((item) => ({
          id: item.id,
          missed: Object.keys(item.grades).filter(
            (file) => !item.ranked.slice(0, 3).includes(file),
          ),
        }))
        .filter((item) => item.missed.length),
      fullCiRequiredEverywhere: observations.every((item) => item.fullCiRequired),
      calibratedProbabilities: calibrationMetrics([]),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function failureClassification(cases) {
  const policy = new FailureClassificationPolicy();
  const observations = [];
  for (const item of cases) {
    const result = await policy.classify({ output: item.output, exitCode: 1 });
    observations.push({
      id: item.id,
      gold: item.gold,
      predicted: result.category,
      source: result.source,
    });
  }
  return {
    dataset: "synthetic_failure_logs",
    ...classificationMetrics(observations),
    errors: observations.filter((item) => item.gold !== item.predicted),
    calibratedProbabilities: calibrationMetrics([]),
  };
}

async function retry(cases) {
  const policy = new RetryPolicy();
  const observations = [];
  for (const item of cases) {
    const result = await policy.evaluate(item.input);
    observations.push({
      id: item.id,
      gold: item.gold,
      predicted: result.action,
      automatic: result.automatic,
    });
  }
  const retryMetric = binaryMetrics(
    observations.map((item) => ({
      gold: item.gold === "retry",
      predicted: item.predicted === "retry",
    })),
  );
  return {
    dataset: "synthetic_retry_safety_cases",
    count: observations.length,
    retryMetric,
    unsafeAutomaticRetries: observations.filter((item) => item.automatic && item.gold !== "retry"),
    errors: observations.filter((item) => item.gold !== item.predicted),
    calibratedProbabilities: calibrationMetrics([]),
  };
}

export async function evaluate() {
  const [dataset, relevance, pruning] = await Promise.all([
    readFile(path.join(here, "datasets", "decisions.json"), "utf8").then(JSON.parse),
    readFile(
      path.join(here, "..", "packages", "context-ranker", "bench", "fixtures.json"),
      "utf8",
    ).then(JSON.parse),
    readFile(path.join(here, "datasets", "context-pruning.json"), "utf8").then(JSON.parse),
  ]);
  if (dataset.version !== 1) throw new Error("Unsupported evaluation dataset version");
  return {
    schemaVersion: 1,
    provenance: dataset.provenance,
    contextRelevance: await contextRelevance(relevance.cases, pruning.cases),
    contextSufficiency: await contextSufficiency(dataset.contextSufficiency),
    testRelevance: await testRelevance(dataset.testRelevance),
    failureClassification: await failureClassification(dataset.failureClassification),
    retry: await retry(dataset.retry),
    calibrationEvidence: {
      status: "unavailable",
      reason:
        "No held-out scoped provider probabilities and labels; deterministic scores are not probabilities.",
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await evaluate();
  const destination = path.join(here, "results", "step30.json");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ report: destination, contextRelevance: report.contextRelevance, contextSufficiency: { safeToStop: report.contextSufficiency.safeToStop, falsePositiveSufficient: report.contextSufficiency.falsePositiveSufficient }, testRelevance: report.testRelevance, failureClassification: { accuracy: report.failureClassification.accuracy, macroF1: report.failureClassification.macroF1, errors: report.failureClassification.errors }, retry: { retryMetric: report.retry.retryMetric, unsafeAutomaticRetries: report.retry.unsafeAutomaticRetries } }, null, 2)}\n`,
  );
}
