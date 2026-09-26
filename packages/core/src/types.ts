import type { CandidateId } from "@thinktrim/shared";
import { CONTRACT_SCHEMA_VERSION } from "@thinktrim/shared";

export type DecisionKind = "binary" | "choice" | "score" | "ranking";
export type DecisionOutcome = "accept" | "reject" | "retrieve_more" | "escalate" | "unknown";
export type DataLocality = "local_only" | "remote_allowed";
export type RemoteDataClass = "task" | "paths" | "summaries" | "snippets";
export type ConfidenceProfile = "safe" | "balanced" | "aggressive";
export type DecisionRisk = "low" | "medium" | "high";
export type BackendHealth = "healthy" | "degraded" | "unavailable";
export type BackendRoutingMode = "local" | "remote" | "auto";

export interface BackendRoutingPreference {
  readonly mode?: BackendRoutingMode;
  /** Exact backend ID. No fallback unless fallback is explicitly permitted. */
  readonly backendId?: string;
  readonly fallback?: "none" | "permitted";
  readonly networkAvailable?: boolean;
  readonly localPreference?: boolean;
  readonly optimizeFor?: "none" | "latency" | "quality";
  readonly language?: string;
}

export interface DecisionCandidate {
  readonly id: CandidateId;
  readonly label?: string;
  readonly features?: Readonly<Record<string, string | number | boolean>>;
  readonly contentFingerprint?: string;
}

export interface DecisionConstraints {
  readonly locality: DataLocality;
  readonly allowedRemoteData: readonly RemoteDataClass[];
  readonly profile: ConfidenceProfile;
  /** Total time budget for all backend attempts, including health checks. */
  readonly deadlineMs: number;
  readonly maxCandidates: number;
  readonly maxOutputItems?: number;
  readonly routing?: BackendRoutingPreference;
}

interface DecisionRequestBase {
  readonly schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  readonly id: string;
  readonly category: string;
  readonly task: string;
  readonly evidence?: readonly string[];
  /** Describes the data present in this request; the task class is always required. */
  readonly dataClasses: readonly RemoteDataClass[];
  readonly constraints: DecisionConstraints;
  readonly repositoryState?: string;
}

export interface DecisionRequestMap {
  binary: DecisionRequestBase & {
    readonly kind: "binary";
    readonly candidates?: readonly DecisionCandidate[];
  };
  choice: DecisionRequestBase & {
    readonly kind: "choice";
    readonly candidates: readonly DecisionCandidate[];
  };
  score: DecisionRequestBase & {
    readonly kind: "score";
    readonly candidates: readonly DecisionCandidate[];
  };
  ranking: DecisionRequestBase & {
    readonly kind: "ranking";
    readonly candidates: readonly DecisionCandidate[];
  };
}

export type DecisionRequest<K extends DecisionKind = DecisionKind> = DecisionRequestMap[K];

export interface BinaryDecision {
  readonly kind: "binary";
  readonly value: boolean;
}

export interface ChoiceDecision {
  readonly kind: "choice";
  readonly selectedId: CandidateId;
}

export interface ScoreDecision {
  readonly kind: "score";
  readonly scores: readonly { readonly id: CandidateId; readonly score: number }[];
}

export interface RankingDecision {
  readonly kind: "ranking";
  readonly orderedIds: readonly CandidateId[];
}

export interface DecisionValueMap {
  binary: BinaryDecision;
  choice: ChoiceDecision;
  score: ScoreDecision;
  ranking: RankingDecision;
}

export type DecisionValue<K extends DecisionKind = DecisionKind> = DecisionValueMap[K];

export interface BackendCapabilities {
  readonly id: string;
  readonly schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  readonly modelVersion: string;
  readonly kinds: readonly DecisionKind[];
  readonly categories?: readonly string[];
  readonly locality: "local" | "remote";
  readonly maxInputBytes: number;
  readonly maxCandidates: number;
  readonly supportsBatch: boolean;
  readonly supportsCancellation: boolean;
}

export interface BackendIdentity {
  readonly id: string;
  readonly modelVersion: string;
  readonly locality: "local" | "remote";
}

export interface UsageMetadata {
  readonly unit: string;
  readonly inputUnits?: number;
  readonly outputUnits?: number;
}

export interface BackendPrediction<K extends DecisionKind = DecisionKind> {
  readonly value: DecisionValue<K>;
  /** For binary decisions, P(true); for choice, the selected option's raw confidence.
   * The core never interprets this as calibrated confidence. */
  readonly rawSignal?: number;
  readonly usage?: UsageMetadata;
  /** Provider adapters may retain non-sensitive diagnostics here. It is not traced. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface DecisionBackend {
  readonly capabilities: BackendCapabilities;
  health(signal?: AbortSignal): Promise<BackendHealth>;
  predict<K extends DecisionKind>(
    request: DecisionRequest<K>,
    signal?: AbortSignal,
  ): Promise<BackendPrediction<K>>;
  predictBatch?<K extends DecisionKind>(
    requests: readonly DecisionRequest<K>[],
    signal?: AbortSignal,
  ): Promise<readonly BackendPrediction<K>[]>;
}

export interface DecisionPolicy {
  resolveExactly<K extends DecisionKind>(request: DecisionRequest<K>): DecisionValue<K> | undefined;
  validate<K extends DecisionKind>(request: DecisionRequest<K>, value: DecisionValue<K>): void;
  risk<K extends DecisionKind>(request: DecisionRequest<K>, value: DecisionValue<K>): DecisionRisk;
}

export interface ConfidenceAssessment {
  readonly outcome: DecisionOutcome;
  /** Null when unavailable or uncalibrated. */
  readonly confidence: number | null;
  readonly calibrated: boolean;
  readonly reasonCode: string;
}

export interface ConfidencePolicy {
  assess<K extends DecisionKind>(input: {
    readonly request: DecisionRequest<K>;
    readonly prediction: BackendPrediction<K>;
    readonly deterministic: boolean;
    readonly risk: DecisionRisk;
    readonly backend?: BackendIdentity;
  }): ConfidenceAssessment;
}

export type DecisionErrorCode =
  | "invalid_request"
  | "unsupported"
  | "privacy_denied"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "invalid_output"
  | "backend_failure"
  | "policy_failure";

export interface DecisionError {
  readonly code: DecisionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly backendId?: string;
  readonly field?: string;
}

export interface DecisionTraceStage {
  readonly name:
    "validation" | "exact_policy" | "routing" | "health" | "prediction" | "confidence" | "cache";
  readonly durationMs: number;
  readonly outcome: string;
  readonly backendId?: string;
}

export interface DecisionTrace {
  readonly traceId: string;
  readonly requestId: string;
  readonly category: string;
  readonly kind: DecisionKind | "invalid";
  readonly stages: readonly DecisionTraceStage[];
  readonly backendId?: string;
  readonly cacheHit: boolean;
  readonly outcome: DecisionOutcome;
  readonly reasonCode: string;
  readonly latencyMs: number;
}

export interface DecisionResult<K extends DecisionKind = DecisionKind> {
  readonly schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  readonly requestId: string;
  readonly outcome: DecisionOutcome;
  readonly value?: DecisionValue<K>;
  readonly confidence: number | null;
  readonly calibrated: boolean;
  readonly provenance: "deterministic" | "backend" | "fallback";
  readonly backend?: BackendIdentity;
  readonly usage?: UsageMetadata;
  readonly error?: DecisionError;
  readonly latencyMs: number;
  readonly trace: DecisionTrace;
}

export interface DecisionEngine {
  decide<K extends DecisionKind>(
    request: DecisionRequest<K>,
    signal?: AbortSignal,
  ): Promise<DecisionResult<K>>;
}
