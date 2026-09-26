import type { DecisionError, DecisionErrorCode } from "./types.js";

const SAFE_MESSAGES: Readonly<Record<DecisionErrorCode, string>> = {
  invalid_request: "Decision request failed validation",
  unsupported: "No backend supports this decision request",
  privacy_denied: "No permitted backend can receive this request",
  unavailable: "Decision backend is unavailable",
  timeout: "Decision deadline expired",
  cancelled: "Decision was cancelled",
  invalid_output: "Decision backend returned invalid output",
  backend_failure: "Decision backend failed",
  policy_failure: "Decision policy failed",
};

const RETRYABLE: Readonly<Record<DecisionErrorCode, boolean>> = {
  invalid_request: false,
  unsupported: false,
  privacy_denied: false,
  unavailable: true,
  timeout: true,
  cancelled: false,
  invalid_output: false,
  backend_failure: true,
  policy_failure: false,
};

export class DecisionBackendFailure extends Error {
  constructor(
    readonly code: "unavailable" | "timeout" | "cancelled" | "invalid_output" | "backend_failure",
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "DecisionBackendFailure";
  }
}

export class ValidationFault extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_output" | "policy_failure",
    readonly field?: string,
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "ValidationFault";
  }
}

export function decisionError(
  code: DecisionErrorCode,
  backendId?: string,
  field?: string,
): DecisionError {
  return {
    code,
    message: SAFE_MESSAGES[code],
    retryable: RETRYABLE[code],
    ...(backendId === undefined ? {} : { backendId }),
    ...(field === undefined ? {} : { field }),
  };
}

export function errorFromUnknown(cause: unknown, backendId?: string): DecisionError {
  if (cause instanceof ValidationFault) {
    return decisionError(cause.code, backendId, cause.field);
  }
  if (cause instanceof DecisionBackendFailure) {
    return decisionError(cause.code, backendId);
  }
  return decisionError("backend_failure", backendId);
}
