import { CONTRACT_SCHEMA_VERSION } from "@thinktrim/core";
import type { BackendCapabilities } from "@thinktrim/core";
import type { LayaLocalInvocation, SystemOneRequest, SystemOneResponse } from "../src/index.js";

/** Small wire fixtures for both the Laya HTTP server and Jev API. */
export const systemOneRequest = {
  state: { task: "Choose a file for a parser change", candidates: ["src/parser.ts", "src/ui.ts"] },
  model: "fixture-model",
  questions: {
    relevant: {
      type: "noul",
      instructions: "Is src/parser.ts relevant?",
    },
    best: {
      type: "choice",
      instructions: "Which file is most relevant?",
      criteria: { "src/parser.ts": "Parser implementation", "src/ui.ts": "UI implementation" },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is this task?",
      criteria: ["can wait", "normal", "urgent"],
    },
  },
} as const satisfies SystemOneRequest;

export const systemOneResponse = {
  model: "fixture-model-v1",
  answers: {
    relevant: { type: "noul", noul: 0.87 },
    best: {
      type: "choice",
      choice: "src/parser.ts",
      confidence: 0.88,
      probabilities: { "src/parser.ts": 0.88, "src/ui.ts": 0.12 },
    },
    urgency: {
      type: "score",
      score: 1.3,
      confidence: 0.76,
      legend: { "0": "can wait", "1": "normal", "2": "urgent" },
      probabilities: { "0": 0.1, "1": 0.5, "2": 0.4 },
    },
  },
  usage: { input_tokens: 42, output_tokens: 3 },
} as const satisfies SystemOneResponse;

export const layaLocalInvocation = {
  state: systemOneRequest.state,
  questions: systemOneRequest.questions,
} as const satisfies LayaLocalInvocation;

export const localCapabilities = {
  id: "fixture-laya-local",
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  modelVersion: "fixture",
  kinds: ["binary", "choice", "score"],
  locality: "local",
  maxInputBytes: 16_384,
  maxCandidates: 16,
  supportsBatch: false,
  supportsCancellation: true,
} as const satisfies BackendCapabilities;

export const remoteCapabilities = {
  ...localCapabilities,
  id: "fixture-jev",
  locality: "remote",
} as const satisfies BackendCapabilities;
