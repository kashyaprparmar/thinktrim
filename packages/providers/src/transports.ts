import type {
  SidecarOperation,
  SidecarRequestOptions,
} from "../../../services/laya-sidecar/node/client.mjs";
import { DecisionBackendFailure } from "@thinktrim/core";
import type { SystemOneQuestion, SystemOneRequest, SystemOneState } from "./system-one.js";

export interface SystemOneTransportOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly headers?: HeadersInit;
  readonly useDefaultHeaders?: boolean;
}

/** Provider status without response text, which may contain sensitive information. */
export class SystemOneHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super("System One HTTP request failed");
    this.name = "SystemOneHTTPError";
  }
}

/** Provider supplies its own endpoint and headers; this transport handles JSON HTTP only. */
export interface SystemOneHTTPTransport {
  postSystemOne(request: SystemOneRequest, options?: SystemOneTransportOptions): Promise<unknown>;
  getJson?(url: string, options?: SystemOneTransportOptions): Promise<unknown>;
}

export interface FetchSystemOneHTTPTransportOptions {
  readonly endpoint: string;
  readonly fetch?: typeof fetch;
  readonly headers?: HeadersInit | (() => HeadersInit);
  readonly maxResponseBytes?: number;
}

/** Shared bounded JSON transport for provider endpoints that implement System One. */
export class FetchSystemOneHTTPTransport implements SystemOneHTTPTransport {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly defaultHeaders: HeadersInit | (() => HeadersInit);
  private readonly maxResponseBytes: number;

  constructor(options: FetchSystemOneHTTPTransportOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new TypeError("System One endpoint must use HTTP or HTTPS");
    }
    this.endpoint = endpoint.toString();
    this.fetcher = options.fetch ?? fetch;
    this.defaultHeaders = options.headers ?? {};
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new TypeError("maxResponseBytes must be a positive integer");
    }
  }

  postSystemOne(
    request: SystemOneRequest,
    options: SystemOneTransportOptions = {},
  ): Promise<unknown> {
    let body: string;
    try {
      body = JSON.stringify(request);
    } catch {
      return Promise.reject(new TypeError("System One request is not JSON serializable"));
    }
    return this.send(this.endpoint, "POST", body, options);
  }

  getJson(url: string, options: SystemOneTransportOptions = {}): Promise<unknown> {
    return this.send(url, "GET", undefined, options);
  }

  private async send(
    url: string,
    method: "GET" | "POST",
    body: string | undefined,
    options: SystemOneTransportOptions,
  ): Promise<unknown> {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new TypeError("System One endpoint must use HTTP or HTTPS");
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new TypeError("timeoutMs must be between 1 and 120000");
    }
    if (options.signal?.aborted) throw new DecisionBackendFailure("cancelled");

    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let rejectOnAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(new DecisionBackendFailure(timedOut ? "timeout" : "cancelled"));
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    const headers = new Headers(
      options.useDefaultHeaders === false
        ? undefined
        : typeof this.defaultHeaders === "function"
          ? this.defaultHeaders()
          : this.defaultHeaders,
    );
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    headers.set("Accept", "application/json");
    if (body !== undefined) headers.set("Content-Type", "application/json");
    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetcher(target, {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new SystemOneHTTPError(response.status, response.headers.get("retry-after"));
          }
          if (method === "GET" && response.status === 204) return undefined;
          return this.readJson(response, controller.signal);
        })(),
        aborted,
      ]);
    } catch (error) {
      if (options.signal?.aborted) throw new DecisionBackendFailure("cancelled");
      if (timedOut) throw new DecisionBackendFailure("timeout");
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (rejectOnAbort) controller.signal.removeEventListener("abort", rejectOnAbort);
    }
  }

  private async readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > this.maxResponseBytes) {
      throw new DecisionBackendFailure("invalid_output");
    }
    if (!response.body) throw new DecisionBackendFailure("invalid_output");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteCount = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new DecisionBackendFailure("timeout");
        const { done, value } = await reader.read();
        if (done) break;
        byteCount += value.byteLength;
        if (byteCount > this.maxResponseBytes) throw new DecisionBackendFailure("invalid_output");
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const data = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as unknown;
    } catch {
      throw new DecisionBackendFailure("invalid_output");
    }
  }
}

/** Laya's Python Router accepts state and questions without Jev's required model field. */
export interface LayaLocalInvocation {
  readonly state: SystemOneState;
  readonly questions: Readonly<Record<string, SystemOneQuestion>>;
  readonly model?: string;
  readonly lang?: string;
}

/** Low-level persistent Node process transport for the versioned Python sidecar protocol. */
export interface LayaSidecarTransport {
  start(signal?: AbortSignal): Promise<void>;
  request(
    op: SidecarOperation | string,
    params?: unknown,
    options?: SidecarRequestOptions,
  ): Promise<unknown>;
  shutdown(): Promise<void>;
}
