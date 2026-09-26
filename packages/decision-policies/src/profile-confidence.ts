import type {
  BackendIdentity,
  ConfidenceAssessment,
  ConfidencePolicy,
  ConfidenceProfile,
  DecisionKind,
  DecisionRequest,
  DecisionRisk,
  BackendPrediction,
} from "@thinktrim/core";

/** These starting values are policy choices, not measured operating points. */
export const PROVISIONAL_THRESHOLDS: Readonly<
  Record<ConfidenceProfile, Readonly<Record<DecisionKind, number>>>
> = {
  safe: { binary: 0.98, choice: 0.97, score: 0.96, ranking: 0.97 },
  balanced: { binary: 0.95, choice: 0.93, score: 0.91, ranking: 0.93 },
  aggressive: { binary: 0.9, choice: 0.87, score: 0.85, ranking: 0.87 },
};

const CATEGORY_FLOORS: Readonly<Record<string, Readonly<Record<ConfidenceProfile, number>>>> = {
  context_sufficiency: { safe: 0.995, balanced: 0.98, aggressive: 0.95 },
  context_ranking: { safe: 0.98, balanced: 0.94, aggressive: 0.89 },
  failure_classification: { safe: 0.98, balanced: 0.94, aggressive: 0.89 },
  retry_gate: { safe: 0.995, balanced: 0.98, aggressive: 0.95 },
};

const RISK_FLOORS: Readonly<Record<DecisionRisk, Readonly<Record<ConfidenceProfile, number>>>> = {
  low: { safe: 0, balanced: 0, aggressive: 0 },
  medium: { safe: 0.98, balanced: 0.95, aggressive: 0.9 },
  high: { safe: 0.995, balanced: 0.98, aggressive: 0.95 },
};

export interface ProvisionalThreshold {
  readonly value: number;
  readonly status: "provisional";
  readonly profile: ConfidenceProfile;
  readonly kind: DecisionKind;
  readonly category: string;
  readonly risk: DecisionRisk;
}

export interface CalibrationEvidence {
  /** Identifier of the held-out evaluation dataset, distinct from training data. */
  readonly datasetId: string;
  readonly evaluationRunId: string;
  readonly sampleCount: number;
  readonly calibratorVersion: string;
}

export interface ConfidenceCalibrator {
  readonly backendId: string;
  readonly modelVersion: string;
  readonly category: string;
  readonly kind: DecisionKind;
  readonly evidence: CalibrationEvidence;
  /** Maps the signal for the emitted value to estimated P(correct) for this exact scope.
   * Binary P(true) is complemented when the emitted value is false. */
  readonly mapSignal: (rawSignal: number) => number | null;
}

function calibrationKey(
  backendId: string,
  modelVersion: string,
  category: string,
  kind: DecisionKind,
): string {
  return JSON.stringify([backendId, modelVersion, category, kind]);
}

function inspectableId(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function conservativeOutcome(category: string): "retrieve_more" | "unknown" {
  return category === "context_sufficiency" || category === "context_ranking"
    ? "retrieve_more"
    : "unknown";
}

/**
 * Confidence foundation: thresholds are provisional, and no provider signal is
 * accepted until a scoped, externally validated calibrator is supplied.
 */
export class ProfileConfidencePolicy implements ConfidencePolicy {
  private readonly calibrators: ReadonlyMap<string, ConfidenceCalibrator>;

  constructor(calibrators: readonly ConfidenceCalibrator[] = []) {
    const indexed = new Map<string, ConfidenceCalibrator>();
    for (const calibrator of calibrators) {
      const { backendId, modelVersion, category, kind, evidence, mapSignal } = calibrator;
      if (
        ![backendId, modelVersion, category].every(inspectableId) ||
        !["binary", "choice", "score", "ranking"].includes(kind) ||
        ![evidence.datasetId, evidence.evaluationRunId, evidence.calibratorVersion].every(
          inspectableId,
        ) ||
        !Number.isSafeInteger(evidence.sampleCount) ||
        evidence.sampleCount < 1 ||
        typeof mapSignal !== "function"
      ) {
        throw new TypeError("Invalid calibration record");
      }
      const key = calibrationKey(backendId, modelVersion, category, kind);
      if (indexed.has(key)) throw new TypeError("Duplicate calibration scope");
      indexed.set(key, calibrator);
    }
    this.calibrators = indexed;
  }

  thresholdFor(input: {
    readonly profile: ConfidenceProfile;
    readonly kind: DecisionKind;
    readonly category: string;
    readonly risk: DecisionRisk;
  }): ProvisionalThreshold {
    const { profile, kind, category, risk } = input;
    const byKind = PROVISIONAL_THRESHOLDS[profile]?.[kind];
    const byRisk = RISK_FLOORS[risk]?.[profile];
    if (byKind === undefined || byRisk === undefined || !inspectableId(category)) {
      throw new TypeError("Invalid threshold scope");
    }
    const byCategory = CATEGORY_FLOORS[category]?.[profile] ?? 0;
    return {
      value: Math.max(byKind, byCategory, byRisk),
      status: "provisional",
      profile,
      kind,
      category,
      risk,
    };
  }

  assess<K extends DecisionKind>(input: {
    readonly request: DecisionRequest<K>;
    readonly prediction: BackendPrediction<K>;
    readonly deterministic: boolean;
    readonly risk: DecisionRisk;
    readonly backend?: BackendIdentity;
  }): ConfidenceAssessment {
    if (input.deterministic) {
      return {
        outcome: "accept",
        confidence: null,
        calibrated: false,
        reasonCode: "exact_deterministic",
      };
    }
    const { request, prediction, backend } = input;
    const unavailable: ConfidenceAssessment = {
      outcome: conservativeOutcome(request.category),
      confidence: null,
      calibrated: false,
      reasonCode: "calibration_unavailable",
    };
    if (backend === undefined || prediction.rawSignal === undefined) return unavailable;
    const calibrator = this.calibrators.get(
      calibrationKey(backend.id, backend.modelVersion, request.category, request.kind),
    );
    if (!calibrator || !Number.isFinite(prediction.rawSignal)) return unavailable;

    const selectedSignal =
      prediction.value.kind === "binary" && !prediction.value.value
        ? 1 - prediction.rawSignal
        : prediction.rawSignal;
    let confidence: number | null;
    try {
      confidence = calibrator.mapSignal(selectedSignal);
    } catch {
      return unavailable;
    }
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      return unavailable;
    }
    const threshold = this.thresholdFor({
      profile: request.constraints.profile,
      kind: request.kind,
      category: request.category,
      risk: input.risk,
    });
    return {
      outcome: confidence >= threshold.value ? "accept" : conservativeOutcome(request.category),
      confidence,
      calibrated: true,
      reasonCode:
        confidence >= threshold.value ? "provisional_threshold_met" : "provisional_threshold_unmet",
    };
  }
}
