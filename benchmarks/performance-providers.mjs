import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { DecisionCache } from "../packages/core/dist/index.js";
import { JevBackend } from "../packages/providers/dist/index.js";
import { CONTRACT_SCHEMA_VERSION } from "../packages/shared/dist/index.js";

const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(3)),
    p95Ms: Number(
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)].toFixed(3),
    ),
  };
};
const request = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  id: "profile-binary",
  category: "performance_profile",
  kind: "binary",
  task: "Profile a synthetic decision without repository content",
  evidence: [],
  repositoryState: "fixture-v1",
  dataClasses: ["task"],
  constraints: {
    locality: "remote_allowed",
    allowedRemoteData: ["task"],
    profile: "balanced",
    deadlineMs: 5_000,
    maxCandidates: 1,
  },
};
const response = new globalThis.Response(
  JSON.stringify({
    model: "typesafe/jev-1.13-20260917",
    provider: "mock",
    answers: { decision: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 20, output_tokens: 4 },
  }),
  { status: 200 },
);
let payloadBytes = 0;
let simulatedNetworkMs = 35;
const jev = new JevBackend({
  apiKey: "profile-only-placeholder",
  maxAttempts: 1,
  fetch: async (_input, init) => {
    payloadBytes = Buffer.byteLength(String(init?.body));
    await delay(simulatedNetworkMs);
    return response.clone();
  },
});
const jevTimes = [];
for (let i = 0; i < 25; i++) {
  const start = performance.now();
  await jev.predict({ ...request, id: `profile-${i}` });
  jevTimes.push(performance.now() - start);
}

const cache = new DecisionCache();
const backend = { id: "profile-fake", modelVersion: "1" };
const result = {
  requestId: request.id,
  outcome: "accept",
  confidence: 0.9,
  calibrated: false,
  provenance: "backend",
  backend: { ...backend, provider: "fake" },
  latencyMs: 1,
  trace: { traceId: "profile", requestId: request.id, stages: [], latencyMs: 1 },
};
await cache.set({ request, backend, workspaceId: "fixture", result });
const cacheTimes = [];
for (let i = 0; i < 1_000; i++) {
  const start = performance.now();
  await cache.get({
    request: { ...request, id: `cache-${i}` },
    backend,
    workspaceId: "fixture",
    traceId: `trace-${i}`,
  });
  cacheTimes.push(performance.now() - start);
}
process.stdout.write(
  JSON.stringify({
    jev: {
      transport: "mock fetch; no OpenRouter request",
      p50Ms: Number(summarize(jevTimes).p50Ms.toFixed(2)),
      p95Ms: Number(summarize(jevTimes).p95Ms.toFixed(2)),
      simulatedNetworkDelayMs: simulatedNetworkMs,
      observedPayloadBytes: payloadBytes,
      rounds: jevTimes.length,
    },
    decisionCache: {
      workload: "1,000 in-memory cache hits with WebCrypto SHA-256 keying",
      ...summarize(cacheTimes),
      stats: cache.stats,
    },
  }) + "\n",
);
