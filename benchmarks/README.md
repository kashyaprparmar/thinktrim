# Task benchmark harness

This harness compares one coding agent across four context conditions on identical, isolated task fixtures:

- **A:** agent alone.
- **B:** deterministic repository retrieval and ranking, with six metadata-only file hints.
- **C:** B plus experimental Laya local score ordering of up to 16 candidates.
- **D:** B plus experimental Jev score ordering of up to 16 candidates.

The ten task categories are listed in `tasks.json`. Each trial receives a fresh temporary Git checkout from the same fixture. Arm order is shuffled with a recorded seed. The default is **one task and four trials**; `--max-trials` must be raised explicitly for a larger run. The synthetic large-repository task creates 300 unrelated modules only when selected.

## Commands

Run from the repository root:

```sh
pnpm benchmark:tasks plan
pnpm benchmark:tasks smoke
pnpm benchmark:tasks run --tasks bug-fix --arms A,B --model MODEL_ID
pnpm benchmark:tasks run --tasks all --arms A,B,C,D --max-trials 40 --allow-laya --allow-remote --model MODEL_ID
```

`plan` makes no model calls. `smoke` runs all four arms with a fixture agent and fixture scorer, so it tests the harness without consuming frontier or provider quota. `run` invokes the installed Codex CLI with `--approve-for-me` in each temporary checkout. It can consume frontier quota. C requires `--allow-laya` and a usable, preloaded local Laya model; D requires `--allow-remote` and `OPENROUTER_API_KEY` in the process environment. Unavailable provider arms are recorded as **skipped**, with no silent substitution. Runs write JSON reports under ignored `benchmarks/results/`; use `--output PATH` to choose another location.

## Measurements

Each record includes task success, public test result and counts, independent hidden behavior check, patch correctness, frontier input/output/total tokens, agent turns, observed file-read and search commands, tool calls, task wall time, retrieval time, decision latency, and decision-backend usage. Codex usage comes only from `turn.completed.usage`. Missing usage stays `null`; the smoke agent never fabricates frontier tokens. Read and search counts classify observed command events, so they are **command counts**, not exact numbers of files opened or terms searched. Wall time covers context preparation and the agent run, excluding fixture creation and grading. Live runs require an explicit `--model` so paired arms use the same model.

The primary aggregate is **frontier tokens per successful task**: all measured frontier tokens spent on attempted runs, including failures, divided by successful tasks. It is unavailable if any attempted run in that arm lacks measured usage, a harness error occurred, or no task succeeded. Report success rate beside it. Decision-backend units are never subtracted from frontier tokens.

C and D use raw provider scores only for **experimental benchmark ordering**. The result is labeled `experimentalUncalibrated`; no calibrated confidence or production sufficiency decision is inferred. Candidate hints never prevent the agent from searching further. Jev receives only the synthetic task and compact path/symbol/import metadata when remote inference is explicitly enabled.

These fixtures are a reproducible starting set, not a statistical claim about real repository performance. Do not report savings from the quota-free smoke or from a comparison where an arm was skipped. A larger evaluation should use matched real tasks, repeated seeds, held-out quality review, and the same agent/model/tool budget across arms.

## Initial one-task run

On the `bug-fix` fixture with Codex `gpt-6-luna`, one successful run per arm reported **90,805 frontier tokens for A**, **92,301 for B**, and **91,460 for D**. All three passed the public test and hidden patch check. D used `typesafe/jev-1.13` for one metadata-only score request (1,183 input and 34 output decision-backend tokens; 846 ms decision latency). C was skipped because `--allow-laya` was not enabled; no preloaded local model has been verified. These single-task measurements show no token saving over A and cannot establish task-level performance. The raw local JSON reports are in `benchmarks/results/step29-codex-small.json` and `benchmarks/results/step29-laya-unavailable.json`.
