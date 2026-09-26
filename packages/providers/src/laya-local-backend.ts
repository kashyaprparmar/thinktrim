import type {
  BackendCapabilities,
  BackendHealth,
  BackendPrediction,
  DecisionBackend,
  DecisionKind,
  DecisionRequest,
} from "@thinktrim/core";
import { DecisionBackendFailure, ValidationFault, validateRequest } from "@thinktrim/core";
import { CONTRACT_SCHEMA_VERSION } from "@thinktrim/shared";
import { LayaSidecarClient, SidecarError } from "../../../services/laya-sidecar/node/client.mjs";
import type { SidecarClientOptions } from "../../../services/laya-sidecar/node/client.mjs";
import type { LayaLocalInvocation } from "./transports.js";
import type { LayaSidecarTransport } from "./transports.js";
import {
  createSystemOneRequest,
  mapSystemOnePrediction,
  validateSystemOneResponse,
} from "./system-one-decision.js";

export type LayaModel = "english" | "multilingual" | "typed-decisions";
export type LayaDevice = "auto" | "cpu" | "cuda" | "mps";
export type LanguageHint = string | ((request: DecisionRequest) => string | undefined);

export type LayaSidecarClientLike = LayaSidecarTransport;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LayaLocalBackendOptions {
  readonly model?: LayaModel;
  readonly device?: LayaDevice;
  readonly languageHint?: LanguageHint;
  /** Start the worker lazily, then load the configured model on first use. */
  readonly preload?: boolean;
  readonly requestTimeoutMs?: number;
  readonly sidecar?: SidecarClientOptions;
  readonly maxQueuedRequests?: number;
  readonly client?: LayaSidecarClientLike;
  /** Allows tests and embedders to provide the same small process-client contract. */
  readonly clientFactory?: (options: SidecarClientOptions) => LayaSidecarClientLike;
}

export interface LayaLocalBackendMetrics {
  readonly predictionCalls: number;
  readonly batchCalls: number;
  readonly decisions: number;
  readonly totalQueueTimeMs: number;
  readonly totalInferenceLatencyMs: number;
  readonly lastBatchSize: number;
  readonly maxBatchSize: number;
}

interface QueueWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

interface PendingPrediction {
  readonly request: DecisionRequest;
  readonly enqueuedAt: number;
  readonly resolve: (prediction: BackendPrediction) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
  cancelled: boolean;
}

class SingleWorkerGate {
  private busy = false;
  private readonly waiters: QueueWaiter[] = [];

  constructor(private readonly maxQueued: number) {}

  get queuedCount(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal, allowQueueOverflow = false): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DecisionBackendFailure("cancelled"));
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(this.releaseFactory());
    }
    if (!allowQueueOverflow && this.waiters.length >= this.maxQueued) {
      return Promise.reject(new DecisionBackendFailure("unavailable"));
    }
    return new Promise((resolve, reject) => {
      const waiter: QueueWaiter = {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(signal === undefined
          ? {}
          : {
              abort: () => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) this.waiters.splice(index, 1);
                reject(new DecisionBackendFailure("cancelled"));
              },
            }),
      };
      if (waiter.abort) signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (!next) {
        this.busy = false;
        return;
      }
      if (next.abort) next.signal?.removeEventListener("abort", next.abort);
      next.resolve(this.releaseFactory());
    };
  }
}

function createInvocation(
  request: DecisionRequest,
  model: LayaModel | undefined,
  lang: string | undefined,
): LayaLocalInvocation {
  return {
    ...createSystemOneRequest(request, model),
    ...(lang === undefined ? {} : { lang }),
  };
}

function toBackendFailure(error: unknown): DecisionBackendFailure {
  if (error instanceof DecisionBackendFailure) return error;
  if (error instanceof SidecarError) {
    if (error.code === "timeout") return new DecisionBackendFailure("timeout");
    if (error.code === "cancelled") return new DecisionBackendFailure("cancelled");
    if (error.code === "invalid_json" || error.code === "invalid_output") {
      return new DecisionBackendFailure("invalid_output");
    }
    return new DecisionBackendFailure("unavailable");
  }
  return new DecisionBackendFailure("backend_failure");
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DecisionBackendFailure("cancelled"));
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DecisionBackendFailure("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class LayaLocalBackend implements DecisionBackend {
  readonly provider = "laya" as const;
  readonly channel = "sidecar" as const;
  readonly capabilities: BackendCapabilities & { readonly locality: "local" };
  private readonly client: LayaSidecarClientLike;
  private readonly model: LayaModel | undefined;
  private readonly languageHint: LanguageHint | undefined;
  private readonly preloadOnStart: boolean;
  private readonly requestTimeoutMs: number;
  private readonly maxQueuedRequests: number;
  private readonly gate: SingleWorkerGate;
  private readonly pendingPredictions: PendingPrediction[] = [];
  private pendingCount = 0;
  private pendingDrain: (() => void) | undefined;
  private batchFlushScheduled = false;
  private starting: Promise<void> | undefined;
  private shutdownTask: Promise<void> | undefined;
  private preloaded = false;
  private closing = false;
  private closed = false;
  private predictionCalls = 0;
  private batchCalls = 0;
  private decisions = 0;
  private totalQueueTimeMs = 0;
  private totalInferenceLatencyMs = 0;
  private lastBatchSize = 0;
  private maxBatchSize = 0;

  constructor(options: LayaLocalBackendOptions = {}) {
    const device = options.device ?? "auto";
    if (!(device === "auto" || device === "cpu" || device === "cuda" || device === "mps")) {
      throw new TypeError("Unsupported Laya device");
    }
    const maxQueued = options.maxQueuedRequests ?? 32;
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 1024) {
      throw new TypeError("maxQueuedRequests must be between 0 and 1024");
    }
    if (typeof options.languageHint === "string") validateLanguage(options.languageHint);
    this.model = options.model;
    this.languageHint = options.languageHint;
    this.preloadOnStart = options.preload ?? false;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new TypeError("requestTimeoutMs must be a positive integer");
    }
    this.maxQueuedRequests = maxQueued;
    this.gate = new SingleWorkerGate(maxQueued);
    const clientOptions: SidecarClientOptions = {
      ...options.sidecar,
      requestTimeoutMs: this.requestTimeoutMs,
      env: {
        ...options.sidecar?.env,
        THINKTRIM_LAYA_DEVICE: device,
      },
    };
    this.client =
      options.client ??
      (options.clientFactory ?? ((config) => new LayaSidecarClient(config)))(clientOptions);
    this.capabilities = {
      id: "laya-local",
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      modelVersion: "laya-router",
      kinds: ["binary", "choice", "score"],
      locality: "local",
      maxInputBytes: 900_000,
      maxCandidates: 16,
      supportsBatch: true,
      supportsCancellation: true,
    };
  }

  get metrics(): LayaLocalBackendMetrics & { readonly queuedRequests: number } {
    return {
      predictionCalls: this.predictionCalls,
      batchCalls: this.batchCalls,
      decisions: this.decisions,
      totalQueueTimeMs: this.totalQueueTimeMs,
      totalInferenceLatencyMs: this.totalInferenceLatencyMs,
      lastBatchSize: this.lastBatchSize,
      maxBatchSize: this.maxBatchSize,
      queuedRequests: this.gate.queuedCount,
    };
  }

  private ensureStarted(signal?: AbortSignal): Promise<void> {
    if (!this.starting) {
      this.starting = (async () => {
        await this.client.start();
        if (this.preloadOnStart && !this.preloaded) await this.preloadModel();
      })().catch((error: unknown) => {
        this.starting = undefined;
        throw toBackendFailure(error);
      });
    }
    return waitWithSignal(this.starting, signal);
  }

  private assertOpen(): void {
    if (this.closing || this.closed) throw new DecisionBackendFailure("unavailable");
  }

  private async preloadModel(signal?: AbortSignal): Promise<void> {
    if (this.preloaded) return;
    await this.client.request(
      "preload",
      { model: this.model ?? "english" },
      {
        ...(signal === undefined ? {} : { signal }),
      },
    );
    this.preloaded = true;
  }

  async start(signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    const release = await this.gate.acquire(signal);
    try {
      await this.ensureStarted(signal);
    } catch (error) {
      throw toBackendFailure(error);
    } finally {
      release();
    }
  }

  async preload(signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    const release = await this.gate.acquire(signal);
    try {
      await this.ensureStarted(signal);
      await this.preloadModel(signal);
    } catch (error) {
      throw toBackendFailure(error);
    } finally {
      release();
    }
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    this.assertOpen();
    const release = await this.gate.acquire(signal);
    try {
      await this.ensureStarted(signal);
      const response: unknown = await this.client.request("health", undefined, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.requestTimeoutMs,
      });
      return isRecord(response) && response.status === "ready" ? "healthy" : "unavailable";
    } catch (error) {
      throw toBackendFailure(error);
    } finally {
      release();
    }
  }

  predict<K extends DecisionKind>(
    request: DecisionRequest<K>,
    signal?: AbortSignal,
  ): Promise<BackendPrediction<K>> {
    if (this.closing || this.closed) {
      return Promise.reject(new DecisionBackendFailure("unavailable"));
    }
    const inputBytes = validateRequest(request);
    if (
      request.kind === "ranking" ||
      (request.candidates?.length ?? 0) > this.capabilities.maxCandidates ||
      inputBytes > this.capabilities.maxInputBytes
    ) {
      return Promise.reject(new ValidationFault("invalid_request", "request"));
    }
    if (signal?.aborted) return Promise.reject(new DecisionBackendFailure("cancelled"));
    if (this.pendingPredictions.length >= this.maxQueuedRequests + 16) {
      return Promise.reject(new DecisionBackendFailure("unavailable"));
    }
    return new Promise<BackendPrediction<K>>((resolve, reject) => {
      this.pendingCount += 1;
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        this.pendingCount -= 1;
        if (this.pendingCount === 0) this.pendingDrain?.();
        return true;
      };
      const pending: PendingPrediction = {
        request,
        enqueuedAt: performance.now(),
        resolve: (value) => {
          if (settle()) resolve(value as BackendPrediction<K>);
        },
        reject: (error) => {
          if (settle()) reject(error);
        },
        cancelled: false,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal) {
        pending.abort = () => {
          pending.cancelled = true;
          const queuedIndex = this.pendingPredictions.indexOf(pending);
          if (queuedIndex >= 0) this.pendingPredictions.splice(queuedIndex, 1);
          reject(new DecisionBackendFailure("cancelled"));
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pendingPredictions.push(pending);
      this.scheduleBatchFlush();
    });
  }

  private scheduleBatchFlush(): void {
    if (this.batchFlushScheduled || this.pendingPredictions.length === 0) return;
    this.batchFlushScheduled = true;
    queueMicrotask(() => {
      this.batchFlushScheduled = false;
      void this.flushBatchQueue();
    });
  }

  private async flushBatchQueue(): Promise<void> {
    const first = this.pendingPredictions.find((item) => !item.cancelled);
    if (!first) return;
    const group: PendingPrediction[] = [];
    for (let index = 0; index < this.pendingPredictions.length && group.length < 16;) {
      const item = this.pendingPredictions[index];
      if (!item) break;
      if (item.cancelled) {
        this.pendingPredictions.splice(index, 1);
      } else if (item.request.kind === first.request.kind) {
        group.push(item);
        this.pendingPredictions.splice(index, 1);
      } else {
        index += 1;
      }
    }
    const controller = new AbortController();
    const maybeAbortBatch = () => {
      if (group.every((item) => item.cancelled)) controller.abort();
    };
    for (const item of group) {
      if (item.signal) {
        item.signal.addEventListener("abort", maybeAbortBatch, { once: true });
        item.signal.removeEventListener("abort", item.abort!);
        item.abort = () => {
          item.cancelled = true;
          item.reject(new DecisionBackendFailure("cancelled"));
          maybeAbortBatch();
        };
        item.signal.addEventListener("abort", item.abort, { once: true });
      }
    }
    try {
      if (group.length === 1) {
        const item = group[0]!;
        const prediction = await this.predictSingle(
          item.request,
          controller.signal,
          item.enqueuedAt,
        );
        if (!item.cancelled) item.resolve(prediction);
      } else {
        const kind = first.request.kind;
        const requests = group.map((item) => item.request);
        let predictions: readonly BackendPrediction[];
        if (kind === "binary") {
          predictions = await this.performBatch(
            requests as DecisionRequest<"binary">[],
            controller.signal,
            group.map((item) => item.enqueuedAt),
            true,
          );
        } else if (kind === "choice") {
          predictions = await this.performBatch(
            requests as DecisionRequest<"choice">[],
            controller.signal,
            group.map((item) => item.enqueuedAt),
            true,
          );
        } else if (kind === "score") {
          predictions = await this.performBatch(
            requests as DecisionRequest<"score">[],
            controller.signal,
            group.map((item) => item.enqueuedAt),
            true,
          );
        } else {
          throw new DecisionBackendFailure("backend_failure");
        }
        predictions.forEach((prediction, index) => {
          const item = group[index];
          if (item && !item.cancelled) item.resolve(prediction);
        });
      }
    } catch (error) {
      const failure = toBackendFailure(error);
      for (const item of group) if (!item.cancelled) item.reject(failure);
    } finally {
      for (const item of group) {
        if (item.abort) item.signal?.removeEventListener("abort", item.abort);
        item.signal?.removeEventListener("abort", maybeAbortBatch);
      }
      this.scheduleBatchFlush();
    }
  }

  private async predictSingle<K extends DecisionKind>(
    request: DecisionRequest<K>,
    signal?: AbortSignal,
    queueStartedAt?: number,
  ): Promise<BackendPrediction<K>> {
    const queuedAt = queueStartedAt ?? performance.now();
    const release = await this.gate.acquire(signal);
    this.totalQueueTimeMs += Math.max(0, performance.now() - queuedAt);
    this.predictionCalls += 1;
    this.decisions += 1;
    this.lastBatchSize = 1;
    this.maxBatchSize = Math.max(this.maxBatchSize, 1);
    let inferenceStarted: number | undefined;
    try {
      await this.ensureStarted(signal);
      const lang =
        typeof this.languageHint === "function" ? this.languageHint(request) : this.languageHint;
      if (lang !== undefined) validateLanguage(lang);
      const invocation = createInvocation(request, this.model, lang);
      inferenceStarted = performance.now();
      const raw = await this.client.request("predict", invocation, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.requestTimeoutMs,
      });
      const response = validateSystemOneResponse(raw, invocation);
      return mapSystemOnePrediction(request, response);
    } catch (error) {
      throw toBackendFailure(error);
    } finally {
      if (inferenceStarted !== undefined) {
        this.totalInferenceLatencyMs += Math.max(0, performance.now() - inferenceStarted);
      }
      release();
    }
  }

  async predictBatch<K extends DecisionKind>(
    requests: readonly DecisionRequest<K>[],
    signal?: AbortSignal,
  ): Promise<readonly BackendPrediction<K>[]> {
    return this.performBatch(requests, signal);
  }

  private async performBatch<K extends DecisionKind>(
    requests: readonly DecisionRequest<K>[],
    signal?: AbortSignal,
    queueStartedAt?: readonly number[],
    accepted = false,
  ): Promise<readonly BackendPrediction<K>[]> {
    if (!accepted) this.assertOpen();
    if (requests.length < 1 || requests.length > 16) {
      throw new ValidationFault("invalid_request", "requests");
    }
    const invocations = requests.map((request) => {
      validateRequest(request);
      if (
        (request.candidates?.length ?? 0) > this.capabilities.maxCandidates ||
        request.kind === "ranking"
      ) {
        throw new ValidationFault("invalid_request", "requests");
      }
      const lang =
        typeof this.languageHint === "function" ? this.languageHint(request) : this.languageHint;
      if (lang !== undefined) validateLanguage(lang);
      return createInvocation(request, this.model, lang);
    });
    if (new TextEncoder().encode(JSON.stringify(invocations)).byteLength > 900_000) {
      throw new ValidationFault("invalid_request", "requests");
    }
    const queuedAt = performance.now();
    const release = await this.gate.acquire(signal);
    const acquiredAt = performance.now();
    this.totalQueueTimeMs += queueStartedAt
      ? queueStartedAt.reduce((total, startedAt) => total + Math.max(0, acquiredAt - startedAt), 0)
      : Math.max(0, acquiredAt - queuedAt) * requests.length;
    this.predictionCalls += 1;
    this.batchCalls += 1;
    this.decisions += requests.length;
    this.lastBatchSize = requests.length;
    this.maxBatchSize = Math.max(this.maxBatchSize, requests.length);
    let inferenceStarted: number | undefined;
    try {
      await this.ensureStarted(signal);
      inferenceStarted = performance.now();
      const raw: unknown = await this.client.request("predictBatch", invocations, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.requestTimeoutMs,
      });
      if (!Array.isArray(raw) || raw.length !== requests.length) {
        throw new DecisionBackendFailure("invalid_output");
      }
      return raw.map((item, index) => {
        const request = requests[index];
        const invocation = invocations[index];
        if (!request || !invocation) throw new DecisionBackendFailure("invalid_output");
        const response = validateSystemOneResponse(item, invocation);
        return mapSystemOnePrediction(request, response);
      });
    } catch (error) {
      throw toBackendFailure(error);
    } finally {
      if (inferenceStarted !== undefined) {
        this.totalInferenceLatencyMs += Math.max(0, performance.now() - inferenceStarted);
      }
      release();
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    if (this.closed) return;
    this.closing = true;
    this.shutdownTask = (async () => {
      if (this.pendingCount > 0) {
        await new Promise<void>((resolve) => {
          this.pendingDrain = resolve;
        });
        this.pendingDrain = undefined;
      }
      const release = await this.gate.acquire(undefined, true);
      try {
        await this.client.shutdown();
      } catch (error) {
        throw toBackendFailure(error);
      } finally {
        this.closed = true;
        this.starting = undefined;
        this.preloaded = false;
        release();
      }
    })();
    return this.shutdownTask;
  }
}

function validateLanguage(language: string): void {
  if (!/^[A-Za-z0-9_-]{2,35}$/.test(language)) {
    throw new TypeError("languageHint must be a BCP-47-like language code");
  }
}
