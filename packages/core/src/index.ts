export { CONTRACT_SCHEMA_VERSION, createCandidateId, isCandidateId } from "@thinktrim/shared";
export type { CandidateId } from "@thinktrim/shared";
export { CoreDecisionEngine } from "./engine.js";
export type { CoreDecisionEngineOptions } from "./engine.js";
export { BackendRouter } from "./backend-router.js";
export { DecisionCache } from "./decision-cache.js";
export type {
  BackendRouteEntry,
  BackendRoutePlan,
  BackendRouterOptions,
  BackendRoutingHint,
} from "./backend-router.js";
export type { DecisionCacheOptions, DecisionCacheStats } from "./decision-cache.js";
export { DecisionBackendFailure, ValidationFault } from "./errors.js";
export { validateRequest } from "./validation.js";
export { FakeBackend } from "./fake-backend.js";
export type { FakeBackendOptions, FakeReply } from "./fake-backend.js";
export type {
  BackendCapabilities,
  BackendHealth,
  BackendIdentity,
  BackendPrediction,
  BackendRoutingMode,
  BackendRoutingPreference,
  BinaryDecision,
  ChoiceDecision,
  ConfidenceAssessment,
  ConfidencePolicy,
  ConfidenceProfile,
  DataLocality,
  DecisionBackend,
  DecisionCandidate,
  DecisionConstraints,
  DecisionEngine,
  DecisionError,
  DecisionErrorCode,
  DecisionKind,
  DecisionOutcome,
  DecisionPolicy,
  DecisionRequest,
  DecisionRequestMap,
  DecisionResult,
  DecisionRisk,
  DecisionTrace,
  DecisionTraceStage,
  DecisionValue,
  DecisionValueMap,
  RankingDecision,
  RemoteDataClass,
  ScoreDecision,
  UsageMetadata,
} from "./types.js";
