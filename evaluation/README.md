# Decision evaluation

`pnpm evaluate:decisions` runs the current deterministic policies over labeled synthetic cases. The datasets cover context relevance, context sufficiency, test relevance, failure classification, and retry safety. The JSON report is written to `evaluation/results/step30.json`.

Context relevance combines the existing Step 11 regression fixtures with two later adversarial pruning cases. The latter deliberately hide a required implementation behind a neutral path. The report lists every relevant file omitted from the top three separately from precision, recall, F1, MRR, nDCG@3, and top-three recall. Test relevance uses a small real repository index with test imports and changed-file signals.

Sufficiency evaluates whether the gate would **stop** searching. False-positive `sufficient` is the highest-risk error; `uncertain` remains a continuing-search result. Retry evaluation records unsafe automatic retries separately. Failure classification reports accuracy, macro F1, and per-class precision and recall.

These are hand-labeled synthetic regression fixtures. Some ranking cases influenced the implementation, so the results are not held-out model quality estimates. The policies do not emit calibrated probabilities in this run; Brier score and ECE are `null`, not zero. Use separately labeled provider outputs and independent held-out judgments before calibration.

## Calibration audit

`pnpm evaluate:calibration` reads the Step 30 report and optional `evaluation/results/step31-jev-diagnostic.json`, then writes `evaluation/results/step31.json`. The audit reports readiness separately for context ranking, sufficiency, test relevance, failure classification, and retry. It shows all three current profile thresholds per scope as **provisional**. The audit does not promote a profile or alter production thresholds.

The optional `node evaluation/collect-jev.mjs` sends at most eight synthetic sufficiency cases to Jev when `OPENROUTER_API_KEY` is set. The resulting file contains IDs, labels, numeric provider signals, and usage counts, without the key or request text. The first run produced eight responses. Seven have binary gold labels: five matched and two sufficient cases were predicted insufficient. The remaining gold label is `uncertain` and is excluded from binary accuracy and calibration metrics. Raw predicted-label confidence on the seven binary cases had Brier score 0.232 and ECE 0.197 in five bins. `node evaluation/collect-jev.mjs --recompute` refreshes the summary from the saved observations without another provider request. This is a diagnostic on small, previously authored synthetic cases, not held-out calibration evidence.

Promotion requires independently labeled provider observations for the exact backend/model/category/kind, separate fitting and held-out validation sets, enough positive and negative cases to measure the relevant error cost, and a review of false-positive sufficiency, context misses, and unsafe retries. The current audit uses a provisional floor of 200 scoped observations and 30 of each binary label as an evidence screen; these counts are not calibrated thresholds or guarantees. Until the evidence exists, `safe` remains the operational default, while `balanced` and `aggressive` stay opt-in and provisional.
