import { CONTRACT_SCHEMA_VERSION } from "@thinktrim/shared";
import type {
  BackendIdentity,
  DataLocality,
  DecisionEngine,
  DecisionRequest,
  RemoteDataClass,
  UsageMetadata,
} from "@thinktrim/core";

/** Short facts or summaries already retrieved by the host. */
export interface RetrievedEvidence {
  readonly id: string;
  readonly source: string;
  readonly summary: string;
  readonly fingerprint: string;
}

export interface ContextSufficiencyInput {
  readonly task: string;
  readonly retrievedEvidence: readonly RetrievedEvidence[];
  /** Evidence IDs the caller has identified as necessary to address the task. */
  readonly requiredEvidenceIds: readonly string[];
  /** Known unanswered questions prevent a sufficient verdict. */
  readonly openQuestions?: readonly string[];
  readonly repositoryState?: string;
  readonly locality?: DataLocality;
  readonly allowedRemoteData?: readonly RemoteDataClass[];
  readonly deadlineMs?: number;
}

export interface ContextSufficiencyOptions {
  readonly engine: DecisionEngine;
  /** Acceptance floor for calibrated backend confidence. Defaults to 0.95. */
  readonly minimumConfidence?: number;
}

export interface TrackedEvidence {
  readonly id: string;
  readonly source: string;
  readonly fingerprint: string;
}

export interface ContextSufficiencyResult {
  readonly status: "sufficient" | "insufficient" | "uncertain";
  /** Only a sufficient result may tell the caller to stop searching. */
  readonly continueSearch: boolean;
  readonly reasonCode: string;
  readonly retrievedEvidence: readonly TrackedEvidence[];
  readonly missingEvidenceIds: readonly string[];
  readonly confidence: number | null;
  readonly calibrated: boolean;
  readonly backend?: BackendIdentity;
  readonly usage?: UsageMetadata;
  readonly latencyMs?: number;
}

function validText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && code !== 9 && code !== 10) || code === 127;
    })
  );
}

function validSingleLine(value: unknown, maximum: number): value is string {
  return validText(value, maximum) && !/[\r\n\t]/.test(value);
}

function validateInput(input: ContextSufficiencyInput): void {
  if (!validText(input.task, 9_000)) throw new TypeError("task is invalid");
  if (!Array.isArray(input.retrievedEvidence) || input.retrievedEvidence.length > 32) {
    throw new RangeError("retrievedEvidence exceeds 32 entries");
  }
  const seen = new Set<string>();
  for (const item of input.retrievedEvidence) {
    if (
      !item ||
      !validSingleLine(item.id, 128) ||
      !validSingleLine(item.source, 256) ||
      !validText(item.summary, 512) ||
      !validSingleLine(item.fingerprint, 256) ||
      seen.has(item.id)
    ) {
      throw new TypeError("retrievedEvidence contains an invalid or duplicate entry");
    }
    seen.add(item.id);
  }
  if (
    !Array.isArray(input.requiredEvidenceIds) ||
    input.requiredEvidenceIds.length > 32 ||
    new Set(input.requiredEvidenceIds).size !== input.requiredEvidenceIds.length ||
    input.requiredEvidenceIds.some((id) => !validSingleLine(id, 128))
  ) {
    throw new TypeError("requiredEvidenceIds is invalid");
  }
  if (
    input.openQuestions &&
    (input.openQuestions.length > 16 ||
      input.openQuestions.some((question) => !validText(question, 256)))
  ) {
    throw new TypeError("openQuestions is invalid");
  }
  if (input.repositoryState !== undefined && !validSingleLine(input.repositoryState, 256)) {
    throw new TypeError("repositoryState is invalid");
  }
  const deadlineMs = input.deadlineMs ?? 30_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) {
    throw new RangeError("deadlineMs must be between 1 and 120000");
  }
  if (input.locality !== undefined && !["local_only", "remote_allowed"].includes(input.locality)) {
    throw new TypeError("locality is invalid");
  }
  const allowed = input.allowedRemoteData ?? [];
  if (
    !Array.isArray(allowed) ||
    new Set(allowed).size !== allowed.length ||
    allowed.some((item) => !["task", "summaries"].includes(item)) ||
    (input.locality !== "remote_allowed" && allowed.length > 0)
  ) {
    throw new TypeError("allowedRemoteData is invalid");
  }
}

/** Conservative gate over an injected, host-neutral decision engine. */
export class ContextSufficiencyPolicy {
  private readonly engine: DecisionEngine;
  private readonly minimumConfidence: number;

  constructor(options: ContextSufficiencyOptions) {
    if (!options.engine || typeof options.engine.decide !== "function") {
      throw new TypeError("engine is required");
    }
    const minimumConfidence = options.minimumConfidence ?? 0.95;
    if (!Number.isFinite(minimumConfidence) || minimumConfidence <= 0 || minimumConfidence > 1) {
      throw new RangeError("minimumConfidence must be in (0, 1]");
    }
    this.engine = options.engine;
    this.minimumConfidence = minimumConfidence;
  }

  async assess(
    input: ContextSufficiencyInput,
    signal?: AbortSignal,
  ): Promise<ContextSufficiencyResult> {
    validateInput(input);
    const tracked = input.retrievedEvidence.map(({ id, source, fingerprint }) => ({
      id,
      source,
      fingerprint,
    }));
    const found = new Set(tracked.map((item) => item.id));
    const missingEvidenceIds = input.requiredEvidenceIds.filter((id) => !found.has(id));
    const base = { retrievedEvidence: tracked, missingEvidenceIds };
    const unresolved = (reasonCode: string): ContextSufficiencyResult => ({
      status: "uncertain",
      continueSearch: true,
      reasonCode,
      ...base,
      confidence: null,
      calibrated: false,
    });

    if (missingEvidenceIds.length > 0 || (input.openQuestions?.length ?? 0) > 0) {
      return {
        ...unresolved(
          missingEvidenceIds.length > 0 ? "missing_required_evidence" : "open_questions",
        ),
        status: "insufficient",
      };
    }
    if (tracked.length === 0 || input.requiredEvidenceIds.length === 0) {
      return unresolved("coverage_not_established");
    }
    if (signal?.aborted) return unresolved("cancelled");

    const request: DecisionRequest<"binary"> = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id: `context-sufficiency-${crypto.randomUUID()}`,
      category: "context_sufficiency",
      kind: "binary",
      task: `Is the retrieved evidence sufficient to complete this task? Answer yes only if the required evidence covers the task. Task: ${input.task}`,
      evidence: input.retrievedEvidence.map((item) => `${item.id}: ${item.summary}`),
      dataClasses: ["task", "summaries"],
      constraints: {
        locality: input.locality ?? "local_only",
        allowedRemoteData: input.allowedRemoteData ?? [],
        profile: "safe",
        deadlineMs: input.deadlineMs ?? 30_000,
        maxCandidates: 1,
      },
      ...(input.repositoryState === undefined ? {} : { repositoryState: input.repositoryState }),
    };
    try {
      const result = await this.engine.decide(request, signal);
      const metadata = {
        ...base,
        confidence: result.calibrated ? result.confidence : null,
        calibrated: result.calibrated,
        ...(result.backend === undefined ? {} : { backend: result.backend }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        latencyMs: result.latencyMs,
      };
      if (
        result.schemaVersion !== CONTRACT_SCHEMA_VERSION ||
        result.outcome !== "accept" ||
        result.provenance !== "backend" ||
        result.backend === undefined ||
        result.requestId !== request.id ||
        result.value?.kind !== "binary" ||
        typeof result.value.value !== "boolean" ||
        !result.calibrated ||
        result.confidence === null ||
        !Number.isFinite(result.confidence) ||
        result.confidence > 1 ||
        result.confidence < this.minimumConfidence
      ) {
        return {
          status: "uncertain",
          continueSearch: true,
          reasonCode: result.error?.code ?? "confidence_inadequate",
          ...metadata,
        };
      }
      return {
        status: result.value.value ? "sufficient" : "insufficient",
        continueSearch: !result.value.value,
        reasonCode: result.value.value ? "evidence_sufficient" : "evidence_insufficient",
        ...metadata,
      };
    } catch {
      return unresolved("decision_error");
    }
  }
}
