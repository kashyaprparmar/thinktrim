import { CONTRACT_SCHEMA_VERSION } from "@thinktrim/shared";
import { DecisionBackendFailure } from "./errors.js";
import type {
  BackendCapabilities,
  BackendHealth,
  BackendPrediction,
  DecisionBackend,
  DecisionKind,
  DecisionRequest,
} from "./types.js";

export type FakeReply =
  | BackendPrediction
  | Error
  | ((
      request: DecisionRequest,
      signal?: AbortSignal,
    ) => BackendPrediction | Promise<BackendPrediction>);

export interface FakeBackendOptions {
  readonly capabilities?: Partial<BackendCapabilities>;
  readonly health?: BackendHealth;
}

/** A scripted backend for contract and engine tests. It has no provider behavior. */
export class FakeBackend implements DecisionBackend {
  readonly capabilities: BackendCapabilities;
  readonly calls: { readonly request: DecisionRequest; readonly signal?: AbortSignal }[] = [];
  healthCalls = 0;
  healthStatus: BackendHealth;
  private readonly replies: FakeReply[] = [];

  constructor(options: FakeBackendOptions = {}) {
    this.capabilities = {
      id: "fake",
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      modelVersion: "test",
      kinds: ["binary", "choice", "score", "ranking"],
      locality: "local",
      maxInputBytes: 1_048_576,
      maxCandidates: 1000,
      supportsBatch: false,
      supportsCancellation: true,
      ...options.capabilities,
    };
    this.healthStatus = options.health ?? "healthy";
  }

  enqueue(reply: FakeReply): void {
    this.replies.push(reply);
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    this.healthCalls += 1;
    if (signal?.aborted) {
      throw new DecisionBackendFailure("cancelled");
    }
    return this.healthStatus;
  }

  async predict<K extends DecisionKind>(
    request: DecisionRequest<K>,
    signal?: AbortSignal,
  ): Promise<BackendPrediction<K>> {
    this.calls.push({ request, ...(signal === undefined ? {} : { signal }) });
    if (signal?.aborted) {
      throw new DecisionBackendFailure("cancelled");
    }
    const reply = this.replies.shift();
    if (reply === undefined) {
      throw new DecisionBackendFailure("unavailable");
    }
    if (reply instanceof Error) {
      throw reply;
    }
    const prediction = typeof reply === "function" ? await reply(request, signal) : reply;
    // The fake deliberately permits malformed replies so engine validation can be tested.
    return prediction as BackendPrediction<K>;
  }
}
