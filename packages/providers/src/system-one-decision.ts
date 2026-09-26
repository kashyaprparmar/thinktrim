import { DecisionBackendFailure, ValidationFault, validateRequest } from "@thinktrim/core";
import type {
  BackendPrediction,
  DecisionKind,
  DecisionRequest,
  DecisionValue,
} from "@thinktrim/core";
import type {
  SystemOneAnswer,
  SystemOneJsonValue,
  SystemOneQuestion,
  SystemOneRequest,
  SystemOneResponse,
} from "./system-one.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validProbabilities(value: unknown, expectedKeys: readonly string[]): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key) && probability(value[key]))
  );
}

function candidateValue(candidate: {
  readonly id: string;
  readonly label?: string;
  readonly features?: Readonly<Record<string, string | number | boolean>>;
}): SystemOneJsonValue {
  return {
    id: candidate.id,
    label: candidate.label ?? candidate.id,
    features: candidate.features ?? {},
  };
}

/** Maps a validated core request to the shared provider neutral decision wire format. */
export function createSystemOneRequest(request: DecisionRequest, model?: string): SystemOneRequest {
  validateRequest(request);
  const state: Record<string, SystemOneJsonValue> = {
    category: request.category,
    task: request.task,
    evidence: request.evidence ?? [],
  };
  if (request.repositoryState !== undefined) state.repositoryState = request.repositoryState;
  if (request.candidates !== undefined) state.candidates = request.candidates.map(candidateValue);
  const questions: Record<string, SystemOneQuestion> = Object.create(null) as Record<
    string,
    SystemOneQuestion
  >;
  if (request.kind === "binary") {
    questions.decision = { type: "noul", instructions: request.task };
  } else if (request.kind === "choice") {
    const criteria: Record<string, SystemOneJsonValue> = Object.create(null) as Record<
      string,
      SystemOneJsonValue
    >;
    for (const candidate of request.candidates) criteria[candidate.id] = candidateValue(candidate);
    questions.selection = { type: "choice", instructions: request.task, criteria };
  } else if (request.kind === "score") {
    request.candidates.forEach((candidate, index) => {
      questions[`candidate_${index}`] = {
        type: "score",
        instructions: {
          task: request.task,
          candidate: candidateValue(candidate),
          instruction: "Rate this candidate's relevance to the task.",
        },
        criteria: ["not relevant", "partly relevant", "highly relevant"],
      };
    });
  } else {
    throw new ValidationFault("invalid_request", "kind");
  }
  return { ...(model === undefined ? {} : { model }), state, questions };
}

/** Validates provider JSON before any answer is mapped into the core contract. */
export function validateSystemOneResponse(
  raw: unknown,
  request: SystemOneRequest,
  expectedModelPrefix?: string,
): SystemOneResponse {
  if (
    !isRecord(raw) ||
    typeof raw.model !== "string" ||
    raw.model.length === 0 ||
    raw.model.length > 128 ||
    (expectedModelPrefix !== undefined &&
      raw.model !== expectedModelPrefix &&
      !raw.model.startsWith(`${expectedModelPrefix}-`)) ||
    !isRecord(raw.answers) ||
    !isRecord(raw.usage)
  ) {
    throw new DecisionBackendFailure("invalid_output");
  }
  const expectedNames = Object.keys(request.questions);
  if (
    Object.keys(raw.answers).length !== expectedNames.length ||
    !expectedNames.every((name) => Object.hasOwn(raw.answers as object, name))
  ) {
    throw new DecisionBackendFailure("invalid_output");
  }
  const usage = raw.usage;
  if (
    !Number.isSafeInteger(usage.input_tokens) ||
    !Number.isSafeInteger(usage.output_tokens) ||
    (usage.input_tokens as number) < 0 ||
    (usage.output_tokens as number) < 0 ||
    (usage.cost !== undefined &&
      !(typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0))
  ) {
    throw new DecisionBackendFailure("invalid_output");
  }
  for (const name of expectedNames) {
    const answer = raw.answers[name];
    const question = request.questions[name];
    if (!isRecord(answer) || !question || answer.type !== question.type) {
      throw new DecisionBackendFailure("invalid_output");
    }
    if (question.type === "noul") {
      if (!probability(answer.noul)) throw new DecisionBackendFailure("invalid_output");
    } else if (question.type === "choice") {
      const keys = Object.keys(question.criteria);
      if (
        typeof answer.choice !== "string" ||
        !keys.includes(answer.choice) ||
        !probability(answer.confidence) ||
        !validProbabilities(answer.probabilities, keys)
      ) {
        throw new DecisionBackendFailure("invalid_output");
      }
    } else {
      const keys = question.criteria.map((_, index) => String(index));
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.criteria.length - 1 ||
        !probability(answer.confidence) ||
        !validProbabilities(answer.probabilities, keys) ||
        !isRecord(answer.legend) ||
        Object.keys(answer.legend).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(answer.legend as object, key))
      ) {
        throw new DecisionBackendFailure("invalid_output");
      }
    }
  }
  if (
    (raw.provider !== undefined &&
      (typeof raw.provider !== "string" || raw.provider.length > 128)) ||
    (raw.id !== undefined && (typeof raw.id !== "string" || raw.id.length > 256))
  ) {
    throw new DecisionBackendFailure("invalid_output");
  }
  return raw as unknown as SystemOneResponse;
}

/** Converts System One typed answers and usage to the backend neutral result. */
export function mapSystemOnePrediction<K extends DecisionKind>(
  request: DecisionRequest<K>,
  response: SystemOneResponse,
): BackendPrediction<K> {
  let value: DecisionValue<K>;
  let rawSignal: number | undefined;
  if (request.kind === "binary") {
    const answer = response.answers.decision;
    if (!answer || answer.type !== "noul") throw new DecisionBackendFailure("invalid_output");
    rawSignal = answer.noul;
    value = { kind: "binary", value: answer.noul >= 0.5 } as DecisionValue<K>;
  } else if (request.kind === "choice") {
    const answer = response.answers.selection;
    const candidate = request.candidates.find(
      (item) => item.id === (answer?.type === "choice" ? answer.choice : ""),
    );
    if (!answer || answer.type !== "choice" || !candidate) {
      throw new DecisionBackendFailure("invalid_output");
    }
    rawSignal = answer.confidence;
    value = { kind: "choice", selectedId: candidate.id } as DecisionValue<K>;
  } else if (request.kind === "score") {
    const scores = request.candidates.map((candidate, index) => {
      const answer: SystemOneAnswer | undefined = response.answers[`candidate_${index}`];
      if (!answer || answer.type !== "score") throw new DecisionBackendFailure("invalid_output");
      return { id: candidate.id, score: answer.score / 2 };
    });
    value = { kind: "score", scores } as unknown as DecisionValue<K>;
  } else {
    throw new DecisionBackendFailure("backend_failure");
  }
  return {
    value,
    ...(rawSignal === undefined ? {} : { rawSignal }),
    usage: {
      unit: "tokens",
      inputUnits: response.usage.input_tokens,
      outputUnits: response.usage.output_tokens,
    },
    metadata: {
      resolvedModel: response.model,
      ...(response.provider === undefined ? {} : { provider: response.provider }),
      ...(response.usage.cost === undefined ? {} : { costUSD: response.usage.cost }),
    },
  };
}
