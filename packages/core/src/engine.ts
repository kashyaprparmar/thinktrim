import { CONTRACT_SCHEMA_VERSION } from "@thinktrim/shared";
import { createAbortScope, runAbortable } from "./abort.js";
import { BackendRouter } from "./backend-router.js";
import type { BackendRoutePlan } from "./backend-router.js";
import { DecisionCache } from "./decision-cache.js";
import {
  DecisionBackendFailure,
  decisionError,
  errorFromUnknown,
  ValidationFault,
} from "./errors.js";
import type {
  BackendCapabilities,
  BackendIdentity,
  BackendPrediction,
  ConfidencePolicy,
  DecisionBackend,
  DecisionEngine,
  DecisionError,
  DecisionKind,
  DecisionOutcome,
  DecisionPolicy,
  DecisionRequest,
  DecisionResult,
  DecisionRisk,
  DecisionTraceStage,
  DecisionValue,
  UsageMetadata,
} from "./types.js";
import {
  isBackendCapabilities,
  validateAssessment,
  validatePrediction,
  validateRequest,
} from "./validation.js";

export interface CoreDecisionEngineOptions {
  /** Order is the configured failover order; remote backends still require request permission. */
  readonly backends: readonly DecisionBackend[];
  readonly decisionPolicy: DecisionPolicy;
  readonly confidencePolicy: ConfidencePolicy;
  readonly router?: BackendRouter;
  readonly cache?: {
    readonly store: DecisionCache;
    readonly workspaceId: string;
    readonly policyVersion?: string;
  };
  readonly now?: () => number;
  readonly createTraceId?: () => string;
}

interface FinishFields<K extends DecisionKind> {
  readonly outcome: DecisionOutcome;
  readonly reasonCode: string;
  readonly provenance: "deterministic" | "backend" | "fallback";
  readonly value?: DecisionValue<K>;
  readonly confidence?: number | null;
  readonly calibrated?: boolean;
  readonly backend?: BackendIdentity;
  readonly usage?: UsageMetadata;
  readonly error?: DecisionError;
  readonly cacheHit?: boolean;
}

function backendIdentity(capabilities: BackendCapabilities): BackendIdentity {
  return {
    id: capabilities.id,
    modelVersion: capabilities.modelVersion,
    locality: capabilities.locality,
  };
}

function requestLabel(value: unknown, field: "id" | "category"): string {
  if (typeof value !== "object" || value === null || !(field in value)) {
    return "invalid";
  }
  const label: unknown = (value as Record<string, unknown>)[field];
  return typeof label === "string" && label.length <= 128 ? label : "invalid";
}

function requestKind(value: unknown): DecisionKind | "invalid" {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return "invalid";
  }
  const kind: unknown = value.kind;
  return kind === "binary" || kind === "choice" || kind === "score" || kind === "ranking"
    ? kind
    : "invalid";
}

function isRemotePermitted(request: DecisionRequest, capabilities: BackendCapabilities): boolean {
  if (capabilities.locality === "local") {
    return true;
  }
  return (
    request.constraints.locality === "remote_allowed" &&
    request.dataClasses.every((dataClass) =>
      request.constraints.allowedRemoteData.includes(dataClass),
    )
  );
}

function supports(
  request: DecisionRequest,
  capabilities: BackendCapabilities,
  requestBytes: number,
): boolean {
  return (
    capabilities.kinds.includes(request.kind) &&
    (capabilities.categories === undefined || capabilities.categories.includes(request.category)) &&
    (request.candidates?.length ?? 0) <= capabilities.maxCandidates &&
    requestBytes <= capabilities.maxInputBytes
  );
}

export class CoreDecisionEngine implements DecisionEngine {
  private readonly backends: readonly DecisionBackend[];
  private readonly decisionPolicy: DecisionPolicy;
  private readonly confidencePolicy: ConfidencePolicy;
  private readonly router: BackendRouter;
  private readonly cache: CoreDecisionEngineOptions["cache"];
  private readonly now: () => number;
  private readonly createTraceId: () => string;

  constructor(options: CoreDecisionEngineOptions) {
    this.backends = [...options.backends];
    this.decisionPolicy = options.decisionPolicy;
    this.confidencePolicy = options.confidencePolicy;
    this.router = options.router ?? new BackendRouter();
    this.cache = options.cache;
    this.now = options.now ?? (() => performance.now());
    this.createTraceId = options.createTraceId ?? (() => crypto.randomUUID());
  }

  /** Inspect the routing plan before any backend health or prediction call. */
  planRoute(request: DecisionRequest): BackendRoutePlan {
    return this.router.plan(request, this.backends);
  }

  async decide<K extends DecisionKind>(
    request: DecisionRequest<K>,
    externalSignal?: AbortSignal,
  ): Promise<DecisionResult<K>> {
    const startedAt = this.now();
    const traceId = this.createTraceId();
    const stages: DecisionTraceStage[] = [];
    let stableRequest: DecisionRequest<K> | undefined;
    const record = (
      name: DecisionTraceStage["name"],
      stageStart: number,
      outcome: string,
      backendId?: string,
    ): void => {
      stages.push({
        name,
        durationMs: Math.max(0, this.now() - stageStart),
        outcome,
        ...(backendId === undefined ? {} : { backendId }),
      });
    };
    const finish = (fields: FinishFields<K>): DecisionResult<K> => {
      const latencyMs = Math.max(0, this.now() - startedAt);
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: requestLabel(stableRequest ?? request, "id"),
        outcome: fields.outcome,
        ...(fields.value === undefined ? {} : { value: fields.value }),
        confidence: fields.confidence ?? null,
        calibrated: fields.calibrated ?? false,
        provenance: fields.provenance,
        ...(fields.backend === undefined ? {} : { backend: fields.backend }),
        ...(fields.usage === undefined ? {} : { usage: fields.usage }),
        ...(fields.error === undefined ? {} : { error: fields.error }),
        latencyMs,
        trace: {
          traceId,
          requestId: requestLabel(stableRequest ?? request, "id"),
          category: requestLabel(stableRequest ?? request, "category"),
          kind: requestKind(stableRequest ?? request),
          stages: [...stages],
          ...(fields.backend === undefined ? {} : { backendId: fields.backend.id }),
          cacheHit: fields.cacheHit ?? false,
          outcome: fields.outcome,
          reasonCode: fields.reasonCode,
          latencyMs,
        },
      };
    };
    const fail = (error: DecisionError): DecisionResult<K> =>
      finish({ outcome: "unknown", reasonCode: error.code, provenance: "fallback", error });

    const validationStart = this.now();
    let requestBytes: number;
    try {
      validateRequest(request);
      stableRequest = JSON.parse(JSON.stringify(request)) as DecisionRequest<K>;
      requestBytes = validateRequest(stableRequest);
      record("validation", validationStart, "valid");
    } catch (cause) {
      record("validation", validationStart, "invalid_request");
      const error =
        cause instanceof ValidationFault
          ? errorFromUnknown(cause)
          : decisionError("invalid_request");
      return fail(error);
    }
    if (stableRequest === undefined) {
      return fail(decisionError("invalid_request"));
    }
    const input = stableRequest;

    if (externalSignal?.aborted) {
      return fail(decisionError("cancelled"));
    }

    const remainingMs = input.constraints.deadlineMs - (this.now() - startedAt);
    if (remainingMs <= 0) {
      return fail(decisionError("timeout"));
    }
    const scope = createAbortScope(externalSignal, remainingMs);
    const stopped = (): DecisionError | undefined => {
      if (externalSignal?.aborted) {
        return decisionError("cancelled");
      }
      if (scope.signal.aborted) {
        return decisionError(scope.failureCode);
      }
      if (this.now() - startedAt >= input.constraints.deadlineMs) {
        return decisionError("timeout");
      }
      return undefined;
    };
    try {
      const exactStart = this.now();
      let exact: DecisionValue<K> | undefined;
      try {
        exact = this.decisionPolicy.resolveExactly(input);
        if (exact !== undefined) {
          validatePrediction(input, { value: exact });
          this.decisionPolicy.validate(input, exact);
        }
        record("exact_policy", exactStart, exact === undefined ? "unresolved" : "resolved");
      } catch {
        record("exact_policy", exactStart, "policy_failure");
        return fail(decisionError("policy_failure"));
      }

      const afterExact = stopped();
      if (afterExact) {
        return fail(afterExact);
      }

      if (exact !== undefined) {
        const confidenceStart = this.now();
        try {
          const risk = this.decisionPolicy.risk(input, exact);
          const assessment = this.confidencePolicy.assess({
            request: input,
            prediction: { value: exact },
            deterministic: true,
            risk,
          });
          validateAssessment(assessment, true);
          const afterConfidence = stopped();
          if (afterConfidence) {
            return fail(afterConfidence);
          }
          record("confidence", confidenceStart, assessment.outcome);
          return finish({
            outcome: assessment.outcome,
            reasonCode: assessment.reasonCode,
            provenance: "deterministic",
            value: exact,
          });
        } catch {
          record("confidence", confidenceStart, "policy_failure");
          return fail(decisionError("policy_failure"));
        }
      }

      let lastError: DecisionError | undefined;
      let routePlan: BackendRoutePlan;
      try {
        routePlan = this.router.plan(input, this.backends);
      } catch {
        return fail(decisionError("backend_failure"));
      }
      for (const skipped of routePlan.skipped) {
        record("routing", this.now(), skipped.reasonCode, skipped.backendId);
      }
      if (routePlan.attempts.length === 0) {
        record("routing", this.now(), routePlan.reasonCode);
      }
      if (this.cache && routePlan.attempts.length > 0) {
        const firstRoute = routePlan.attempts[0];
        const firstBackend = firstRoute && this.backends[firstRoute.backendIndex];
        try {
          if (firstBackend && isBackendCapabilities(firstBackend.capabilities)) {
            const identity = backendIdentity(firstBackend.capabilities);
            const cached = await this.cache.store.get({
              request: input,
              backend: identity,
              workspaceId: this.cache.workspaceId,
              ...(this.cache.policyVersion === undefined
                ? {}
                : { policyVersion: this.cache.policyVersion }),
              traceId,
            });
            if (cached) {
              const cacheStart = this.now();
              record("cache", cacheStart, "hit", identity.id);
              return finish({
                outcome: cached.outcome,
                reasonCode: "cache_hit",
                provenance: cached.provenance,
                ...(cached.value === undefined ? {} : { value: cached.value }),
                confidence: cached.confidence,
                calibrated: cached.calibrated,
                ...(cached.backend === undefined ? {} : { backend: cached.backend }),
                ...(cached.usage === undefined ? {} : { usage: cached.usage }),
                cacheHit: true,
              });
            }
          }
        } catch {
          // Cache failures must not prevent an ordinary decision.
        }
      }
      let privacyBlocked = routePlan.skipped.some((entry) => entry.reasonCode === "privacy_denied");
      for (const route of routePlan.attempts) {
        const backend = this.backends[route.backendIndex];
        if (!backend) continue;
        const beforeBackend = stopped();
        if (beforeBackend) {
          return fail(beforeBackend);
        }

        const routeStart = this.now();
        let capabilities: BackendCapabilities;
        try {
          capabilities = backend.capabilities;
        } catch {
          lastError = decisionError("backend_failure");
          record("routing", routeStart, "backend_failure");
          continue;
        }
        if (!isBackendCapabilities(capabilities)) {
          lastError = decisionError("backend_failure");
          record("routing", routeStart, "invalid_capabilities");
          continue;
        }
        if (!supports(input, capabilities, requestBytes)) {
          record("routing", routeStart, "unsupported", capabilities.id);
          continue;
        }
        if (!isRemotePermitted(input, capabilities)) {
          privacyBlocked = true;
          record("routing", routeStart, "privacy_denied", capabilities.id);
          continue;
        }
        record("routing", routeStart, route.reasonCode, capabilities.id);
        const identity = backendIdentity(capabilities);

        const healthStart = this.now();
        try {
          const health = await runAbortable(scope, () => backend.health(scope.signal));
          const afterHealth = stopped();
          if (afterHealth) {
            throw new DecisionBackendFailure(
              afterHealth.code === "cancelled" ? "cancelled" : "timeout",
            );
          }
          if (health !== "healthy" && health !== "degraded" && health !== "unavailable") {
            throw new ValidationFault("invalid_output", "health");
          }
          record("health", healthStart, health, capabilities.id);
          if (health === "unavailable") {
            lastError = decisionError("unavailable", capabilities.id);
            continue;
          }
        } catch (cause) {
          const stopError = stopped();
          const error = stopError
            ? decisionError(stopError.code, capabilities.id)
            : errorFromUnknown(cause, capabilities.id);
          record("health", healthStart, error.code, capabilities.id);
          if (stopError) {
            return fail(error);
          }
          lastError = error;
          continue;
        }

        const predictionStart = this.now();
        let prediction: BackendPrediction<K>;
        try {
          prediction = await runAbortable(scope, () => backend.predict(input, scope.signal));
          const afterPrediction = stopped();
          if (afterPrediction) {
            throw new DecisionBackendFailure(
              afterPrediction.code === "cancelled" ? "cancelled" : "timeout",
            );
          }
          validatePrediction(input, prediction);
          try {
            this.decisionPolicy.validate(input, prediction.value);
          } catch {
            throw new ValidationFault("invalid_output", "value");
          }
          record("prediction", predictionStart, "valid", capabilities.id);
        } catch (cause) {
          const stopError = stopped();
          const error = stopError
            ? decisionError(stopError.code, capabilities.id)
            : errorFromUnknown(cause, capabilities.id);
          record("prediction", predictionStart, error.code, capabilities.id);
          if (stopError) {
            return fail(error);
          }
          lastError = error;
          continue;
        }

        const confidenceStart = this.now();
        try {
          const risk: DecisionRisk = this.decisionPolicy.risk(input, prediction.value);
          const assessment = this.confidencePolicy.assess({
            request: input,
            prediction,
            deterministic: false,
            risk,
            backend: identity,
          });
          validateAssessment(assessment, false);
          const afterConfidence = stopped();
          if (afterConfidence) {
            return fail(afterConfidence);
          }
          record("confidence", confidenceStart, assessment.outcome, capabilities.id);
          const result = finish({
            outcome: assessment.outcome,
            reasonCode: assessment.reasonCode,
            provenance: "backend",
            value: prediction.value,
            confidence: assessment.confidence,
            calibrated: assessment.calibrated,
            backend: identity,
            ...(prediction.usage === undefined ? {} : { usage: prediction.usage }),
          });
          if (this.cache) {
            try {
              await this.cache.store.set({
                request: input,
                backend: identity,
                workspaceId: this.cache.workspaceId,
                ...(this.cache.policyVersion === undefined
                  ? {}
                  : { policyVersion: this.cache.policyVersion }),
                result,
              });
            } catch {
              // Cache failures must not change the backend decision.
            }
          }
          return result;
        } catch {
          record("confidence", confidenceStart, "policy_failure", capabilities.id);
          return fail(decisionError("policy_failure", capabilities.id));
        }
      }

      const afterRouting = stopped();
      if (afterRouting) {
        return fail(afterRouting);
      }
      const unavailable = routePlan.skipped.some((entry) =>
        ["known_unavailable", "network_unavailable"].includes(entry.reasonCode),
      );
      return fail(
        lastError ??
          decisionError(
            privacyBlocked ? "privacy_denied" : unavailable ? "unavailable" : "unsupported",
          ),
      );
    } finally {
      scope.dispose();
    }
  }
}
