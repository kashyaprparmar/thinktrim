import { createHash } from "node:crypto";
import path from "node:path";
import { CONTRACT_SCHEMA_VERSION, isCandidateId } from "@thinktrim/shared";
import type {
  BackendIdentity,
  ConfidenceProfile,
  DataLocality,
  DecisionCandidate,
  DecisionEngine,
  DecisionRequest,
  RemoteDataClass,
  UsageMetadata,
} from "@thinktrim/core";
import type { CandidateMetadata } from "./index.js";

export interface ContextRankingInput {
  readonly task: string;
  readonly candidates: readonly CandidateMetadata[];
  readonly changedFiles?: readonly string[];
  /** Short facts or summaries already known to the caller; each is capped at 256 characters. */
  readonly currentEvidence?: readonly string[];
  readonly locality?: DataLocality;
  readonly allowedRemoteData?: readonly RemoteDataClass[];
  readonly profile?: ConfidenceProfile;
  /** Total deadline for all score groups. Defaults to 30 seconds. */
  readonly deadlineMs?: number;
}

export interface ContextRankingPolicyOptions {
  readonly engine?: DecisionEngine;
  /** Deterministic is the V1 default; opt into grouped score requests explicitly. */
  readonly strategy?: "deterministic" | "score";
  /** Provider score requests are limited to 16 candidates. Defaults to 16. */
  readonly batchSize?: number;
  /**
   * Valid but unaccepted or uncalibrated backend scores are discarded by default. `advisory`
   * returns them separately without changing the deterministic ordering.
   */
  readonly uncalibratedScores?: "discard" | "advisory";
  readonly now?: () => number;
}

export interface ContextRankingAdvisory {
  readonly backend: BackendIdentity;
  /** Raw backend scores in candidate input order; not calibrated probabilities. */
  readonly scores: readonly {
    readonly id: string;
    readonly path: string;
    readonly score: number;
  }[];
  readonly calibrated: false;
  readonly reasonCode: string;
}

export interface RankedContextCandidate {
  readonly id: string;
  readonly path: string;
  /** Bounded relevance signal, not calibrated probability. */
  readonly relevance: number;
  readonly source: "deterministic" | "backend";
  readonly signals: readonly string[];
}

export interface ContextRankingResult {
  readonly ranked: readonly RankedContextCandidate[];
  /** Calibrated only when every backend score group was accepted and calibrated. */
  readonly confidence: number | null;
  readonly calibrated: boolean;
  readonly backend?: BackendIdentity;
  /** Present only in advisory mode when every group returned valid uncalibrated scores. */
  readonly advisory?: ContextRankingAdvisory;
  readonly metadata: {
    readonly strategy: "deterministic" | "grouped_score";
    readonly reasonCode: string;
    readonly requestCount: number;
    readonly candidateCount: number;
    readonly ambiguousTask: boolean;
    readonly latencyMs: number;
    readonly usage?: UsageMetadata;
  };
}

interface HeuristicScore {
  readonly candidate: CandidateMetadata;
  readonly relevance: number;
  readonly signals: readonly string[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "bug",
  "by",
  "change",
  "code",
  "do",
  "file",
  "find",
  "fix",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "please",
  "the",
  "this",
  "to",
  "update",
  "where",
  "with",
]);

function tokens(text: string): string[] {
  return (
    text
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((term) => term.length > 1 || /\d/.test(term));
}

function safePath(value: string): boolean {
  if (
    !value ||
    value.length > 4096 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    }) ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  )
    return false;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.startsWith("/");
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  max: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) {
    throw new RangeError(`${name} must be between 1 and ${max}`);
  }
  return resolved;
}

function validateInput(input: ContextRankingInput): void {
  if (!input.task.trim() || input.task.length > 10_000) throw new TypeError("task is invalid");
  if (input.candidates.length > 40) throw new RangeError("at most 40 candidates are supported");
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (!isCandidateId(candidate.id) || seen.has(candidate.id) || !safePath(candidate.path)) {
      throw new TypeError("candidate ID or path is invalid");
    }
    seen.add(candidate.id);
    if (
      candidate.symbols.length > 200 ||
      candidate.symbols.some((item) => item.name.length > 256) ||
      candidate.imports.length > 200 ||
      candidate.imports.some((item) => item.specifier.length > 512) ||
      candidate.matchedTerms.length > 128 ||
      candidate.description.length > 512 ||
      candidate.contentFingerprint.length > 256 ||
      !Number.isFinite(candidate.score)
    )
      throw new TypeError("candidate metadata exceeds limits");
  }
  if (
    input.changedFiles &&
    (input.changedFiles.length > 100 || input.changedFiles.some((name) => !safePath(name)))
  ) {
    throw new TypeError("changedFiles contains an unsafe path");
  }
  if (
    input.currentEvidence &&
    (input.currentEvidence.length > 8 ||
      input.currentEvidence.some((entry) => !entry.trim() || entry.length > 256))
  )
    throw new TypeError("currentEvidence exceeds limits");
  boundedInteger(input.deadlineMs, 30_000, 120_000, "deadlineMs");
  if (input.locality === "local_only" && (input.allowedRemoteData?.length ?? 0) > 0) {
    throw new TypeError("local_only cannot permit remote data");
  }
}

function coverage(query: readonly string[], haystack: ReadonlySet<string>): number {
  if (!query.length) return 0;
  return query.filter((term) => haystack.has(term)).length / query.length;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function deterministicScore(
  candidate: CandidateMetadata,
  taskTerms: readonly string[],
  taskTokenSet: ReadonlySet<string>,
  changedPaths: ReadonlySet<string>,
  evidenceTerms: ReadonlySet<string>,
): HeuristicScore {
  const pathTerms = new Set(tokens(candidate.path));
  const symbolTerms = new Set(candidate.symbols.flatMap((symbol) => tokens(symbol.name)));
  const importTerms = new Set(candidate.imports.flatMap((item) => tokens(item.specifier)));
  const matchedTerms = new Set(candidate.matchedTerms);
  const pathMatch = coverage(taskTerms, pathTerms);
  const symbolMatch = coverage(taskTerms, symbolTerms);
  const importMatch = coverage(taskTerms, importTerms);
  const lexicalMatch = coverage(taskTerms, matchedTerms);
  const changed = changedPaths.has(candidate.path);
  const testFile = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[^/.]+$/i.test(
    candidate.path,
  );
  const testTask = ["test", "tests", "spec", "specs", "assertion", "failure"].some((term) =>
    taskTokenSet.has(term),
  );
  const generated = /(?:^|\/)(?:generated|gen|dist|build)(?:\/|$)|\.generated\.[^/.]+$/i.test(
    candidate.path,
  );
  const barrel = /(?:^|\/)(?:index\.[cm]?[jt]sx?|__init__\.py|mod\.rs)$/i.test(candidate.path);
  const legacy = /(?:^|\/)(?:legacy|old|deprecated)(?:\/|$)/i.test(candidate.path);
  const interfaceTask = ["interface", "contract", "signature", "type", "types"].some((term) =>
    taskTokenSet.has(term),
  );
  const interfaceFile = candidate.symbols.some(
    (symbol) => symbol.kind === "interface" || symbol.kind === "type",
  );
  const evidenceMatch = coverage([...evidenceTerms], new Set([...pathTerms, ...symbolTerms]));
  const signals: string[] = [];
  if (symbolMatch > 0) signals.push("symbol_match");
  if (pathMatch > 0) signals.push("path_match");
  if (importMatch > 0) signals.push("import_match");
  if (lexicalMatch > 0) signals.push("lexical_match");
  if (changed) signals.push("changed_file");
  if (testFile) signals.push(testTask ? "test_task" : "test_file");
  if (generated) signals.push("generated_file");
  if (barrel && symbolMatch === 0) signals.push("barrel_export");
  if (interfaceTask && interfaceFile) signals.push("interface_task");
  if (legacy && !taskTokenSet.has("legacy")) signals.push("legacy_file");
  const score =
    0.04 +
    0.38 * symbolMatch +
    0.25 * pathMatch +
    0.1 * importMatch +
    0.12 * lexicalMatch +
    0.07 * clamp(candidate.score) +
    0.12 * Number(changed) +
    0.05 * evidenceMatch +
    0.12 * Number(testFile && testTask) -
    0.1 * Number(testFile && !testTask) +
    0.12 * Number(interfaceTask && interfaceFile) -
    0.12 * Number(barrel && symbolMatch === 0) -
    0.35 * Number(generated) -
    0.16 * Number(legacy && !taskTokenSet.has("legacy"));
  return { candidate, relevance: clamp(score), signals };
}

function compactCandidate(item: CandidateMetadata, changed: boolean): DecisionCandidate {
  const label = [
    item.path,
    `Symbols: ${
      item.symbols
        .slice(0, 5)
        .map((symbol) => symbol.name.slice(0, 64))
        .join(", ") || "none"
    }`,
    `Imports: ${
      item.imports
        .slice(0, 6)
        .map((entry) => entry.specifier.slice(0, 64))
        .join(", ") || "none"
    }`,
    `Matched terms: ${
      item.matchedTerms
        .slice(0, 8)
        .map((term) => term.slice(0, 40))
        .join(", ") || "none"
    }`,
  ]
    .join(" | ")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, 512);
  return {
    id: item.id as DecisionCandidate["id"],
    label,
    features: {
      path: item.path,
      language: item.language ?? "unknown",
      changed,
      symbols: item.symbols
        .slice(0, 6)
        .map((symbol) => symbol.name.slice(0, 64))
        .join(", "),
      imports: item.imports
        .slice(0, 6)
        .map((entry) => entry.specifier.slice(0, 64))
        .join(", "),
    },
    contentFingerprint: item.contentFingerprint,
  };
}

function sameBackend(a: BackendIdentity, b: BackendIdentity): boolean {
  return a.id === b.id && a.modelVersion === b.modelVersion && a.locality === b.locality;
}

export class ContextRankingPolicy {
  private readonly engine: DecisionEngine | undefined;
  private readonly strategy: "deterministic" | "score";
  private readonly batchSize: number;
  private readonly uncalibratedScores: "discard" | "advisory";
  private readonly now: () => number;

  constructor(options: ContextRankingPolicyOptions = {}) {
    this.engine = options.engine;
    this.strategy = options.strategy ?? "deterministic";
    this.batchSize = boundedInteger(options.batchSize, 16, 16, "batchSize");
    this.uncalibratedScores = options.uncalibratedScores ?? "discard";
    this.now = options.now ?? (() => performance.now());
  }

  async rank(input: ContextRankingInput, signal?: AbortSignal): Promise<ContextRankingResult> {
    validateInput(input);
    const started = this.now();
    const taskTerms = [...new Set(tokens(input.task).filter((term) => !STOP_WORDS.has(term)))];
    const taskTokenSet = new Set(tokens(input.task));
    const changedPaths = new Set(
      (input.changedFiles ?? []).map((name) => name.replaceAll("\\", "/")),
    );
    const evidenceTerms = new Set((input.currentEvidence ?? []).flatMap(tokens));
    const heuristic = input.candidates.map((candidate) =>
      deterministicScore(candidate, taskTerms, taskTokenSet, changedPaths, evidenceTerms),
    );
    const ambiguousTask = taskTerms.length === 0;
    const deadlineMs = input.deadlineMs ?? 30_000;
    let requestCount = 0;
    const finish = (
      scores: ReadonlyMap<string, number> | undefined,
      reasonCode: string,
      confidence: number | null,
      backend?: BackendIdentity,
      usage?: UsageMetadata,
      advisory?: ContextRankingAdvisory,
    ): ContextRankingResult => {
      const ranked = heuristic
        .map((item): RankedContextCandidate => ({
          id: item.candidate.id,
          path: item.candidate.path,
          relevance: scores?.get(item.candidate.id) ?? item.relevance,
          source: scores ? "backend" : "deterministic",
          signals: item.signals,
        }))
        .sort((left, right) => {
          const primary = right.relevance - left.relevance;
          if (primary !== 0) return primary;
          const leftHeuristic =
            heuristic.find((entry) => entry.candidate.id === left.id)?.relevance ?? 0;
          const rightHeuristic =
            heuristic.find((entry) => entry.candidate.id === right.id)?.relevance ?? 0;
          return rightHeuristic - leftHeuristic || left.path.localeCompare(right.path);
        });
      return {
        ranked,
        confidence,
        calibrated: confidence !== null,
        ...(backend === undefined ? {} : { backend }),
        ...(advisory === undefined ? {} : { advisory }),
        metadata: {
          strategy: scores ? "grouped_score" : "deterministic",
          reasonCode,
          requestCount,
          candidateCount: ranked.length,
          ambiguousTask,
          latencyMs: Math.max(0, this.now() - started),
          ...(usage === undefined ? {} : { usage }),
        },
      };
    };

    if (!input.candidates.length) return finish(undefined, "no_candidates", null);
    if (ambiguousTask) return finish(undefined, "ambiguous_task", null);
    if (this.strategy === "deterministic") return finish(undefined, "deterministic_baseline", null);
    if (!this.engine) return finish(undefined, "engine_unavailable", null);
    if (signal?.aborted) return finish(undefined, "cancelled", null);

    const scoreById = new Map<string, number>();
    const batchConfidences: number[] = [];
    let backend: BackendIdentity | undefined;
    let advisoryReason: string | undefined;
    let usageUnit: string | undefined;
    let inputUnits = 0;
    let outputUnits = 0;
    const requestPrefix = createHash("sha256")
      .update(input.task)
      .update(input.candidates.map((item) => item.id).join("\n"))
      .digest("hex")
      .slice(0, 24);
    for (let offset = 0; offset < input.candidates.length; offset += this.batchSize) {
      const remaining = Math.floor(deadlineMs - (this.now() - started));
      if (remaining < 1 || signal?.aborted) return finish(undefined, "deadline_or_cancelled", null);
      const group = input.candidates.slice(offset, offset + this.batchSize);
      const request: DecisionRequest<"score"> = {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        id: `context-${requestPrefix}-${offset}`,
        category: "context_ranking",
        kind: "score",
        task: input.task,
        candidates: group.map((item) => compactCandidate(item, changedPaths.has(item.path))),
        ...(input.currentEvidence?.length ? { evidence: input.currentEvidence } : {}),
        dataClasses: ["task", "paths", "summaries"],
        constraints: {
          locality: input.locality ?? "local_only",
          allowedRemoteData: input.allowedRemoteData ?? [],
          profile: input.profile ?? "safe",
          deadlineMs: remaining,
          maxCandidates: group.length,
          maxOutputItems: group.length,
        },
      };
      requestCount++;
      let result;
      try {
        result = await this.engine.decide(request, signal);
      } catch {
        return finish(undefined, "engine_failure", null);
      }
      if (signal?.aborted || this.now() - started >= deadlineMs) {
        return finish(undefined, "deadline_or_cancelled", null);
      }
      const accepted =
        result.outcome === "accept" &&
        result.calibrated &&
        typeof result.confidence === "number" &&
        Number.isFinite(result.confidence) &&
        result.confidence >= 0 &&
        result.confidence <= 1;
      if (
        (!accepted && this.uncalibratedScores === "discard") ||
        result.provenance !== "backend" ||
        result.value?.kind !== "score" ||
        !Array.isArray(result.value.scores) ||
        !result.backend
      )
        return finish(undefined, result.error?.code ?? result.outcome, null);
      if (backend && !sameBackend(backend, result.backend)) {
        return finish(undefined, "mixed_backends", null);
      }
      backend = result.backend;
      if (accepted) batchConfidences.push(result.confidence as number);
      else advisoryReason ??= result.trace.reasonCode || result.outcome;
      const expected = new Set(group.map((item) => item.id));
      for (const item of result.value.scores) {
        if (
          !expected.delete(item.id) ||
          !Number.isFinite(item.score) ||
          item.score < 0 ||
          item.score > 1
        ) {
          return finish(undefined, "invalid_scores", null);
        }
        scoreById.set(item.id, item.score);
      }
      if (expected.size) return finish(undefined, "incomplete_scores", null);
      if (result.usage) {
        if (usageUnit && usageUnit !== result.usage.unit)
          return finish(undefined, "mixed_usage_units", null);
        usageUnit = result.usage.unit;
        inputUnits += result.usage.inputUnits ?? 0;
        outputUnits += result.usage.outputUnits ?? 0;
      }
    }
    const usage = usageUnit ? { unit: usageUnit, inputUnits, outputUnits } : undefined;
    if (advisoryReason !== undefined && backend) {
      // Some group was not accepted: keep the deterministic ordering and expose raw scores only.
      return finish(undefined, "uncalibrated_backend_advisory", null, undefined, usage, {
        backend,
        scores: input.candidates.map((item) => ({
          id: item.id,
          path: item.path,
          score: scoreById.get(item.id) ?? 0,
        })),
        calibrated: false,
        reasonCode: advisoryReason,
      });
    }
    return finish(
      scoreById,
      "calibrated_backend_scores",
      Math.min(...batchConfidences),
      backend,
      usage,
    );
  }
}
