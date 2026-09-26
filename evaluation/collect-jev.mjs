#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CONTRACT_SCHEMA_VERSION } from "../packages/core/dist/index.js";
import { JevBackend } from "../packages/providers/dist/index.js";
import { calibrationMetrics } from "./metrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export function summarizeJevObservations(report) {
  const observations = report.observations.map((item) => ({
    ...item,
    correct:
      typeof item.predictedSufficient === "boolean"
        ? item.gold === "uncertain"
          ? null
          : item.predictedSufficient === (item.gold === "sufficient")
        : undefined,
  }));
  const scored = observations.filter(
    (item) =>
      typeof item.yesProbability === "number" &&
      (item.gold === "sufficient" || item.gold === "insufficient"),
  );
  return {
    ...report,
    observations,
    sufficiencyEvent: calibrationMetrics(
      scored.map((item) => ({
        probability: item.yesProbability,
        correct: item.gold === "sufficient",
      })),
      5,
    ),
    predictedLabelCorrectness: calibrationMetrics(
      scored.map((item) => ({ probability: item.predictedLabelConfidence, correct: item.correct })),
      5,
    ),
    responseCount: observations.filter((item) => typeof item.predictedSufficient === "boolean")
      .length,
    sampleCount: scored.length,
  };
}

export async function collectJev(options = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required");
  const dataset = JSON.parse(await readFile(path.join(here, "datasets", "decisions.json"), "utf8"));
  const limit = options.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8)
    throw new RangeError("limit must be 1..8");
  const backend = new JevBackend({ timeoutMs: 20_000, maxAttempts: 2 });
  const observations = [];
  for (const item of dataset.contextSufficiency.slice(0, limit)) {
    const request = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id: `eval-${item.id}`,
      category: "context_sufficiency",
      kind: "binary",
      task: `Is this evidence sufficient for the task? Task: ${item.task}`,
      evidence: item.retrieved.map((id) => `${id}: synthetic ${id} evidence`),
      dataClasses: ["task", "summaries"],
      constraints: {
        locality: "remote_allowed",
        allowedRemoteData: ["task", "summaries"],
        profile: "safe",
        deadlineMs: 20_000,
        maxCandidates: 1,
      },
    };
    try {
      const prediction = await backend.predict(request);
      const yesProbability = prediction.rawSignal;
      const predictedYes = prediction.value?.kind === "binary" ? prediction.value.value : null;
      if (!Number.isFinite(yesProbability) || typeof predictedYes !== "boolean")
        throw new Error("invalid_prediction");
      observations.push({
        id: item.id,
        gold: item.gold,
        predictedSufficient: predictedYes,
        yesProbability,
        predictedLabelConfidence: predictedYes ? yesProbability : 1 - yesProbability,
        usage: prediction.usage ?? null,
      });
    } catch (error) {
      observations.push({
        id: item.id,
        gold: item.gold,
        errorCode: typeof error?.code === "string" ? error.code : "provider_error",
      });
    }
  }
  return summarizeJevObservations({
    schemaVersion: 1,
    backendId: backend.capabilities.id,
    modelVersion: backend.capabilities.modelVersion,
    category: "context_sufficiency",
    kind: "binary",
    datasetProvenance: dataset.provenance,
    observations,
    readyForCalibration: false,
    reason:
      "Small synthetic, non-held-out sample; no independent labels or separate calibration and validation cohorts.",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = path.join(here, "results", "step31-jev-diagnostic.json");
  const report = process.argv.includes("--recompute")
    ? summarizeJevObservations(JSON.parse(await readFile(destination, "utf8")))
    : await collectJev();
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ report: destination, sampleCount: report.sampleCount, errors: report.observations.filter((item) => item.errorCode).length, sufficiencyEvent: report.sufficiencyEvent, predictedLabelCorrectness: report.predictedLabelCorrectness, readyForCalibration: report.readyForCalibration }, null, 2)}\n`,
  );
}
