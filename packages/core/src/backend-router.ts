import type {
  BackendCapabilities,
  BackendHealth,
  BackendRoutingMode,
  DecisionBackend,
  DecisionRequest,
} from "./types.js";
import { isBackendCapabilities, validateRequest } from "./validation.js";

export interface BackendRoutingHint {
  /** Explicit relative latency rank; smaller is faster. */
  readonly latencyRank?: number;
  /** Explicit relative quality rank; larger is preferred. Neither rank is calibrated. */
  readonly qualityRank?: number;
  /** Known supported languages. Omit when unknown. */
  readonly languages?: readonly string[];
}

export interface BackendRouterOptions {
  readonly hints?: Readonly<Record<string, BackendRoutingHint>>;
  /** A host may provide known availability; the engine still performs live health checks. */
  readonly availability?: Readonly<Record<string, BackendHealth>>;
}

export interface BackendRouteEntry {
  readonly backendIndex: number;
  readonly backendId: string;
  readonly locality: "local" | "remote";
  readonly reasonCode: string;
}

export interface BackendRoutePlan {
  readonly requestId: string;
  readonly mode: BackendRoutingMode;
  readonly fallback: "none" | "permitted";
  readonly overrideBackendId?: string;
  readonly attempts: readonly BackendRouteEntry[];
  readonly skipped: readonly BackendRouteEntry[];
  readonly reasonCode: string;
}

interface Eligible {
  readonly entry: BackendRouteEntry;
  readonly originalIndex: number;
  readonly hint?: BackendRoutingHint;
}

function supports(
  request: DecisionRequest,
  capabilities: BackendCapabilities,
  bytes: number,
): boolean {
  return (
    capabilities.kinds.includes(request.kind) &&
    (capabilities.categories === undefined || capabilities.categories.includes(request.category)) &&
    (request.candidates?.length ?? 0) <= capabilities.maxCandidates &&
    bytes <= capabilities.maxInputBytes
  );
}

function remotePermitted(request: DecisionRequest): boolean {
  return (
    request.constraints.locality === "remote_allowed" &&
    request.dataClasses.every((dataClass) =>
      request.constraints.allowedRemoteData.includes(dataClass),
    )
  );
}

/** Plans routing without querying backends or changing the request's privacy constraints. */
export class BackendRouter {
  private readonly hints: Readonly<Record<string, BackendRoutingHint>>;
  private readonly availability: Readonly<Record<string, BackendHealth>>;

  constructor(options: BackendRouterOptions = {}) {
    this.hints = options.hints ?? {};
    this.availability = options.availability ?? {};
  }

  plan(request: DecisionRequest, backends: readonly DecisionBackend[]): BackendRoutePlan {
    const bytes = validateRequest(request);
    const preference = request.constraints.routing;
    const mode = preference?.mode ?? "auto";
    const fallback = preference?.fallback ?? (preference?.backendId ? "none" : "permitted");
    const skipped: BackendRouteEntry[] = [];
    const eligible: Eligible[] = [];
    const seen = new Set<string>();

    for (const [backendIndex, backend] of backends.entries()) {
      let capabilities: BackendCapabilities;
      try {
        capabilities = backend.capabilities;
      } catch {
        skipped.push({
          backendIndex,
          backendId: "invalid",
          locality: "local",
          reasonCode: "capabilities_unavailable",
        });
        continue;
      }
      if (!isBackendCapabilities(capabilities)) {
        skipped.push({
          backendIndex,
          backendId: "invalid",
          locality: "local",
          reasonCode: "invalid_capabilities",
        });
        continue;
      }
      const entry = (reasonCode: string): BackendRouteEntry => ({
        backendIndex,
        backendId: capabilities.id,
        locality: capabilities.locality,
        reasonCode,
      });
      seen.add(capabilities.id);
      if (!supports(request, capabilities, bytes)) {
        skipped.push(entry("unsupported_capability_or_size"));
        continue;
      }
      if (capabilities.locality === "remote" && !remotePermitted(request)) {
        skipped.push(entry("privacy_denied"));
        continue;
      }
      if (
        (mode === "local" && capabilities.locality !== "local") ||
        (mode === "remote" && capabilities.locality !== "remote")
      ) {
        skipped.push(entry("mode_excluded"));
        continue;
      }
      if (capabilities.locality === "remote" && preference?.networkAvailable === false) {
        skipped.push(entry("network_unavailable"));
        continue;
      }
      if (this.availability[capabilities.id] === "unavailable") {
        skipped.push(entry("known_unavailable"));
        continue;
      }
      const hint = this.hints[capabilities.id];
      if (
        preference?.language &&
        hint?.languages &&
        !hint.languages.some(
          (language) => language.toLowerCase() === preference.language?.toLowerCase(),
        )
      ) {
        skipped.push(entry("language_unsupported"));
        continue;
      }
      eligible.push({
        entry: entry(preference?.backendId === capabilities.id ? "explicit_override" : "eligible"),
        originalIndex: backendIndex,
        ...(hint === undefined ? {} : { hint }),
      });
    }

    const optimizeFor = preference?.optimizeFor ?? "none";
    eligible.sort((a, b) => {
      if (preference?.backendId) {
        const overrideDifference =
          Number(b.entry.backendId === preference.backendId) -
          Number(a.entry.backendId === preference.backendId);
        if (overrideDifference) return overrideDifference;
      }
      if (preference?.localPreference) {
        const localDifference =
          Number(b.entry.locality === "local") - Number(a.entry.locality === "local");
        if (localDifference) return localDifference;
      }
      if (optimizeFor === "latency") {
        const latencyDifference =
          (a.hint?.latencyRank ?? Number.POSITIVE_INFINITY) -
          (b.hint?.latencyRank ?? Number.POSITIVE_INFINITY);
        if (Number.isFinite(latencyDifference) && latencyDifference !== 0) return latencyDifference;
      }
      if (optimizeFor === "quality") {
        const qualityDifference =
          (b.hint?.qualityRank ?? Number.NEGATIVE_INFINITY) -
          (a.hint?.qualityRank ?? Number.NEGATIVE_INFINITY);
        if (Number.isFinite(qualityDifference) && qualityDifference !== 0) return qualityDifference;
      }
      return a.originalIndex - b.originalIndex;
    });

    let attempts = eligible.map((item) => item.entry);
    if (preference?.backendId) {
      if (!seen.has(preference.backendId)) {
        attempts = [];
      } else if (fallback === "none") {
        const primary = attempts.find((entry) => entry.backendId === preference.backendId);
        for (const item of attempts.filter((entry) => entry !== primary)) {
          skipped.push({ ...item, reasonCode: "fallback_disabled" });
        }
        attempts = primary ? [primary] : [];
      }
    } else if (fallback === "none") {
      for (const item of attempts.slice(1))
        skipped.push({ ...item, reasonCode: "fallback_disabled" });
      attempts = attempts.slice(0, 1);
    }

    return {
      requestId: request.id,
      mode,
      fallback,
      ...(preference?.backendId === undefined ? {} : { overrideBackendId: preference.backendId }),
      attempts,
      skipped,
      reasonCode:
        attempts.length > 0
          ? "route_available"
          : preference?.backendId
            ? "override_unavailable"
            : "no_permitted_backend",
    };
  }
}
