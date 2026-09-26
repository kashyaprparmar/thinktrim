import { CONTRACT_SCHEMA_VERSION, createCandidateId } from "@thinktrim/shared";
import type {
  BackendIdentity,
  DataLocality,
  DecisionEngine,
  DecisionRequest,
  RemoteDataClass,
} from "@thinktrim/core";
import { FAILURE_CATEGORIES } from "./failure-classification.js";
import type { FailureCategory } from "./failure-classification.js";

export type RetryOperationType = "read" | "write" | "destructive" | "unknown";
export type RetryIdempotency = "idempotent" | "idempotency_key" | "non_idempotent" | "unknown";
export type RetrySideEffectRisk = "low" | "medium" | "high";

export interface PreviousOperationResult {
  readonly status: "failed" | "succeeded" | "unknown";
  readonly failureCategory?: FailureCategory;
  readonly idempotencyKey?: string;
}

export interface RetryPolicyInput {
  readonly failureCategory: FailureCategory;
  /** One-based count of the attempt that just failed. */
  readonly attempt: number;
  readonly previousResult?: PreviousOperationResult;
  readonly operationType: RetryOperationType;
  readonly idempotency: RetryIdempotency;
  readonly idempotencyKey?: string;
  readonly sideEffectRisk: RetrySideEffectRisk;
  readonly retryAfterMs?: number;
  readonly locality?: DataLocality;
  readonly allowedRemoteData?: readonly RemoteDataClass[];
}

export interface RetryPolicyOptions {
  readonly engine?: DecisionEngine;
  readonly maxAttempts?: number;
  readonly minimumConfidence?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface RetryPolicyResult {
  readonly action: "retry" | "stop" | "escalate";
  readonly automatic: boolean;
  readonly nextDelayMs?: number;
  readonly reasonCode: string;
  readonly source: "deterministic" | "backend";
  readonly confidence: number | null;
  readonly calibrated: boolean;
  readonly backend?: BackendIdentity;
}

const TRANSIENT_FAILURES = new Set<FailureCategory>(["network_error", "timeout", "rate_limit"]);

export class RetryPolicy {
  private readonly engine: DecisionEngine | undefined;
  private readonly maxAttempts: number;
  private readonly minimumConfidence: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: RetryPolicyOptions = {}) {
    this.engine = options.engine;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.minimumConfidence = options.minimumConfidence ?? 0.8;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 10) {
      throw new RangeError("maxAttempts must be between 1 and 10");
    }
    if (
      !Number.isFinite(this.minimumConfidence) ||
      this.minimumConfidence <= 0 ||
      this.minimumConfidence > 1
    ) {
      throw new RangeError("minimumConfidence must be in (0, 1]");
    }
    if (
      !Number.isSafeInteger(this.baseDelayMs) ||
      this.baseDelayMs < 0 ||
      this.baseDelayMs > 60_000 ||
      !Number.isSafeInteger(this.maxDelayMs) ||
      this.maxDelayMs < 0 ||
      this.maxDelayMs > 120_000 ||
      this.maxDelayMs < this.baseDelayMs
    ) {
      throw new RangeError("retry delay settings are invalid");
    }
  }

  async evaluate(input: RetryPolicyInput, signal?: AbortSignal): Promise<RetryPolicyResult> {
    this.validateInput(input);
    const stop = (reasonCode: string): RetryPolicyResult => ({
      action: "stop",
      automatic: false,
      reasonCode,
      source: "deterministic",
      confidence: null,
      calibrated: false,
    });

    // Deterministic safety constraints always run before inference.
    if (input.previousResult?.status === "succeeded") return stop("previous_attempt_succeeded");
    if (input.previousResult?.status === "unknown") {
      return { ...stop("previous_result_unknown"), action: "escalate" };
    }
    if (signal?.aborted) return stop("cancelled");
    if (input.attempt >= this.maxAttempts) return stop("attempt_limit_reached");
    if (input.operationType === "destructive") return stop("destructive_operation");
    if (input.operationType === "unknown") return stop("operation_type_unknown");
    if (input.sideEffectRisk === "high") return stop("high_side_effect_risk");
    if (input.idempotency === "non_idempotent" || input.idempotency === "unknown") {
      return stop("operation_not_proven_idempotent");
    }
    if (input.idempotency === "idempotency_key") {
      if (!input.idempotencyKey) return stop("idempotency_key_missing");
      if (input.previousResult?.idempotencyKey === undefined) {
        return stop("previous_attempt_key_unverified");
      }
      if (input.previousResult.idempotencyKey !== input.idempotencyKey) {
        return stop("idempotency_key_changed");
      }
    }
    if (!TRANSIENT_FAILURES.has(input.failureCategory)) {
      return stop("failure_not_retryable");
    }
    if (
      input.previousResult?.failureCategory &&
      input.previousResult.failureCategory === "unknown"
    ) {
      return { ...stop("previous_failure_unknown"), action: "escalate" };
    }

    const exponentialDelay = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** Math.max(0, input.attempt - 1),
    );
    if (input.retryAfterMs !== undefined && input.retryAfterMs > this.maxDelayMs) {
      return stop("retry_after_exceeds_policy_limit");
    }
    const nextDelayMs = Math.max(exponentialDelay, input.retryAfterMs ?? 0);
    if (!this.engine) {
      return {
        action: "retry",
        automatic: true,
        nextDelayMs,
        reasonCode: "safe_transient_failure",
        source: "deterministic",
        confidence: null,
        calibrated: false,
      };
    }

    const candidates = [
      { id: createCandidateId("retry:yes"), label: "retry" },
      { id: createCandidateId("retry:no"), label: "stop" },
    ] as const;
    const locality = input.locality ?? "local_only";
    const allowedRemoteData = input.allowedRemoteData ?? [];
    const request: DecisionRequest<"choice"> = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id: `retry-gate-${crypto.randomUUID()}`,
      category: "retry_gate",
      kind: "choice",
      task: "For this already safety-checked transient failure, should the caller retry the same operation?",
      candidates,
      evidence: [
        `failure category: ${input.failureCategory}`,
        `attempt: ${input.attempt} of ${this.maxAttempts}`,
        `operation type: ${input.operationType}`,
        `idempotency: ${input.idempotency}`,
        `side effect risk: ${input.sideEffectRisk}`,
        ...(input.previousResult?.failureCategory
          ? [`previous failure category: ${input.previousResult.failureCategory}`]
          : []),
      ],
      dataClasses: ["task", "summaries"],
      constraints: {
        locality,
        allowedRemoteData,
        profile: "safe",
        deadlineMs: 10_000,
        maxCandidates: 2,
      },
    };
    try {
      const result = await this.engine.decide(request, signal);
      const value = result.value;
      const selected =
        value?.kind === "choice"
          ? candidates.find((candidate) => candidate.id === value.selectedId)
          : undefined;
      if (
        result.outcome === "accept" &&
        result.provenance === "backend" &&
        result.requestId === request.id &&
        result.calibrated &&
        result.confidence !== null &&
        result.confidence >= this.minimumConfidence &&
        selected
      ) {
        return {
          action: selected.label === "retry" ? "retry" : "stop",
          automatic: selected.label === "retry",
          ...(selected.label === "retry" ? { nextDelayMs } : {}),
          reasonCode:
            selected.label === "retry" ? "backend_approved_safe_retry" : "backend_vetoed_retry",
          source: "backend",
          confidence: result.confidence,
          calibrated: true,
          ...(result.backend === undefined ? {} : { backend: result.backend }),
        };
      }
    } catch {
      // The deterministic gate below is safe for this already-eligible operation.
    }
    return {
      action: "retry",
      automatic: true,
      nextDelayMs,
      reasonCode: "safe_transient_fallback",
      source: "deterministic",
      confidence: null,
      calibrated: false,
    };
  }

  private validateInput(input: RetryPolicyInput): void {
    if (!FAILURE_CATEGORIES.includes(input.failureCategory)) {
      throw new TypeError("failureCategory is invalid");
    }
    if (!(["read", "write", "destructive", "unknown"] as const).includes(input.operationType)) {
      throw new TypeError("operationType is invalid");
    }
    if (
      !(["idempotent", "idempotency_key", "non_idempotent", "unknown"] as const).includes(
        input.idempotency,
      )
    ) {
      throw new TypeError("idempotency is invalid");
    }
    if (!(["low", "medium", "high"] as const).includes(input.sideEffectRisk)) {
      throw new TypeError("sideEffectRisk is invalid");
    }
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 10_000) {
      throw new RangeError("attempt must be a positive integer");
    }
    if (
      input.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(input.retryAfterMs) || input.retryAfterMs < 0)
    ) {
      throw new RangeError("retryAfterMs must be a non-negative integer");
    }
    if (
      input.idempotencyKey !== undefined &&
      (!input.idempotencyKey.trim() ||
        input.idempotencyKey.length > 256 ||
        /[\r\n\0]/.test(input.idempotencyKey))
    ) {
      throw new TypeError("idempotencyKey is invalid");
    }
    if (input.locality === "local_only" && (input.allowedRemoteData?.length ?? 0) > 0) {
      throw new TypeError("local_only cannot permit remote data");
    }
    if (
      input.allowedRemoteData &&
      (new Set(input.allowedRemoteData).size !== input.allowedRemoteData.length ||
        input.allowedRemoteData.some((item) => !["task", "summaries"].includes(item)))
    ) {
      throw new TypeError("allowedRemoteData is invalid");
    }
    if (
      input.previousResult &&
      !["failed", "succeeded", "unknown"].includes(input.previousResult.status)
    ) {
      throw new TypeError("previousResult is invalid");
    }
  }
}
