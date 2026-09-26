import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DecisionResult } from "@thinktrim/core";
import { CONTRACT_SCHEMA_VERSION } from "@thinktrim/shared";
import { afterEach, expect, it } from "vitest";
import { createLocalTraceRecord, LocalTraceStore } from "../src/index.js";

const secret = "sk-or-v1-example-private-key";
const source = "function privateRepositorySource() { return 42; }";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (
      path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith("thinktrim-telemetry-")
    ) {
      throw new Error("Unexpected test cleanup path");
    }
    await rm(resolved, { recursive: true, force: true });
  }
});

function decision(): DecisionResult {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: secret,
    outcome: "escalate",
    value: { selectedId: source } as never,
    confidence: 0.99,
    calibrated: false,
    provenance: "backend",
    backend: { id: secret, modelVersion: source, locality: "remote" },
    usage: { unit: secret, inputUnits: 12, outputUnits: 3 },
    error: { code: "backend_failure", message: source, retryable: false },
    latencyMs: 8.5,
    trace: {
      traceId: secret,
      requestId: secret,
      category: source,
      kind: "choice",
      stages: [{ name: "prediction", durationMs: 7, outcome: source, backendId: secret }],
      backendId: secret,
      cacheHit: true,
      outcome: "escalate",
      reasonCode: source,
      latencyMs: 8.5,
    },
  };
}

it("projects only allowlisted metadata and does not persist repository text or credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thinktrim-telemetry-"));
  roots.push(root);
  const store = new LocalTraceStore(root);
  const record = await store.record({
    host: "mcp",
    placement: "post_read",
    result: decision(),
    candidateCounts: { retrieved: 20, ranked: 12, selected: 3 },
    measuredFrontierUsage: { source: "host_reported", inputTokens: 100 },
  });
  const persisted = await readFile(path.join(store.directory, `${record.traceId}.json`), "utf8");
  expect(persisted).not.toContain(secret);
  expect(persisted).not.toContain(source);
  expect(JSON.parse(persisted)).toEqual(record);
  expect(record).toMatchObject({
    host: "mcp",
    category: "other",
    backend: "other",
    confidence: null,
    calibrated: false,
    escalated: true,
    cacheHit: true,
    usage: {
      decisionBackend: { unit: "other", inputUnits: 12, outputUnits: 3 },
      measuredFrontier: { source: "host_reported", inputTokens: 100 },
    },
  });
  expect(await store.list()).toEqual([`${record.traceId}.json`]);
});

it("rejects invalid counts and invented measured usage", () => {
  const base = { host: "cli" as const, placement: "unknown" as const, result: decision() };
  expect(() =>
    createLocalTraceRecord({ ...base, candidateCounts: { retrieved: 2, ranked: 3, selected: 1 } }),
  ).toThrow(/selected <= ranked <= retrieved/);
  expect(() =>
    createLocalTraceRecord({
      ...base,
      candidateCounts: { retrieved: 2, ranked: 2, selected: 1 },
      measuredFrontierUsage: { source: "host_reported" },
    }),
  ).toThrow(/at least one token count/);
});

it("refuses a non-directory trace path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thinktrim-telemetry-"));
  roots.push(root);
  await mkdir(path.join(root, ".thinktrim"));
  await writeFile(path.join(root, ".thinktrim", "traces"), "occupied");
  const store = new LocalTraceStore(root);
  await expect(
    store.record({
      host: "cli",
      placement: "unknown",
      result: decision(),
      candidateCounts: { retrieved: 0, ranked: 0, selected: 0 },
    }),
  ).rejects.toThrow(/real directory/);
});
