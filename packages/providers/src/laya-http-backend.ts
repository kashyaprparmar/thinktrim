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
import { ConcurrencyGate } from "./concurrency-gate.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";

export type LayaHTTPModel = "english" | "multilingual" | "typed-decisions";

export interface LayaHTTPBackendOptions {
  /** Must resolve to loopback because this backend advertises local-only processing. */
  readonly endpoint?: string;
  /** Defaults to LAYA_API_KEY. */
  readonly apiKey?: string;
  /** Omit to let the Laya Router select its checkpoint. */
  readonly model?: LayaHTTPModel;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxConcurrentRequests?: number;
  readonly maxQueuedRequests?: number;
}

export interface LayaHTTPBackendMetrics {
  readonly requests: number;
  readonly totalQueueTimeMs: number;
  readonly totalInferenceLatencyMs: number;
  readonly queuedRequests: number;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("127.")) {
    const octets = normalized.split(".");
    return (
      octets.length === 4 &&
      octets.slice(1).every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
  }
  return false;
}

function mapTransportError(error: unknown): DecisionBackendFailure {
  if (error instanceof DecisionBackendFailure) return error;
  if (error instanceof SystemOneHTTPError) {
    return new DecisionBackendFailure(error.status === 408 ? "timeout" : "unavailable");
  }
  return new DecisionBackendFailure("unavailable");
}

export class LayaHTTPBackend implements DecisionBackend {
  readonly provider = "laya" as const;
  readonly channel = "http" as const;
  readonly capabilities: BackendCapabilities & { readonly locality: "local" };
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly transport: FetchSystemOneHTTPTransport;
  private readonly gate: ConcurrencyGate;
  private requests = 0;
  private totalQueueTimeMs = 0;
  private totalInferenceLatencyMs = 0;

  constructor(options: LayaHTTPBackendOptions = {}) {
    this.baseUrl = new URL(options.endpoint ?? DEFAULT_BASE_URL);
    if (
      (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") ||
      !isLoopbackHostname(this.baseUrl.hostname) ||
      this.baseUrl.username !== "" ||
      this.baseUrl.password !== "" ||
      this.baseUrl.search !== "" ||
      this.baseUrl.hash !== ""
    ) {
      throw new TypeError("Laya HTTP endpoint must be a loopback HTTP(S) URL without credentials");
    }
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new TypeError("timeoutMs must be between 1 and 120000");
    }
    this.gate = new ConcurrencyGate(
      options.maxConcurrentRequests ?? 1,
      options.maxQueuedRequests ?? 32,
    );
    const apiKey = options.apiKey ?? process.env.LAYA_API_KEY;
    this.transport = new FetchSystemOneHTTPTransport({
      endpoint: new URL("/v1/systemone", this.baseUrl).toString(),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      headers: () => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    });
    this.capabilities = {
      id: "laya-http-local",
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      modelVersion: options.model ?? "laya-router",
      kinds: ["binary", "choice", "score"],
      locality: "local",
      maxInputBytes: 1_000_000,
      maxCandidates: 16,
      supportsBatch: false,
      supportsCancellation: true,
    };
  }

  get metrics(): LayaHTTPBackendMetrics {
    return {
      requests: this.requests,
      totalQueueTimeMs: this.totalQueueTimeMs,
      totalInferenceLatencyMs: this.totalInferenceLatencyMs,
      queuedRequests: this.gate.queuedCount,
    };
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    const lease = await this.gate.acquire(signal);
    this.totalQueueTimeMs += lease.queueTimeMs;
    try {
      const healthUrl = new URL("/health", this.baseUrl).toString();
      const response: unknown = await this.transport.getJson(healthUrl, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: Math.min(this.timeoutMs, 10_000),
        useDefaultHeaders: false,
      });
      return isRecord(response) && (response.status === "ok" || response.status === "healthy")
        ? "healthy"
        : "unavailable";
    } catch (error) {
      throw mapTransportError(error);
    } finally {
      lease.release();
    }
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
    if (signal?.aborted) throw new DecisionBackendFailure("cancelled");
    const wireRequest = createSystemOneRequest(
      request,
      this.capabilities.modelVersion === "laya-router" ? undefined : this.capabilities.modelVersion,
    );
    if (
      new TextEncoder().encode(JSON.stringify(wireRequest)).byteLength >
      this.capabilities.maxInputBytes
    ) {
      throw new ValidationFault("invalid_request", "request");
    }
    const lease = await this.gate.acquire(signal);
    this.requests += 1;
    this.totalQueueTimeMs += lease.queueTimeMs;
    const inferenceStarted = performance.now();
    try {
      const raw = await this.transport.postSystemOne(wireRequest, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.timeoutMs,
      });
      return mapSystemOnePrediction(request, validateSystemOneResponse(raw, wireRequest));
    } catch (error) {
      throw mapTransportError(error);
    } finally {
      this.totalInferenceLatencyMs += Math.max(0, performance.now() - inferenceStarted);
      lease.release();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
