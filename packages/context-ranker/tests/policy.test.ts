import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_SCHEMA_VERSION,
  CoreDecisionEngine,
  FakeBackend,
  validateRequest,
} from "@thinktrim/core";
import type {
  BackendPrediction,
  ConfidencePolicy,
  DecisionPolicy,
  DecisionRequest,
} from "@thinktrim/core";
import { indexWorkspace } from "@thinktrim/repo-indexer";
import { ContextRankingPolicy, generateCandidates } from "../src/index.js";
import type { CandidateMetadata, ContextRankingInput } from "../src/index.js";

interface FixtureCandidate {
  readonly path: string;
  readonly symbols: readonly {
    readonly name: string;
    readonly kind: "function" | "class" | "interface" | "type";
  }[];
  readonly imports: readonly string[];
  readonly retrievalScore: number;
  readonly gold: number;
}
interface FixtureCase {
  readonly name: string;
  readonly task: string;
  readonly changedFiles?: readonly string[];
  readonly currentEvidence?: readonly string[];
  readonly candidates: readonly FixtureCandidate[];
}
const fixtures = JSON.parse(
  readFileSync(new URL("../bench/fixtures.json", import.meta.url), "utf8"),
) as { readonly cases: readonly FixtureCase[] };

function metadata(raw: FixtureCandidate): CandidateMetadata {
  const hash = createHash("sha256").update(raw.path).digest("hex");
  return {
    id: `file:${hash.slice(0, 32)}`,
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
    contentFingerprint: hash,
    score: raw.retrievalScore,
    sources: ["lexical"],
    matchedTerms: [],
    description: `${raw.path}\nSymbols: ${raw.symbols.map((symbol) => symbol.name).join(", ") || "none"}\nImports: ${raw.imports.join(", ") || "none"}`,
  };
}
function inputFor(fixture: FixtureCase): ContextRankingInput {
  return {
    task: fixture.task,
    candidates: fixture.candidates.map(metadata),
    ...(fixture.changedFiles ? { changedFiles: fixture.changedFiles } : {}),
    ...(fixture.currentEvidence ? { currentEvidence: fixture.currentEvidence } : {}),
  };
}
const exactPolicy: DecisionPolicy = {
  resolveExactly: () => undefined,
  validate: () => undefined,
  risk: () => "low",
};
function scoringEngine(backend: FakeBackend, calibrated: boolean): CoreDecisionEngine {
  const confidencePolicy: ConfidencePolicy = {
    assess: () =>
      calibrated
        ? {
            outcome: "accept",
            confidence: 0.72,
            calibrated: true,
            reasonCode: "fixture_calibrated",
          }
        : {
            outcome: "unknown",
            confidence: null,
            calibrated: false,
            reasonCode: "fixture_uncalibrated",
          },
  };
  return new CoreDecisionEngine({
    backends: [backend],
    decisionPolicy: exactPolicy,
    confidencePolicy,
  });
}
function scoreReply(): (request: DecisionRequest) => BackendPrediction {
  return (request) => ({
    value: {
      kind: "score",
      scores: (request.candidates ?? []).map((candidate) => ({
        id: candidate.id,
        score: candidate.features?.path === "src/target.ts" ? 1 : 0.5,
      })),
    },
  });
}

describe("ContextRankingPolicy adversarial fixtures", () => {
  for (const fixture of fixtures.cases.filter((item) => item.name !== "ambiguous task")) {
    it(`places the highest relevance file first: ${fixture.name}`, async () => {
      const expected = fixture.candidates.find((candidate) => candidate.gold === 3)?.path;
      const result = await new ContextRankingPolicy().rank(inputFor(fixture));
      expect(result.ranked[0]?.path).toBe(expected);
      expect(result.ranked).toHaveLength(fixture.candidates.length);
      expect(result.metadata.strategy).toBe("deterministic");
      expect(result.confidence).toBeNull();
      expect(result.calibrated).toBe(false);
    });
  }

  it("preserves all candidates and reports uncertainty for an ambiguous task", async () => {
    const fixture = fixtures.cases.find((item) => item.name === "ambiguous task")!;
    const result = await new ContextRankingPolicy().rank(inputFor(fixture));
    expect(result.ranked).toHaveLength(fixture.candidates.length);
    expect(result.metadata.reasonCode).toBe("ambiguous_task");
    expect(result.confidence).toBeNull();
  });

  it("scores 20 candidates in bounded groups and retains calibrated backend provenance", async () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      metadata({
        path: i === 19 ? "src/target.ts" : `src/item-${i}.ts`,
        symbols: [{ name: i === 19 ? "refreshTarget" : `item${i}`, kind: "function" }],
        imports: [],
        retrievalScore: 0.5,
        gold: i === 19 ? 3 : 0,
      }),
    );
    candidates[0] = { ...candidates[0]!, description: "SOURCE_CONTENT_SENTINEL" };
    const backend = new FakeBackend();
    backend.enqueue(scoreReply());
    backend.enqueue(scoreReply());
    const policy = new ContextRankingPolicy({
      engine: scoringEngine(backend, true),
      strategy: "score",
    });
    const result = await policy.rank({ task: "refresh target implementation", candidates });
    expect(result.ranked[0]?.path).toBe("src/target.ts");
    expect(result.metadata).toMatchObject({
      strategy: "grouped_score",
      reasonCode: "calibrated_backend_scores",
    });
    expect(result.metadata.requestCount).toBe(2);
    expect(result.backend?.id).toBe("fake");
    expect(result.confidence).toBe(0.72);
    expect(result.calibrated).toBe(true);
    expect(backend.calls.map((call) => call.request.candidates?.length)).toEqual([16, 4]);
    for (const call of backend.calls) {
      expect(call.request.dataClasses).toEqual(["task", "paths", "summaries"]);
      expect(JSON.stringify(call.request)).not.toContain("SOURCE_CONTENT_SENTINEL");
      expect(
        call.request.candidates?.every((item) =>
          Object.keys(item).every((key) =>
            ["id", "label", "features", "contentFingerprint"].includes(key),
          ),
        ),
      ).toBe(true);
    }
  });

  it("does not treat a maximum backend score as calibrated confidence", async () => {
    const backend = new FakeBackend();
    backend.enqueue(scoreReply());
    const fixture = fixtures.cases[0]!;
    const policy = new ContextRankingPolicy({
      engine: scoringEngine(backend, false),
      strategy: "score",
    });
    const result = await policy.rank(inputFor(fixture));
    expect(result.metadata.strategy).toBe("deterministic");
    expect(result.confidence).toBeNull();
    expect(result.backend).toBeUndefined();
  });

  it("returns uncalibrated scores only as an advisory in advisory mode", async () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      metadata({
        path: i === 19 ? "src/target.ts" : `src/item-${i}.ts`,
        symbols: [{ name: `item${i}`, kind: "function" }],
        imports: [],
        retrievalScore: 0.5,
        gold: 0,
      }),
    );
    const baseline = await new ContextRankingPolicy().rank({ task: "update item0", candidates });
    const backend = new FakeBackend();
    backend.enqueue(scoreReply());
    backend.enqueue(scoreReply());
    const policy = new ContextRankingPolicy({
      engine: scoringEngine(backend, false),
      strategy: "score",
      uncalibratedScores: "advisory",
    });
    const result = await policy.rank({ task: "update item0", candidates });
    expect(result.ranked.map((item) => item.path)).toEqual(
      baseline.ranked.map((item) => item.path),
    );
    expect(result.ranked.every((item) => item.source === "deterministic")).toBe(true);
    expect(result.confidence).toBeNull();
    expect(result.calibrated).toBe(false);
    expect(result.backend).toBeUndefined();
    expect(result.metadata).toMatchObject({
      strategy: "deterministic",
      reasonCode: "uncalibrated_backend_advisory",
      requestCount: 2,
    });
    expect(result.advisory).toMatchObject({
      backend: { id: "fake" },
      calibrated: false,
      reasonCode: "fixture_uncalibrated",
    });
    expect(result.advisory?.scores).toHaveLength(20);
    expect(result.advisory?.scores.find((item) => item.path === "src/target.ts")?.score).toBe(1);
  });

  it("omits the advisory when any score group fails", async () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      metadata({
        path: `src/file-${i}.ts`,
        symbols: [],
        imports: [],
        retrievalScore: 0.5,
        gold: 0,
      }),
    );
    const backend = new FakeBackend();
    backend.enqueue(scoreReply());
    const policy = new ContextRankingPolicy({
      engine: scoringEngine(backend, false),
      strategy: "score",
      uncalibratedScores: "advisory",
    });
    const result = await policy.rank({ task: "update file routing", candidates });
    expect(result.advisory).toBeUndefined();
    expect(result.metadata.reasonCode).not.toBe("uncalibrated_backend_advisory");
  });

  it("keeps a remote backend unused without explicit data permission", async () => {
    const backend = new FakeBackend({ capabilities: { locality: "remote" } });
    backend.enqueue(scoreReply());
    const policy = new ContextRankingPolicy({
      engine: scoringEngine(backend, true),
      strategy: "score",
    });
    const result = await policy.rank(inputFor(fixtures.cases[0]!));
    expect(result.metadata.reasonCode).toBe("privacy_denied");
    expect(result.metadata.strategy).toBe("deterministic");
    expect(backend.calls).toHaveLength(0);
  });

  it("falls back to the full deterministic ordering if a later score group fails", async () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      metadata({
        path: `src/file-${i}.ts`,
        symbols: [],
        imports: [],
        retrievalScore: 0.5,
        gold: 0,
      }),
    );
    const backend = new FakeBackend();
    backend.enqueue(scoreReply());
    const policy = new ContextRankingPolicy({
      engine: scoringEngine(backend, true),
      strategy: "score",
    });
    const result = await policy.rank({ task: "update file routing", candidates });
    expect(result.ranked).toHaveLength(20);
    expect(result.ranked.every((item) => item.source === "deterministic")).toBe(true);
    expect(result.confidence).toBeNull();
    expect(result.metadata.requestCount).toBe(2);
  });

  it("passes generated compact descriptions through core request validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "thinktrim-ranker-test-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(
        path.join(root, "src", "jwt.ts"),
        "export function verifyJwt() { return true; }\n",
      );
      const index = await indexWorkspace(root);
      const generated = generateCandidates(index, "verify JWT token");
      expect(generated.candidates).toHaveLength(1);
      expect(generated.candidates[0]?.label).not.toContain("\n");
      expect(() =>
        validateRequest({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          id: "ranker-generated-candidates",
          category: "context_ranking",
          kind: "score",
          task: "verify JWT token",
          candidates: generated.candidates,
          dataClasses: ["task", "paths", "summaries"],
          constraints: {
            locality: "local_only",
            allowedRemoteData: [],
            profile: "safe",
            deadlineMs: 1000,
            maxCandidates: 10,
          },
        }),
      ).not.toThrow();
    } finally {
      if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
