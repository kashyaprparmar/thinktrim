# Step 34 — performance profile

Date: 2026-09-26. Mode: OPTIMIZE. Measurements use this Windows workspace and synthetic repositories. Wall times are single-run observations unless a p50/p95 sample count is shown. They are not release SLOs.

## Measurements

| Area                          | Workload and measurement                                                    | Result                                             | Interpretation                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code extension startup     | 15 module-load/activate runs, 165,844-byte bundle, minimal VS Code API shim | p50 1.37 ms, p95 14.44 ms                          | Isolated extension code only. The Extension Development Host was unavailable, so these are not actual editor startup times.           |
| Index cold                    | Generated 25 / 500 / 5,000 source files (plus `.gitignore`)                 | 71 / 795 / 8,852 ms                                | A 5,000-file cold index uses substantial CPU.                                                                                         |
| Index warm, unchanged refresh | Same generated fixtures                                                     | 44 / 825 / 8,854 ms                                | Refresh hashes and reads files to verify content. The largest case used 6,109 ms CPU for the cold index and 6,235 ms CPU for refresh. |
| Index searches                | 100 BM25 queries on each fixture                                            | 4 / 33 / 213 ms total                              | The 5,000-file case averaged about 2.13 ms per query.                                                                                 |
| Index memory                  | Process snapshot before work and after 5,000-file index plus refresh        | RSS 67.8 → 147.2 MB; heap 11.9 → 50.3 MB           | This is the benchmark process, including the retained index and search structures; not a VS Code host memory measurement.             |
| MCP startup                   | Spawned CLI stdio server and completed protocol initialization              | 485.56 ms, one sample                              | Includes process start and handshake.                                                                                                 |
| MCP cold context              | First tool call on a generated 100-file workspace                           | 296.74 ms, 2,312-byte result                       | Includes initial indexing, retrieval, and response serialization.                                                                     |
| MCP warm tools                | 30 context calls; 20 ranking calls                                          | context p50/p95 2.39/3.75 ms; ranking 5.11/6.74 ms | Includes stdio round trip and handler work, no model inference.                                                                       |
| MCP protocol baseline         | 30 status calls                                                             | p50/p95 0.69/1.20 ms                               | Client/server stdio round trip plus a small status handler.                                                                           |
| MCP client memory/CPU         | Entire synthetic session                                                    | RSS 65.7 → 71.0 MB; user/system CPU 63/47 ms       | Client process only. The separate MCP child-process RSS was not sampled.                                                              |
| Local sidecar cold start      | Node mock JSONL worker spawn and health handshake                           | 153.71 ms, one sample                              | Mock worker only; no Python interpreter or model loading.                                                                             |
| Local sidecar warm RPC        | 100 mock `predict` RPCs over one persistent worker                          | p50/p95 0.19/0.54 ms                               | Confirms the Node JSONL path and process reuse, not inference speed. Client RSS rose 2.1 MB during the sample.                        |
| Jev request                   | 25 mock fetches with 35 ms injected delay                                   | p50/p95 45.70/51.45 ms; request body 296 bytes     | About 11 ms median adapter overhead above the artificial delay. No network or Jev inference occurred.                                 |
| Decision cache                | 1,000 in-memory hits with WebCrypto SHA-256 keys                            | p50/p95 0.107/0.182 ms                             | Cache identity hashing is not a measured bottleneck in this workload.                                                                 |

The generated index fixture data is in the benchmark harness. Commands to reproduce the component profiles:

```sh
pnpm --filter @thinktrim/repo-indexer benchmark
pnpm --filter @thinktrim/mcp build
pnpm --filter thinktrim build
pnpm --filter @thinktrim/mcp exec node bench/profile.mjs
node benchmarks/performance-vscode-startup.mjs
node services/laya-sidecar/node/profile.mjs
node benchmarks/performance-providers.mjs
```

## Findings and changes

- **Repeated extension indexing was the main actionable bottleneck.** Before this step, each ranking command refreshed and re-read the full index, even if no file changed; concurrent first-use commands could each begin an index. On the large fixture an unchanged refresh took 8,854 ms and 6,235 ms CPU. VS Code now shares an in-flight workspace scan and keeps its snapshot until a VS Code file create/change/delete event invalidates it. This avoids a full verified refresh between commands when the workspace has not reported a file change. An invalidation during indexing causes a retry. Explicit indexer refresh still verifies all file contents.
- **Concurrent explicit MCP index refreshes could duplicate work.** MCP already shares its initial lazy index promise between ordinary context calls. Its explicit workspace refresh now also shares one in-flight refresh promise.
- **Unchanged model loads:** the mock sidecar test confirms one persistent worker across warm RPC calls. Laya itself is not installed, so model loading and real warm inference were not profiled.
- **Provider payloads:** the synthetic Jev request is 296 bytes and the 100-file MCP context response is 2,312 bytes. These fixture payloads do not indicate real task output distributions.
- **Concurrency:** local Laya requests pass through its existing single-worker gate. MCP index refresh is now coalesced. This profile did not measure provider service limits or simultaneous production host workloads.
- **Serialization and blocking:** the mock request/response sizes are small. The large index spends substantial CPU in reading, hashing, token extraction, and index construction. No parser or wire-format change was made without stage-level evidence separating those costs.

## Unmeasured paths and limits

- No `OPENROUTER_API_KEY` was present in the process environment, and this profile made no remote request. Live Jev network/model latency is not measured.
- The optional Laya package and model checkpoint are absent. Real Laya cold model load, warm inference, device utilization, and GPU memory are not measured.
- Extension startup ran with a small API shim, not VS Code. Editor activation and real VS Code process CPU/RSS need an Extension Development Host run.
- CPU/RSS observations are process snapshots around synthetic benchmarks; no per-stage profiler, sampled peak, operating-system thread profiler, or separate child-process memory sampler was used.
- The 5,000-file benchmark shows hashing every file on an explicit refresh is expensive. This is the cost of Step 33's protection against same-size edits with restored timestamps. The VS Code host avoids repeat refreshes until a file event; non-VS-Code callers that explicitly refresh still pay the verification cost.
- File watcher delivery is provided by VS Code and was typechecked/built, but not exercised in a live editor in this profiling step. Hosts should still use the explicit refresh operation when they need a fresh full index.

## Verification

- `pnpm --filter @thinktrim/repo-indexer benchmark` completed for all three fixture sizes and recorded cold index, search, unchanged refresh, CPU, and process memory.
- MCP stdio harness: one startup/cold-context sample plus 30 warm context and status calls and 20 ranking calls.
- Jev mock harness: 25 calls with a fixed 35 ms delay; cache harness: 1,000 hits.
- Sidecar mock harness: one cold start plus 100 warm RPC calls using the same process.
- VS Code module activation shim: 15 samples.
- MCP and VS Code extension typechecks/builds passed after the in-flight indexing and latency reporting changes. No test suite was run for Step 34.
