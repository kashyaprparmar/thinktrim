# Context ranker

`generateCandidates(index, query)` runs before model ranking. It combines BM25 file hits and symbol hits, then adds a bounded number of direct dependencies and dependents from the strongest seed files. It returns up to 30 candidates by default and never more than 40. Small workspaces may produce fewer.

The returned `candidates` contain only core decision fields, so they can be placed directly in a `DecisionRequest`. Each has a stable path-derived ID, a short label containing its path, symbols, imports, and matched terms, compact features, and a content fingerprint. Labels are capped at 512 characters to fit core validation. Local `details` provide pre-ranking score and signal provenance keyed by candidate ID. Source text is not read or copied by candidate generation.

```ts
import { generateCandidates } from "@thinktrim/context-ranker";

const result = generateCandidates(index, "JWT refresh expiration", {
  maxCandidates: 30,
});
```

`ContextRankingPolicy` accepts the generated `details`, the task, changed paths, and short current-evidence summaries. It returns every candidate in ranked order with a bounded relevance signal and score provenance. Deterministic ranking is the V1 default; its `confidence` is `null` because heuristic relevance is not calibrated probability.

```ts
import { ContextRankingPolicy } from "@thinktrim/context-ranker";

const policy = new ContextRankingPolicy();
const ranking = await policy.rank({
  task: "JWT refresh expiration",
  candidates: result.details,
  changedFiles: ["src/auth/jwt.ts"],
  currentEvidence: ["Refresh flow uses session tokens"],
});
```

An injected `DecisionEngine` can be used with `{ strategy: "score" }`. The policy sends at most 16 metadata-only candidates per score request, uses one total deadline, and requires the engine to accept every group with calibrated confidence from the same backend. Otherwise it returns the full deterministic ordering with `confidence: null`. Remote routing remains subject to the request's explicit `locality` and `allowedRemoteData` settings.

`pnpm --filter @thinktrim/context-ranker benchmark` compares deterministic, binary, score, small-choice, pairwise, and listwise ranking on seven adversarial labeled fixtures and one 32-candidate shortlist. With gold labels used as an oracle, all approaches reached NDCG@3 of 1.0 on these fixtures. Total simulated request counts were 0, 60, 9, 15, 538, and 9 respectively. Listwise is not supported by the current provider adapters; pairwise has no native adapter and would need repeated choice requests. These fixture results measure strategy information and request budgets, not model accuracy, latency, or calibration. They support the deterministic default and grouped score as the optional provider strategy.
