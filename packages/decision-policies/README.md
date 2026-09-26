# Decision policies

## Confidence profiles

`ProfileConfidencePolicy` implements the core `ConfidencePolicy` contract. `thresholdFor()` exposes the effective threshold and always labels it `status: "provisional"`. The `safe`, `balanced`, and `aggressive` profiles use distinct starting floors for binary, choice, score, and ranking decisions. Category floors for context sufficiency, context ranking, failure classification, and retry gating, plus risk floors, can only raise the effective threshold. These numbers are initial policy settings, not benchmark-calibrated operating points.

With no matching calibrator, a backend prediction has `confidence: null` and cannot be accepted, however large its `rawSignal` is. Context decisions request more retrieval; other decisions return `unknown`. An optional `ConfidenceCalibrator` must match the exact backend ID, model version, category, and decision kind. Its registration records a held-out dataset ID, evaluation run, sample count, and calibrator version; the caller must verify the quality of that evidence. Invalid or throwing calibrators fail conservatively. A matched calibrator maps the provider signal to an estimated probability of correctness, and only then is the provisional profile threshold applied. Exact deterministic policy decisions may be accepted with `confidence: null`.

`ContextSufficiencyPolicy` checks whether retrieved context can justify stopping search. Its caller supplies short, identified evidence summaries, the IDs of evidence known to be required, and any open questions. The result preserves evidence IDs, sources, and fingerprints without copying summaries.

The gate returns `insufficient` for missing required evidence or open questions. It returns `uncertain` when coverage has not been established, the engine fails, or its binary decision is unaccepted, uncalibrated, or below `minimumConfidence` (default `0.95`). Both states set `continueSearch: true`. Only an accepted backend decision with calibrated confidence above the floor can return `sufficient` and set `continueSearch: false`.

The default request is local-only. Callers must explicitly permit both `task` and `summaries` for remote inference. Evidence summaries may contain repository-derived data; the caller must classify and permit that egress. The caller is also responsible for ensuring fingerprints reflect the current repository state and for identifying required evidence. The confidence floor is a conservative guard, not an empirically calibrated quality claim. Without a calibrated `ConfidencePolicy`, the gate continues search.

## Test selection

`TestSelectionPolicy.select(index, input)` builds a deterministic test shortlist from changed paths, optional `git diff --name-only -z` output, test filename conventions, resolved imports/dependents, and nearest `package.json` boundaries. Same-package tests provide a bounded fallback when no direct edge or naming match exists. An optional `ContextRankingPolicy` may rerank this list only; its output cannot add or remove tests. Every result has `alwaysRunFullCi: true` because the shortlist is supplemental.

## Failure classification

`FailureClassificationPolicy.classify(input)` normalizes ANSI/control characters and line endings, bounds input size, and extracts exit code, error type, stack frames, relevant tail lines, and test name. Deterministic signatures classify common failures first. Only an otherwise unknown failure may use an injected `DecisionEngine`; it receives the extracted fields, not the complete terminal log. Backend classifications require an accepted, calibrated result above the confidence floor. Failures and uncertain results become `unknown`.

## Retry gate

`RetryPolicy.evaluate(input)` only considers `network_error`, `timeout`, and `rate_limit` failures. It stops before inference for completed or unknown previous results, exhausted attempts, destructive or unknown operations, high side-effect risk, and operations without proven idempotency. Keyed operations must provide the same key used by the prior attempt. An optional engine can approve or veto retries inside this safe set; uncertain engine output falls back to the deterministic safe decision. The policy returns a recommendation and delay and never executes the operation.
