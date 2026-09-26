import { isCandidateId } from "@thinktrim/shared";
import { CONTRACT_SCHEMA_VERSION } from "@thinktrim/shared";
import { ValidationFault } from "./errors.js";
import type {
  BackendCapabilities,
  BackendPrediction,
  ConfidenceAssessment,
  DecisionKind,
  DecisionRequest,
} from "./types.js";

const KINDS = ["binary", "choice", "score", "ranking"] as const;
const DATA_CLASSES = ["task", "paths", "summaries", "snippets"] as const;
const PROFILES = ["safe", "balanced", "aggressive"] as const;
const OUTCOMES = ["accept", "reject", "retrieve_more", "escalate", "unknown"] as const;
const MAX_REQUEST_BYTES = 1_048_576;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ValidationFault("invalid_request", field);
  }
}

function isText(value: unknown, maxLength: number, allowLayout = false): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint < 32 && !(allowLayout && [9, 10, 13].includes(codePoint))) || codePoint === 127)
    ) {
      return false;
    }
  }
  return true;
}

function isPositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0 && value <= maximum;
}

function isUniqueEnumList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  maxLength: number,
): value is readonly T[] {
  return (
    Array.isArray(value) &&
    value.length <= maxLength &&
    new Set(value).size === value.length &&
    value.every((item: unknown) => allowed.includes(item as T))
  );
}

function assertCandidate(candidate: unknown, index: number): number {
  if (!isRecord(candidate) || !isCandidateId(candidate.id)) {
    throw new ValidationFault("invalid_request", `candidates[${index}].id`);
  }
  assertAllowedKeys(
    candidate,
    ["id", "label", "features", "contentFingerprint"],
    `candidates[${index}]`,
  );
  let characters = candidate.id.length;
  if (candidate.label !== undefined && !isText(candidate.label, 512)) {
    throw new ValidationFault("invalid_request", `candidates[${index}].label`);
  }
  if (typeof candidate.label === "string") {
    characters += candidate.label.length;
  }
  if (candidate.contentFingerprint !== undefined && !isText(candidate.contentFingerprint, 256)) {
    throw new ValidationFault("invalid_request", `candidates[${index}].contentFingerprint`);
  }
  if (typeof candidate.contentFingerprint === "string") {
    characters += candidate.contentFingerprint.length;
  }
  if (candidate.features !== undefined) {
    if (!isRecord(candidate.features) || Object.keys(candidate.features).length > 64) {
      throw new ValidationFault("invalid_request", `candidates[${index}].features`);
    }
    for (const [key, value] of Object.entries(candidate.features)) {
      if (
        !isText(key, 128) ||
        !(
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)) ||
          (typeof value === "string" && value.length <= 4096)
        )
      ) {
        throw new ValidationFault("invalid_request", `candidates[${index}].features`);
      }
      characters += key.length + (typeof value === "string" ? value.length : 16);
    }
  }
  return characters;
}

/** Validates runtime JSON as well as typed callers. Returns the serialized byte count. */
export function validateRequest(request: DecisionRequest): number {
  const input: unknown = request;
  if (!isRecord(input)) {
    throw new ValidationFault("invalid_request", "request");
  }
  assertAllowedKeys(
    input,
    [
      "schemaVersion",
      "id",
      "category",
      "kind",
      "task",
      "candidates",
      "evidence",
      "dataClasses",
      "constraints",
      "repositoryState",
    ],
    "request",
  );
  if (input.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw new ValidationFault("invalid_request", "schemaVersion");
  }
  if (!isText(input.id, 128) || input.id.trim() !== input.id) {
    throw new ValidationFault("invalid_request", "id");
  }
  if (!isText(input.category, 128) || input.category.trim() !== input.category) {
    throw new ValidationFault("invalid_request", "category");
  }
  if (!KINDS.includes(input.kind as DecisionKind)) {
    throw new ValidationFault("invalid_request", "kind");
  }
  if (!isText(input.task, 10_000, true) || input.task.trim().length === 0) {
    throw new ValidationFault("invalid_request", "task");
  }
  let characters = input.id.length + input.category.length + input.task.length;
  if (
    !isUniqueEnumList(input.dataClasses, DATA_CLASSES, DATA_CLASSES.length) ||
    !input.dataClasses.includes("task")
  ) {
    throw new ValidationFault("invalid_request", "dataClasses");
  }
  if (
    input.evidence !== undefined &&
    (!Array.isArray(input.evidence) ||
      input.evidence.length > 32 ||
      !input.evidence.every((entry: unknown) => isText(entry, 4096, true)))
  ) {
    throw new ValidationFault("invalid_request", "evidence");
  }
  if (Array.isArray(input.evidence)) {
    characters += input.evidence.reduce<number>((total, entry: string) => total + entry.length, 0);
  }
  if (input.repositoryState !== undefined && !isText(input.repositoryState, 256)) {
    throw new ValidationFault("invalid_request", "repositoryState");
  }
  if (typeof input.repositoryState === "string") {
    characters += input.repositoryState.length;
  }

  const constraints = input.constraints;
  if (!isRecord(constraints)) {
    throw new ValidationFault("invalid_request", "constraints");
  }
  assertAllowedKeys(
    constraints,
    [
      "locality",
      "allowedRemoteData",
      "profile",
      "deadlineMs",
      "maxCandidates",
      "maxOutputItems",
      "routing",
    ],
    "constraints",
  );
  if (constraints.locality !== "local_only" && constraints.locality !== "remote_allowed") {
    throw new ValidationFault("invalid_request", "constraints.locality");
  }
  if (
    !isUniqueEnumList(constraints.allowedRemoteData, DATA_CLASSES, DATA_CLASSES.length) ||
    (constraints.locality === "local_only" && constraints.allowedRemoteData.length !== 0)
  ) {
    throw new ValidationFault("invalid_request", "constraints.allowedRemoteData");
  }
  if (!PROFILES.includes(constraints.profile as (typeof PROFILES)[number])) {
    throw new ValidationFault("invalid_request", "constraints.profile");
  }
  if (!isPositiveInteger(constraints.deadlineMs, 120_000)) {
    throw new ValidationFault("invalid_request", "constraints.deadlineMs");
  }
  if (!isPositiveInteger(constraints.maxCandidates, 1000)) {
    throw new ValidationFault("invalid_request", "constraints.maxCandidates");
  }
  if (
    constraints.maxOutputItems !== undefined &&
    !isPositiveInteger(constraints.maxOutputItems, 1000)
  ) {
    throw new ValidationFault("invalid_request", "constraints.maxOutputItems");
  }
  if (constraints.routing !== undefined) {
    const routing = constraints.routing;
    if (!isRecord(routing)) throw new ValidationFault("invalid_request", "constraints.routing");
    assertAllowedKeys(
      routing,
      [
        "mode",
        "backendId",
        "fallback",
        "networkAvailable",
        "localPreference",
        "optimizeFor",
        "language",
      ],
      "constraints.routing",
    );
    if (
      routing.mode !== undefined &&
      !["local", "remote", "auto"].includes(routing.mode as string)
    ) {
      throw new ValidationFault("invalid_request", "constraints.routing.mode");
    }
    if (routing.backendId !== undefined && !isText(routing.backendId, 128)) {
      throw new ValidationFault("invalid_request", "constraints.routing.backendId");
    }
    if (
      routing.fallback !== undefined &&
      !["none", "permitted"].includes(routing.fallback as string)
    ) {
      throw new ValidationFault("invalid_request", "constraints.routing.fallback");
    }
    if (routing.networkAvailable !== undefined && typeof routing.networkAvailable !== "boolean") {
      throw new ValidationFault("invalid_request", "constraints.routing.networkAvailable");
    }
    if (routing.localPreference !== undefined && typeof routing.localPreference !== "boolean") {
      throw new ValidationFault("invalid_request", "constraints.routing.localPreference");
    }
    if (
      routing.optimizeFor !== undefined &&
      !["none", "latency", "quality"].includes(routing.optimizeFor as string)
    ) {
      throw new ValidationFault("invalid_request", "constraints.routing.optimizeFor");
    }
    if (routing.language !== undefined && !isText(routing.language, 64)) {
      throw new ValidationFault("invalid_request", "constraints.routing.language");
    }
  }

  const candidates = input.candidates;
  if (candidates === undefined) {
    if (input.kind !== "binary") {
      throw new ValidationFault("invalid_request", "candidates");
    }
  } else {
    if (
      !Array.isArray(candidates) ||
      candidates.length > constraints.maxCandidates ||
      (input.kind !== "binary" && candidates.length === 0)
    ) {
      throw new ValidationFault("invalid_request", "candidates");
    }
    const ids = new Set<string>();
    for (const [index, candidate] of candidates.entries()) {
      characters += assertCandidate(candidate, index);
      if (characters > MAX_REQUEST_BYTES) {
        throw new ValidationFault("invalid_request", "request");
      }
      const id = (candidate as { id: string }).id;
      if (ids.has(id)) {
        throw new ValidationFault("invalid_request", `candidates[${index}].id`);
      }
      ids.add(id);
    }
  }

  if (characters > MAX_REQUEST_BYTES) {
    throw new ValidationFault("invalid_request", "request");
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw new ValidationFault("invalid_request", "request");
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_REQUEST_BYTES) {
    throw new ValidationFault("invalid_request", "request");
  }
  return bytes;
}

export function isBackendCapabilities(value: unknown): value is BackendCapabilities {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isText(value.id, 128) &&
    isText(value.modelVersion, 128) &&
    value.schemaVersion === CONTRACT_SCHEMA_VERSION &&
    isUniqueEnumList(value.kinds, KINDS, KINDS.length) &&
    value.kinds.length > 0 &&
    (value.categories === undefined ||
      (Array.isArray(value.categories) &&
        value.categories.length <= 128 &&
        value.categories.every((category: unknown) => isText(category, 128)))) &&
    (value.locality === "local" || value.locality === "remote") &&
    isPositiveInteger(value.maxInputBytes, 100_000_000) &&
    isPositiveInteger(value.maxCandidates, 100_000) &&
    typeof value.supportsBatch === "boolean" &&
    typeof value.supportsCancellation === "boolean"
  );
}

export function validatePrediction(request: DecisionRequest, prediction: BackendPrediction): void {
  const output: unknown = prediction;
  if (!isRecord(output) || !isRecord(output.value) || output.value.kind !== request.kind) {
    throw new ValidationFault("invalid_output", "value.kind");
  }
  if (output.rawSignal !== undefined && !Number.isFinite(output.rawSignal)) {
    throw new ValidationFault("invalid_output", "rawSignal");
  }
  if (output.usage !== undefined) {
    if (!isRecord(output.usage) || !isText(output.usage.unit, 32)) {
      throw new ValidationFault("invalid_output", "usage");
    }
    for (const field of ["inputUnits", "outputUnits"] as const) {
      const amount = output.usage[field];
      if (
        amount !== undefined &&
        !(typeof amount === "number" && Number.isFinite(amount) && amount >= 0)
      ) {
        throw new ValidationFault("invalid_output", `usage.${field}`);
      }
    }
  }
  if (output.metadata !== undefined) {
    if (!isRecord(output.metadata) || Object.keys(output.metadata).length > 32) {
      throw new ValidationFault("invalid_output", "metadata");
    }
    for (const [key, value] of Object.entries(output.metadata)) {
      if (
        !isText(key, 128) ||
        !(
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)) ||
          (typeof value === "string" && value.length <= 1024)
        )
      ) {
        throw new ValidationFault("invalid_output", "metadata");
      }
    }
  }

  const value = output.value;
  if (request.kind === "binary") {
    if (typeof value.value !== "boolean") {
      throw new ValidationFault("invalid_output", "value.value");
    }
    return;
  }

  const expected = new Set(request.candidates.map((candidate) => candidate.id));
  if (request.kind === "choice") {
    if (!isCandidateId(value.selectedId) || !expected.has(value.selectedId)) {
      throw new ValidationFault("invalid_output", "value.selectedId");
    }
    return;
  }

  if (request.kind === "score") {
    if (!Array.isArray(value.scores) || value.scores.length !== expected.size) {
      throw new ValidationFault("invalid_output", "value.scores");
    }
    const seen = new Set<string>();
    for (const item of value.scores) {
      if (
        !isRecord(item) ||
        !isCandidateId(item.id) ||
        !expected.has(item.id) ||
        seen.has(item.id) ||
        typeof item.score !== "number" ||
        !Number.isFinite(item.score) ||
        item.score < 0 ||
        item.score > 1
      ) {
        throw new ValidationFault("invalid_output", "value.scores");
      }
      seen.add(item.id);
    }
    return;
  }

  if (
    !Array.isArray(value.orderedIds) ||
    value.orderedIds.length === 0 ||
    value.orderedIds.length > expected.size ||
    (request.constraints.maxOutputItems !== undefined &&
      value.orderedIds.length > request.constraints.maxOutputItems)
  ) {
    throw new ValidationFault("invalid_output", "value.orderedIds");
  }
  const seen = new Set<string>();
  for (const id of value.orderedIds) {
    if (!isCandidateId(id) || !expected.has(id) || seen.has(id)) {
      throw new ValidationFault("invalid_output", "value.orderedIds");
    }
    seen.add(id);
  }
}

export function validateAssessment(assessment: ConfidenceAssessment, deterministic: boolean): void {
  const input: unknown = assessment;
  if (
    !isRecord(input) ||
    !OUTCOMES.includes(input.outcome as (typeof OUTCOMES)[number]) ||
    typeof input.calibrated !== "boolean" ||
    !isText(input.reasonCode, 128) ||
    !(
      input.confidence === null ||
      (typeof input.confidence === "number" &&
        Number.isFinite(input.confidence) &&
        input.confidence >= 0 &&
        input.confidence <= 1)
    ) ||
    input.calibrated !== (input.confidence !== null) ||
    (deterministic && input.confidence !== null) ||
    (!deterministic && input.outcome === "accept" && !input.calibrated)
  ) {
    throw new ValidationFault("policy_failure", "confidenceAssessment");
  }
}
