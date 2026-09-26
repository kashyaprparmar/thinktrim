import type { BackendIdentity, DecisionKind, DecisionRequest, DecisionResult } from "./types.js";

export interface DecisionCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface DecisionCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
}

interface CacheEntry {
  readonly key: string;
  readonly workspaceId: string;
  readonly backendId: string;
  readonly modelVersion: string;
  readonly expiresAt: number;
  readonly result: DecisionResult;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function normalizedRequest(request: DecisionRequest): unknown {
  const rest = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "id"));
  const semanticConstraints = Object.fromEntries(
    Object.entries(request.constraints).filter(([key]) => key !== "deadlineMs"),
  );
  return {
    ...rest,
    task: request.task.normalize("NFC").trim().replace(/\s+/gu, " "),
    constraints: semanticConstraints,
  };
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** In-memory, workspace-scoped cache. Only decisions with repository state are cacheable. */
export class DecisionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;

  constructor(options: DecisionCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 512;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new RangeError("ttlMs must be a positive integer");
    }
  }

  get stats(): DecisionCacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size };
  }

  async get<K extends DecisionKind>(input: {
    readonly request: DecisionRequest<K>;
    readonly backend: BackendIdentity;
    readonly workspaceId: string;
    readonly policyVersion?: string;
    readonly traceId: string;
  }): Promise<DecisionResult<K> | undefined> {
    const key = await this.key(
      input.request,
      input.backend,
      input.workspaceId,
      input.policyVersion,
    );
    if (key === undefined) {
      this.misses += 1;
      return undefined;
    }
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    const latencyMs = 0;
    return {
      ...entry.result,
      requestId: input.request.id,
      latencyMs,
      trace: {
        traceId: input.traceId,
        requestId: input.request.id,
        category: input.request.category,
        kind: input.request.kind,
        stages: [{ name: "cache", durationMs: 0, outcome: "hit", backendId: input.backend.id }],
        backendId: input.backend.id,
        cacheHit: true,
        outcome: entry.result.outcome,
        reasonCode: "cache_hit",
        latencyMs,
      },
    } as unknown as DecisionResult<K>;
  }

  async set<K extends DecisionKind>(input: {
    readonly request: DecisionRequest<K>;
    readonly backend: BackendIdentity;
    readonly workspaceId: string;
    readonly policyVersion?: string;
    readonly result: DecisionResult<K>;
  }): Promise<void> {
    if (
      input.result.error !== undefined ||
      input.result.provenance !== "backend" ||
      input.result.backend?.id !== input.backend.id ||
      input.result.backend.modelVersion !== input.backend.modelVersion
    ) {
      return;
    }
    const key = await this.key(
      input.request,
      input.backend,
      input.workspaceId,
      input.policyVersion,
    );
    if (key === undefined) return;
    this.entries.delete(key);
    this.entries.set(key, {
      key,
      workspaceId: input.workspaceId,
      backendId: input.backend.id,
      modelVersion: input.backend.modelVersion,
      expiresAt: this.now() + this.ttlMs,
      result: input.result,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  invalidateWorkspace(workspaceId: string): number {
    return this.invalidate((entry) => entry.workspaceId === workspaceId);
  }

  invalidateModel(backendId: string, modelVersion?: string): number {
    return this.invalidate(
      (entry) =>
        entry.backendId === backendId &&
        (modelVersion === undefined || entry.modelVersion === modelVersion),
    );
  }

  private invalidate(predicate: (entry: CacheEntry) => boolean): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (!predicate(entry)) continue;
      this.entries.delete(key);
      removed += 1;
    }
    return removed;
  }

  private async key(
    request: DecisionRequest,
    backend: BackendIdentity,
    workspaceId: string,
    policyVersion = "1",
  ): Promise<string | undefined> {
    const repositoryState = request.repositoryState?.trim();
    if (!repositoryState || !workspaceId.trim() || !policyVersion.trim()) return undefined;
    const identity = {
      schemaVersion: request.schemaVersion,
      category: request.category,
      backend,
      workspaceId,
      policyVersion,
      repositoryState,
      request: normalizedRequest(request),
    };
    return digest(identity);
  }
}
