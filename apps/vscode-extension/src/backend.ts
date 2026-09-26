import { randomUUID } from "node:crypto";
import {
  BackendRouter,
  CoreDecisionEngine,
  DecisionCache,
  type BackendHealth,
  type DecisionBackend,
  type DecisionKind,
  type DecisionPolicy,
  type DecisionRequest,
  type DecisionRisk,
  type DecisionValue,
} from "@thinktrim/core";
import { ProfileConfidencePolicy } from "@thinktrim/decision-policies";
import { JevBackend, LayaHTTPBackend } from "@thinktrim/providers";
import { CONTRACT_SCHEMA_VERSION } from "@thinktrim/shared";
import type { ExtensionContext } from "vscode";
import { readConfiguration, type BackendChoice } from "./configuration.js";

const SECRET_PREFIX = "thinktrim.backend.apiKey.";

export interface BackendTestResult {
  readonly backend: string;
  readonly health: BackendHealth;
  readonly latencyMs: number | null;
  readonly message: string;
}

function secretKey(backend: BackendChoice): string {
  return `${SECRET_PREFIX}${backend}`;
}

function createBackend(
  backend: BackendChoice,
  endpoint: string,
  apiKey: string,
): DecisionBackend | undefined {
  if (backend === "laya-http") return new LayaHTTPBackend({ endpoint, apiKey });
  if (backend === "jev") return new JevBackend({ apiKey });
  return undefined;
}

const extensionDecisionPolicy: DecisionPolicy = {
  resolveExactly<K extends DecisionKind>(): DecisionValue<K> | undefined {
    return undefined;
  },
  validate<K extends DecisionKind>(request: DecisionRequest<K>, value: DecisionValue<K>): void {
    if (request.kind !== value.kind) throw new TypeError("Decision kind does not match request.");
  },
  risk(): DecisionRisk {
    return "low";
  },
};

export class BackendConnection {
  readonly cache = new DecisionCache();
  private currentFingerprint = "";
  private currentBackend: DecisionBackend | undefined;

  constructor(private readonly context: ExtensionContext) {}

  reset(): void {
    this.currentFingerprint = "";
    this.currentBackend = undefined;
  }

  async saveApiKey(backend: BackendChoice, value: string): Promise<void> {
    const apiKey = value.trim();
    if (
      apiKey.length < 8 ||
      apiKey.length > 2048 ||
      [...apiKey].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127;
      })
    ) {
      throw new TypeError(
        "The API key must be 8–2048 characters and contain no control characters.",
      );
    }
    await this.context.secrets.store(secretKey(backend), apiKey);
    this.reset();
  }

  async clearApiKey(backend: BackendChoice): Promise<void> {
    await this.context.secrets.delete(secretKey(backend));
    this.reset();
  }

  async getApiKey(backend: BackendChoice): Promise<string | undefined> {
    return this.context.secrets.get(secretKey(backend));
  }

  async getBackend(): Promise<DecisionBackend | undefined> {
    const config = readConfiguration();
    const fingerprint = `${config.backend}\n${config.layaEndpoint}\n${(await this.getApiKey(config.backend)) ?? ""}`;
    if (fingerprint !== this.currentFingerprint) {
      this.currentFingerprint = fingerprint;
      const apiKey = (await this.getApiKey(config.backend)) ?? "";
      this.currentBackend = createBackend(config.backend, config.layaEndpoint, apiKey);
    }
    return this.currentBackend;
  }

  async test(): Promise<BackendTestResult> {
    const config = readConfiguration();
    if (config.backend === "deterministic") {
      return {
        backend: "deterministic",
        health: "healthy",
        latencyMs: null,
        message: "Deterministic ranking is ready. It does not make a model request.",
      };
    }
    const backend = await this.getBackend();
    if (!backend) throw new Error("The selected backend is not available.");

    const remote = backend.capabilities.locality === "remote";
    const request: DecisionRequest<"binary"> = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id: `thinktrim-health-${randomUUID()}`,
      category: "backend_connection",
      kind: "binary",
      task: "Return true to confirm the ThinkTrim backend connection.",
      dataClasses: ["task"],
      constraints: {
        locality: remote ? "remote_allowed" : "local_only",
        allowedRemoteData: remote ? ["task"] : [],
        profile: "safe",
        deadlineMs: 30_000,
        maxCandidates: 1,
      },
    };
    const engine = new CoreDecisionEngine({
      backends: [backend],
      router: new BackendRouter(),
      decisionPolicy: extensionDecisionPolicy,
      confidencePolicy: new ProfileConfidencePolicy(),
    });
    const result = await engine.decide(request);
    if (result.error || !result.backend) {
      const reason = result.error?.code ?? result.outcome;
      throw Object.assign(new Error(`The backend test request failed (${reason}).`), {
        code: reason,
      });
    }
    return {
      backend: backend.capabilities.id,
      health: "healthy",
      latencyMs: Math.round(result.latencyMs),
      message: remote
        ? "The hosted backend answered a synthetic test request. No workspace data was sent."
        : "The local backend answered a synthetic test request. No workspace data was sent.",
    };
  }
}
