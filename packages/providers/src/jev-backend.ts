import {
  CONTRACT_SCHEMA_VERSION,
  DecisionBackendFailure,
  ValidationFault,
  validateRequest,
} from "@thinktrim/core";
import type {
  BackendCapabilities,
  BackendHealth,
  BackendPrediction,
  DecisionBackend,
  DecisionKind,
  DecisionRequest,
} from "@thinktrim/core";
import {
  createSystemOneRequest,
  mapSystemOnePrediction,
  validateSystemOneResponse,
} from "./system-one-decision.js";
import { FetchSystemOneHTTPTransport, SystemOneHTTPError } from "./transports.js";

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.13";
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 524, 529]);
const RETRYABLE_NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT"]);

export interface JevBackendOptions {
  /** Defaults to OPENROUTER_API_KEY. Never retained in traces or errors. */
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  /** Total backend time budget, also capped by the decision deadline. */
  readonly timeoutMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
}

/** Safe diagnostic details only; response bodies and credentials are never attached. */
export class JevBackendError extends DecisionBackendFailure {
  constructor(
    code: "unavailable" | "timeout" | "cancelled" | "invalid_output" | "backend_failure",
    readonly status?: number,
    readonly attempts?: number,
  ) {
    super(code);
    this.name = "JevBackendError";
  }
}

function networkCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof candidate.code === "string") return candidate.code;
  return typeof candidate.cause?.code === "string" ? candidate.cause.code : undefined;
}

function parseRetryAfter(value: string | null, fallbackMs: number): number {
  if (value === null) return fallbackMs;
  const seconds = Number(value);
  const absolute = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(absolute) && absolute >= 0 ? Math.min(absolute, 2_000) : fallbackMs;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new JevBackendError("cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new JevBackendError("cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class JevBackend implements DecisionBackend {
  readonly provider = "jev" as const;
  readonly channel = "http" as const;
  readonly capabilities: BackendCapabilities & { readonly locality: "remote" } = {
    id: "jev-openrouter",
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    modelVersion: MODEL,
    kinds: ["binary", "choice", "score"],
    locality: "remote",
    maxInputBytes: 65_536,
    maxCandidates: 16,
    supportsBatch: false,
    supportsCancellation: true,
  };
  private readonly apiKey: string | undefined;
  private readonly transport: FetchSystemOneHTTPTransport;
  private readonly timeoutMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: JevBackendOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 200;
    for (const [name, value, max] of [
      ["timeoutMs", this.timeoutMs, 120_000],
      ["attemptTimeoutMs", this.attemptTimeoutMs, 120_000],
      ["maxAttempts", this.maxAttempts, 5],
      ["retryBaseDelayMs", this.retryBaseDelayMs, 10_000],
    ] as const) {
      if (
        !Number.isSafeInteger(value) ||
        value < (name === "retryBaseDelayMs" ? 0 : 1) ||
        value > max
      ) {
        throw new TypeError(`${name} is out of range`);
      }
    }
    this.transport = new FetchSystemOneHTTPTransport({
      endpoint: ENDPOINT,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      headers: () => ({
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      }),
    });
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    if (signal?.aborted) throw new JevBackendError("cancelled");
    return this.apiKey?.trim() ? "healthy" : "unavailable";
  }

  async predict<K extends DecisionKind>(
    request: DecisionRequest<K>,
    signal?: AbortSignal,
  ): Promise<BackendPrediction<K>> {
    const inputBytes = validateRequest(request);
    if (
      request.kind === "ranking" ||
      (request.candidates?.length ?? 0) > this.capabilities.maxCandidates
    ) {
      throw new ValidationFault("invalid_request", "kind");
    }
    if (inputBytes > this.capabilities.maxInputBytes) {
      throw new ValidationFault("invalid_request", "request");
    }
    if (
      request.constraints.locality !== "remote_allowed" ||
      request.dataClasses.some(
        (dataClass) => !request.constraints.allowedRemoteData.includes(dataClass),
      ) ||
      ((request.candidates?.length ?? 0) > 0 &&
        !request.constraints.allowedRemoteData.includes("paths") &&
        !request.constraints.allowedRemoteData.includes("summaries")) ||
      ((request.evidence?.length ?? 0) > 0 &&
        !request.constraints.allowedRemoteData.includes("summaries"))
    ) {
      throw new ValidationFault("invalid_request", "constraints.allowedRemoteData");
    }
    if (signal?.aborted) throw new JevBackendError("cancelled");
    if (!this.apiKey?.trim()) throw new JevBackendError("unavailable");

    const wireRequest = createSystemOneRequest(request, MODEL);
    if (
      new TextEncoder().encode(JSON.stringify(wireRequest)).byteLength >
      this.capabilities.maxInputBytes
    ) {
      throw new ValidationFault("invalid_request", "request");
    }
    const deadline = Date.now() + Math.min(this.timeoutMs, request.constraints.deadlineMs);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new JevBackendError("timeout", undefined, attempt - 1);
      try {
        const raw = await this.transport.postSystemOne(wireRequest, {
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: Math.min(remaining, this.attemptTimeoutMs),
        });
        const response = validateSystemOneResponse(raw, wireRequest, MODEL);
        return mapSystemOnePrediction(request, response);
      } catch (error) {
        if (error instanceof ValidationFault) throw error;
        if (
          signal?.aborted ||
          (error instanceof DecisionBackendFailure && error.code === "cancelled")
        ) {
          throw new JevBackendError("cancelled", undefined, attempt);
        }
        const status = error instanceof SystemOneHTTPError ? error.status : undefined;
        const timedOut =
          (error instanceof DecisionBackendFailure && error.code === "timeout") ||
          status === 408 ||
          status === 524;
        const retryable =
          (status !== undefined && RETRYABLE_STATUS.has(status)) ||
          (error instanceof DecisionBackendFailure && error.code === "timeout") ||
          RETRYABLE_NETWORK_CODES.has(networkCode(error) ?? "");
        if (!retryable || attempt === this.maxAttempts) {
          if (error instanceof DecisionBackendFailure && error.code === "invalid_output") {
            throw new JevBackendError("invalid_output", undefined, attempt);
          }
          if (status !== undefined && !RETRYABLE_STATUS.has(status)) {
            throw new JevBackendError("backend_failure", status, attempt);
          }
          throw new JevBackendError(timedOut ? "timeout" : "unavailable", status, attempt);
        }
        const fallback = Math.min(this.retryBaseDelayMs * 2 ** (attempt - 1), 2_000);
        const waitMs =
          error instanceof SystemOneHTTPError
            ? parseRetryAfter(error.retryAfter, fallback)
            : fallback;
        if (waitMs >= deadline - Date.now()) throw new JevBackendError("timeout", status, attempt);
        await delay(waitMs, signal);
      }
    }
    throw new JevBackendError("unavailable");
  }
}
