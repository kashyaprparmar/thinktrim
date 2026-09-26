# Token savings and evaluation model

Status: measurement plan. No savings are claimed until instrumented experiments show them with comparable task quality.

## What can be saved

The strongest mechanism is reducing context **before** a frontier host reads it. Let `C_base` be frontier input tokens in a comparable host-only run, `C_tt` frontier input tokens with ThinkTrim, `O_base` and `O_tt` frontier output tokens, and `D_tt` decision-backend usage. Report each separately. A context reduction estimate may be `C_base - C_tt` only for paired runs or an explicitly labeled simulated baseline. Selected-file count or bytes alone are not token savings.

Primary metric: **frontier tokens per successful task**. Also report task success, tests passing, file-read and search counts, tool calls, agent turns, latency, decision-backend usage/cost, and total cost per successful task. If success differs materially, report the quality difference before a savings percentage. Report confidence intervals across tasks/repetitions rather than a single attractive example.

## Measurement classes

| Label | Meaning | Display rule |
| --- | --- | --- |
| `measured_frontier` | Usage returned by host or provider for an actual run, with provenance and scope. | Show as measured; never infer missing turns. |
| `estimated_frontier` | Approximation from observed prompts/context when host usage is unavailable. | Show method, uncertainty, and coverage. |
| `simulated_baseline` | Counterfactual from replay/estimator, not an actual host run. | Keep separate from measured results. |
| `decision_backend` | Laya/Jev calls, units, latency, and cost. | Include in total cost/latency; do not subtract from frontier tokens. |

The event schema includes host, category, backend ID, stage timings, candidate counts, cache hit, action, measured usage if available, and `pre_read | post_read | unknown` placement. Events omit raw task/source by default. A `post_read` pruning call cannot claim pre-read context savings.

Step 27 implements a local metadata trace schema. Decision-backend units and optionally supplied, host/provider-reported frontier token counts are separate fields. The trace does not calculate savings or infer missing frontier usage. Hosts have to explicitly call the trace writer; absence of a saved record is not evidence that a decision or file read did not occur.

## Benchmark design

Run matched tasks across four arms: A host alone, B host plus deterministic retrieval, C B plus Laya, D B plus Jev. Keep task prompts, repository commits, host/model settings, time budgets, and tool availability as comparable as possible; randomize arm order and record deviations. Cover bug fixes, small features, multi-file work, refactors, tests, dependency/configuration issues, navigation, ambiguity, and large repositories. Include local-only and remote-allowed cohorts separately.

Step 29 adds `benchmarks/` with ten synthetic task fixtures, isolated temporary checkouts, four arms, explicit provider skips, a quota-free smoke mode, and Codex JSONL usage capture. C/D score ordering is experimental and labeled uncalibrated. The default run is one task and four arms; a larger run requires an explicit trial cap. The JSON report computes frontier tokens per successful task only from host-reported usage and includes failed attempts in the numerator. No savings claim follows from the synthetic smoke run.

The first live `bug-fix` fixture used the same Codex `gpt-6-luna` model for A, B, and D, with one successful trial per arm. Host-reported frontier totals were 90,805, 92,301, and 91,460 tokens, respectively. D additionally consumed 1,183 input and 34 output Jev tokens. C was skipped because local Laya inference was not enabled for this run; no preloaded model has been verified. This small sample provides no evidence of savings; repeated tasks and quality review are required before comparing the arms.

Decision-level metrics: top-k recall and context false-negative rate first, then precision, MRR/nDCG, Brier score and ECE where calibrated scores exist. Track false-positive sufficiency rate and unsafe retry recommendation rate as release gates. Task-level quality must remain comparable to the baseline; thresholds should be set on a held-out dataset before tuning policies.

## Decision criteria

Promote inference as a default only if it improves task-level frontier usage or cost without unacceptable quality or latency regression relative to deterministic retrieval. Compare total cost and success, not only input-token reduction. If host orchestration cannot call ThinkTrim before broad reads, report the measured effect for that integration honestly and prioritize other bounded decisions rather than attributing invisible savings.
