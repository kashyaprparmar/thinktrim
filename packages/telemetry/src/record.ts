import { randomUUID } from "node:crypto";
import type { DecisionResult, DecisionTraceStage } from "@thinktrim/core";

export const LOCAL_TRACE_SCHEMA_VERSION = 1 as const;
export type TraceHost = "claude-code" | "codex" | "cursor" | "vscode" | "cli" | "mcp" | "other";
export type TracePlacement = "pre_read" | "post_read" | "unknown";
export type TraceCategory =
  | "context_ranking"
  | "context_sufficiency"
  | "test_selection"
  | "failure_classification"
  | "retry_gate"
  | "backend_routing"
  | "other";
export type TraceBackend = "laya-local" | "laya-http-local" | "jev-openrouter" | "other";

export interface CandidateCounts {
  readonly retrieved: number;
  readonly ranked: number;
  readonly selected: number;
}

export interface MeasuredFrontierUsage {
  /** Counts must be returned by the host or its provider for this actual run. */
  readonly source: "host_reported" | "provider_reported";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface LocalTraceInput {
  readonly host: TraceHost;
  readonly placement: TracePlacement;
  readonly result: DecisionResult;
  readonly candidateCounts: CandidateCounts;
  readonly measuredFrontierUsage?: MeasuredFrontierUsage;
}

export interface LocalTraceRecord {
  readonly schemaVersion: typeof LOCAL_TRACE_SCHEMA_VERSION;
  readonly traceId: string;
  readonly recordedAt: string;
  readonly host: TraceHost;
  readonly placement: TracePlacement;
  readonly category: TraceCategory;
  readonly kind: DecisionResult["trace"]["kind"];
  readonly outcome: DecisionResult["outcome"];
  readonly provenance: DecisionResult["provenance"];
  readonly backend: TraceBackend | null;
  readonly latencyMs: number;
  readonly candidateCounts: CandidateCounts;
  readonly confidence: number | null;
  readonly calibrated: boolean;
  readonly cacheHit: boolean;
  readonly escalated: boolean;
  readonly usage: {
    readonly decisionBackend?: {
      readonly unit: "tokens" | "requests" | "other";
      readonly inputUnits?: number;
      readonly outputUnits?: number;
    };
    readonly measuredFrontier?: MeasuredFrontierUsage;
  };
  readonly stages: readonly {
    readonly name: DecisionTraceStage["name"];
    readonly durationMs: number;
  }[];
}

const CATEGORIES: readonly TraceCategory[] = [
  "context_ranking",
  "context_sufficiency",
  "test_selection",
  "failure_classification",
  "retry_gate",
  "backend_routing",
  "other",
];
const HOSTS: readonly TraceHost[] = [
  "claude-code",
  "codex",
  "cursor",
  "vscode",
  "cli",
  "mcp",
  "other",
];
const PLACEMENTS: readonly TracePlacement[] = ["pre_read", "post_read", "unknown"];
const BACKENDS: readonly TraceBackend[] = [
  "laya-local",
  "laya-http-local",
  "jev-openrouter",
  "other",
];
const KINDS = ["binary", "choice", "score", "ranking", "invalid"] as const;
const OUTCOMES = ["accept", "reject", "retrieve_more", "escalate", "unknown"] as const;
const PROVENANCES = ["deterministic", "backend", "fallback"] as const;
const STAGES: readonly DecisionTraceStage["name"][] = [
  "validation",
  "exact_policy",
  "routing",
  "health",
  "prediction",
  "confidence",
  "cache",
];
const MAX_COUNT = 1_000_000_000;
const MAX_DURATION_MS = 86_400_000;

function member<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}

function count(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) {
    throw new TypeError(`${name} must be a nonnegative bounded integer`);
  }
  return value;
}

function duration(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_DURATION_MS
  ) {
    throw new TypeError(`${name} must be a nonnegative bounded duration`);
  }
  return value;
}

function candidateCounts(value: CandidateCounts): CandidateCounts {
  const retrieved = count(value?.retrieved, "retrieved");
  const ranked = count(value?.ranked, "ranked");
  const selected = count(value?.selected, "selected");
  if (selected > ranked || ranked > retrieved) {
    throw new TypeError("Candidate counts must satisfy selected <= ranked <= retrieved");
  }
  return { retrieved, ranked, selected };
}

function measuredUsage(value: MeasuredFrontierUsage): MeasuredFrontierUsage {
  if (value.source !== "host_reported" && value.source !== "provider_reported") {
    throw new TypeError("Measured frontier usage requires a reporting source");
  }
  if (value.inputTokens === undefined && value.outputTokens === undefined) {
    throw new TypeError("Measured frontier usage requires at least one token count");
  }
  return {
    source: value.source,
    ...(value.inputTokens === undefined
      ? {}
      : { inputTokens: count(value.inputTokens, "inputTokens") }),
    ...(value.outputTokens === undefined
      ? {}
      : { outputTokens: count(value.outputTokens, "outputTokens") }),
  };
}

/** Allowlisted projection: task, source, paths, request IDs, error text, and free-form reasons are never copied. */
export function createLocalTraceRecord(input: LocalTraceInput): LocalTraceRecord {
  const { result } = input;
  if (!member(input.host, HOSTS) || !member(input.placement, PLACEMENTS)) {
    throw new TypeError("Invalid trace host or placement");
  }
  if (
    !member(result.trace.kind, KINDS) ||
    !member(result.outcome, OUTCOMES) ||
    !member(result.provenance, PROVENANCES) ||
    typeof result.trace.cacheHit !== "boolean" ||
    !Array.isArray(result.trace.stages) ||
    result.trace.stages.length > 32
  ) {
    throw new TypeError("Invalid decision trace metadata");
  }
  const confidence =
    result.calibrated &&
    result.confidence !== null &&
    typeof result.confidence === "number" &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 0 &&
    result.confidence <= 1
      ? result.confidence
      : null;
  const stages = result.trace.stages.map((stage) => {
    if (!member(stage.name, STAGES)) throw new TypeError("Invalid trace stage");
    return { name: stage.name, durationMs: duration(stage.durationMs, "stage duration") };
  });
  const category = member(result.trace.category, CATEGORIES) ? result.trace.category : "other";
  const backend =
    result.backend === undefined
      ? null
      : member(result.backend.id, BACKENDS)
        ? result.backend.id
        : "other";
  const decisionBackend =
    result.usage === undefined
      ? undefined
      : {
          unit: (result.usage.unit === "tokens" || result.usage.unit === "requests"
            ? result.usage.unit
            : "other") as "tokens" | "requests" | "other",
          ...(result.usage.inputUnits === undefined
            ? {}
            : { inputUnits: count(result.usage.inputUnits, "inputUnits") }),
          ...(result.usage.outputUnits === undefined
            ? {}
            : { outputUnits: count(result.usage.outputUnits, "outputUnits") }),
        };
  return {
    schemaVersion: LOCAL_TRACE_SCHEMA_VERSION,
    traceId: randomUUID(),
    recordedAt: new Date().toISOString(),
    host: input.host,
    placement: input.placement,
    category,
    kind: result.trace.kind,
    outcome: result.outcome,
    provenance: result.provenance,
    backend,
    latencyMs: duration(result.latencyMs, "decision latency"),
    candidateCounts: candidateCounts(input.candidateCounts),
    confidence,
    calibrated: confidence !== null,
    cacheHit: result.trace.cacheHit,
    escalated: result.outcome === "escalate",
    usage: {
      ...(decisionBackend === undefined ? {} : { decisionBackend }),
      ...(input.measuredFrontierUsage === undefined
        ? {}
        : {
            measuredFrontier: measuredUsage(input.measuredFrontierUsage),
          }),
    },
    stages,
  };
}
