#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ProfileConfidencePolicy } from "../packages/decision-policies/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCOPES = [
  { name: "context_relevance", category: "context_ranking", kind: "score", risk: "medium" },
  { name: "context_sufficiency", category: "context_sufficiency", kind: "binary", risk: "high" },
  { name: "test_relevance", category: "test_selection", kind: "score", risk: "medium" },
  {
    name: "failure_classification",
    category: "failure_classification",
    kind: "choice",
    risk: "medium",
  },
  { name: "retry", category: "retry_gate", kind: "choice", risk: "high" },
];

/** A readiness gate, not a threshold fitter: it never promotes synthetic observations. */
export function auditCalibration(evaluation, diagnostic) {
  const policy = new ProfileConfidencePolicy();
  const observations =
    diagnostic?.observations?.filter(
      (item) =>
        typeof item.predictedLabelConfidence === "number" &&
        (item.gold === "sufficient" || item.gold === "insufficient"),
    ) ?? [];
  const sufficientlyLabeled = observations.filter((item) => item.gold === "sufficient").length;
  const insufficient = observations.length - sufficientlyLabeled;
  const scopes = SCOPES.map((scope) => {
    const matching =
      scope.name === "context_sufficiency" &&
      diagnostic?.category === scope.category &&
      diagnostic?.kind === scope.kind
        ? observations
        : [];
    const thresholds = Object.fromEntries(
      ["safe", "balanced", "aggressive"].map((profile) => {
        const threshold = policy.thresholdFor({
          profile,
          kind: scope.kind,
          category: scope.category,
          risk: scope.risk,
        });
        const accepted = matching.filter(
          (item) => item.predictedLabelConfidence >= threshold.value,
        );
        return [
          profile,
          {
            ...threshold,
            diagnosticAccepted: accepted.length,
            diagnosticIncorrectAccepted: accepted.filter((item) => !item.correct).length,
          },
        ];
      }),
    );
    const blockers = [];
    blockers.push("thresholds_not_fitted_or_validated");
    if (matching.length < 200) blockers.push("fewer_than_200_scoped_provider_observations");
    if (scope.name === "context_sufficiency" && (sufficientlyLabeled < 30 || insufficient < 30))
      blockers.push("insufficient_positive_or_negative_labels");
    if (!diagnostic?.independentHeldOut) blockers.push("no_independent_held_out_validation_cohort");
    if (scope.name === "context_relevance" && evaluation.contextRelevance.totalMissedRelevant > 0)
      blockers.push("context_false_negative_pruning_observed");
    if (scope.name === "context_sufficiency" && matching.some((item) => !item.correct))
      blockers.push("provider_errors_observed");
    return {
      ...scope,
      backendId: matching.length ? diagnostic.backendId : null,
      modelVersion: matching.length ? diagnostic.modelVersion : null,
      sampleCount: matching.length,
      thresholds,
      readiness: "blocked",
      blockers,
    };
  });
  return {
    schemaVersion: 1,
    decision: "retain_provisional_safe_default",
    balancedDefault: false,
    profilesFinalized: false,
    sourceEvaluation: "evaluation/results/step30.json",
    sourceDiagnostic: diagnostic ? "evaluation/results/step31-jev-diagnostic.json" : null,
    evidence: {
      contextPruningMisses: evaluation.contextRelevance.totalMissedRelevant,
      sufficiencyFalsePositiveStops: evaluation.contextSufficiency.falsePositiveSufficient.length,
      providerObservations: observations.length,
      providerCorrect: observations.filter((item) => item.correct).length,
      providerIncorrect: observations.filter((item) => !item.correct).length,
      brier: diagnostic?.predictedLabelCorrectness?.brier ?? null,
      ece: diagnostic?.predictedLabelCorrectness?.ece ?? null,
      synthetic: true,
    },
    scopes,
    nextEvidence:
      "Collect independently labeled, held-out provider observations per backend/model/category/kind; validate confidence mapping and risk-specific operating points before updating any profile or default.",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evaluation = JSON.parse(await readFile(path.join(here, "results", "step30.json"), "utf8"));
  let diagnostic = null;
  try {
    diagnostic = JSON.parse(
      await readFile(path.join(here, "results", "step31-jev-diagnostic.json"), "utf8"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const report = auditCalibration(evaluation, diagnostic);
  const destination = path.join(here, "results", "step31.json");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ report: destination, decision: report.decision, evidence: report.evidence, scopes: report.scopes.map((scope) => ({ name: scope.name, sampleCount: scope.sampleCount, readiness: scope.readiness, blockers: scope.blockers })) }, null, 2)}\n`,
  );
}
