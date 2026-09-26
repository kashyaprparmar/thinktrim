import { CONTRACT_SCHEMA_VERSION, createCandidateId } from "../src/index.js";
import type { BackendPrediction, DecisionKind, DecisionRequest } from "../src/index.js";

export const candidateA = { id: createCandidateId("src/a.ts"), label: "src/a.ts" };
export const candidateB = { id: createCandidateId("src/b.ts"), label: "src/b.ts" };

const base = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  category: "unit_test",
  task: "Choose the relevant candidate",
  dataClasses: ["task"] as const,
  constraints: {
    locality: "local_only" as const,
    allowedRemoteData: [] as const,
    profile: "balanced" as const,
    deadlineMs: 1000,
    maxCandidates: 10,
  },
};

export const requests = {
  binary: { ...base, id: "binary-1", kind: "binary" },
  choice: {
    ...base,
    id: "choice-1",
    kind: "choice",
    candidates: [candidateA, candidateB],
  },
  score: {
    ...base,
    id: "score-1",
    kind: "score",
    candidates: [candidateA, candidateB],
  },
  ranking: {
    ...base,
    id: "ranking-1",
    kind: "ranking",
    candidates: [candidateA, candidateB],
  },
} as const satisfies { [K in DecisionKind]: DecisionRequest<K> };

export const predictions = {
  binary: { value: { kind: "binary", value: true }, rawSignal: 0.93 },
  choice: { value: { kind: "choice", selectedId: candidateA.id } },
  score: {
    value: {
      kind: "score",
      scores: [
        { id: candidateA.id, score: 0.9 },
        { id: candidateB.id, score: 0.3 },
      ],
    },
  },
  ranking: { value: { kind: "ranking", orderedIds: [candidateA.id, candidateB.id] } },
} as const satisfies { [K in DecisionKind]: BackendPrediction<K> };
