import { ContextRankingPolicy } from "@thinktrim/context-ranker";
import { BackendRouter, CoreDecisionEngine } from "@thinktrim/core";
import type {
  DecisionKind,
  DecisionPolicy,
  DecisionRequest,
  DecisionValue,
  RemoteDataClass,
} from "@thinktrim/core";
import { ProfileConfidencePolicy } from "@thinktrim/decision-policies";
import { JevBackend } from "@thinktrim/providers/jev";

export type McpDecisionBackend = "deterministic" | "jev";

export interface McpDecisionBackendConfig {
  readonly backend: McpDecisionBackend;
  /** Explicit remote data-egress consent. Nothing is sent remotely without it. */
  readonly allowedRemoteData?: readonly RemoteDataClass[];
}

export type McpDecisionBackendState =
  "deterministic" | "ready" | "missing_api_key" | "egress_not_permitted";

export interface McpDecisionBackendStatus {
  readonly backend: McpDecisionBackend;
  readonly state: McpDecisionBackendState;
  /** Tools that may send data to the remote backend when the state is `ready`. */
  readonly appliesTo: readonly string[];
  readonly calibrated: false;
  readonly remote?: {
    readonly provider: "openrouter";
    readonly endpointHost: "openrouter.ai";
    readonly model: string;
    readonly apiKeyEnv: "OPENROUTER_API_KEY";
    readonly apiKeyPresent: boolean;
    readonly allowedRemoteData: readonly RemoteDataClass[];
    readonly requiredRemoteData: readonly RemoteDataClass[];
  };
}

export interface McpDecisionComposition {
  readonly status: McpDecisionBackendStatus;
  /** Present only when a remote ranking request is fully permitted and configured. */
  readonly remoteRanker?: ContextRankingPolicy;
  readonly allowedRemoteData: readonly RemoteDataClass[];
}

export interface ComposeDecisionBackendOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam for the Jev HTTP transport. */
  readonly fetch?: typeof fetch;
}

const REMOTE_DATA_CLASSES: readonly RemoteDataClass[] = ["task", "paths", "summaries", "snippets"];
/** Context-ranking score requests carry the task, candidate paths, and metadata summaries. */
export const RANK_REMOTE_DATA: readonly RemoteDataClass[] = ["task", "paths", "summaries"];

export function parseDecisionBackend(value: string): McpDecisionBackend {
  if (value === "deterministic" || value === "jev") return value;
  throw new TypeError("--decision-backend must be deterministic or jev");
}

export function parseRemoteDataClasses(value: string): RemoteDataClass[] {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    !items.length ||
    items.some((item) => !REMOTE_DATA_CLASSES.includes(item as RemoteDataClass))
  ) {
    throw new TypeError(
      `--allow-remote-data accepts a comma list of: ${REMOTE_DATA_CLASSES.join(", ")}`,
    );
  }
  return [...new Set(items)] as RemoteDataClass[];
}

const scorePolicy: DecisionPolicy = {
  resolveExactly<K extends DecisionKind>(): DecisionValue<K> | undefined {
    return undefined;
  },
  validate<K extends DecisionKind>(request: DecisionRequest<K>, value: DecisionValue<K>): void {
    if (request.kind !== value.kind) throw new TypeError("Decision kind does not match request.");
  },
  risk() {
    return "low";
  },
};

export function composeDecisionBackend(
  config: McpDecisionBackendConfig = { backend: "deterministic" },
  options: ComposeDecisionBackendOptions = {},
): McpDecisionComposition {
  const allowedRemoteData = [...new Set(config.allowedRemoteData ?? [])];
  if (config.backend === "deterministic") {
    return {
      status: {
        backend: "deterministic",
        state: "deterministic",
        appliesTo: [],
        calibrated: false,
      },
      allowedRemoteData: [],
    };
  }
  const apiKey = (options.env ?? process.env).OPENROUTER_API_KEY?.trim() ?? "";
  const jev = new JevBackend({
    apiKey,
    timeoutMs: 20_000,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const permitted = RANK_REMOTE_DATA.every((item) => allowedRemoteData.includes(item));
  const state: McpDecisionBackendState = !permitted
    ? "egress_not_permitted"
    : apiKey
      ? "ready"
      : "missing_api_key";
  const status: McpDecisionBackendStatus = {
    backend: "jev",
    state,
    appliesTo: ["thinktrim_rank"],
    calibrated: false,
    remote: {
      provider: "openrouter",
      endpointHost: "openrouter.ai",
      model: jev.capabilities.modelVersion,
      apiKeyEnv: "OPENROUTER_API_KEY",
      apiKeyPresent: apiKey.length > 0,
      allowedRemoteData,
      requiredRemoteData: RANK_REMOTE_DATA,
    },
  };
  if (state !== "ready") return { status, allowedRemoteData };
  const engine = new CoreDecisionEngine({
    backends: [jev],
    router: new BackendRouter(),
    decisionPolicy: scorePolicy,
    // No calibrator ships, so Jev scores stay uncalibrated and cannot reorder results.
    confidencePolicy: new ProfileConfidencePolicy(),
  });
  return {
    status,
    allowedRemoteData,
    remoteRanker: new ContextRankingPolicy({
      engine,
      strategy: "score",
      uncalibratedScores: "advisory",
    }),
  };
}

export function describeDecisionBackend(status: McpDecisionBackendStatus): string {
  if (status.backend === "deterministic") {
    return "ThinkTrim MCP: deterministic mode; no repository data leaves this machine.";
  }
  const allowed = status.remote?.allowedRemoteData.join(",") || "none";
  switch (status.state) {
    case "ready":
      return `ThinkTrim MCP: Jev advisory scoring enabled for thinktrim_rank; sends task text, candidate paths, and symbol/import summaries (permitted: ${allowed}) to openrouter.ai. Scores are uncalibrated.`;
    case "missing_api_key":
      return "ThinkTrim MCP: Jev requested but OPENROUTER_API_KEY is not set in the server environment; using deterministic ranking only.";
    default:
      return `ThinkTrim MCP: Jev requested but --allow-remote-data must include ${RANK_REMOTE_DATA.join(",")} (got: ${allowed}); using deterministic ranking only.`;
  }
}
