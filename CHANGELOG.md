# Changelog

All notable changes to ThinkTrim will be recorded here.

## Unreleased

- Add opt-in Jev advisory scoring to the MCP `thinktrim_rank` tool (`thinktrim mcp --decision-backend jev --allow-remote-data task,paths,summaries`, key from `OPENROUTER_API_KEY` only). Uncalibrated scores are reported separately and never reorder results. Failures, missing consent, and a missing key fall back to deterministic ranking with a visible reason. The published `thinktrim@0.1.0` does not include this.
- Audit V1 security boundaries, reject symlinked host/trace paths and common secret files, isolate Python sidecar imports, tighten Jev egress and keyed retries, escape VS Code path output, and upgrade Vitest to a patched release.
- Add synthetic decision evaluation and per-scope calibration readiness reports; keep confidence profiles provisional after two context pruning misses and a small Jev diagnostic. Correct the binary false-answer signal passed to calibrators.
- Add a four-arm coding-agent task benchmark harness with ten starter fixtures, isolated checkouts, host-reported token accounting, hidden grading, explicit provider skips, and a quota-free smoke mode.
- Add a local-only telemetry package with allowlisted decision traces, bounded atomic workspace writes, candidate/cache/escalation/usage metadata, and privacy regression tests.
- Fix the VS Code extension's strict lint/type checks and make Laya local shutdown drain already accepted queued predictions.
- Add a bundleable VS Code extension foundation with workspace settings, encrypted SecretStorage credentials, output logging, backend connectivity, and a status bar.
- Add the ThinkTrim VS Code commands and native Explorer metrics view for deterministic context ranking, selection analysis, session trace, backend setup/testing, cache controls, and diagnostics; mark all token estimates clearly.
- Scope Cursor's project MCP server to its documented `${workspaceFolder}` variable, test safe merge and uninstall behavior, and document current extension distribution paths.
- Scope Codex MCP setup to the trusted project's `.codex/config.toml` with an explicit workspace and working directory; verify safe TOML merge, idempotence, and uninstall behavior.
- Scope Claude Code MCP retrieval to its documented project directory, and verify safe project `.mcp.json` merge, idempotence, and uninstall behavior.
- Upgrade the MCP server to the current TypeScript SDK v2 and add context, rank, sufficiency gate, and failure classification tools with compact validated schemas and stdio protocol coverage.
- Add the universal `thinktrim` CLI and MCP stdio server, including workspace initialization/indexing, diagnostics, status, traces, benchmark, and safe Claude/Codex/Cursor/VS Code setup and uninstall with dry-run support.
- Add an opt-in workspace-scoped decision cache with SHA-256 semantic keys, repository-state gating, TTL/LRU, invalidation, and hit/miss counters.
- Add bounded local Laya HTTP concurrency, explicit sidecar batch prediction up to 16 requests, and process-local queue, inference, and batch metrics.
- Add provisional safe, balanced, and aggressive confidence profiles with decision-kind, category, and risk floors; require an explicitly scoped calibrator before any backend prediction can be accepted.
- Add inspectable `BackendRouter` plans, explicit routing modes and overrides, capability/privacy checks, optional preference hints, and configured failover through the core engine.
- Add deterministic `RetryPolicy` with attempt limits, idempotency and side-effect guards, capped backoff, and optional inference only after safety checks.
- Add `FailureClassificationPolicy` with normalized bounded terminal diagnostics, deterministic category matching, and optional inference over extracted evidence only.
- Add deterministic `TestSelectionPolicy` candidate generation from changed files, git diff names, test conventions, import edges, and package boundaries; optional ranking only reorders candidates and full CI remains required.
- Add `ContextSufficiencyPolicy` with evidence tracking, explicit coverage, conservative confidence gating, and false-positive regression tests.
- Implement `ContextRankingPolicy` with a deterministic baseline, optional bounded grouped scoring through `DecisionEngine`, conservative fallback, calibrated-confidence handling, adversarial fixtures, and strategy benchmarks.
- Add deterministic candidate generation that combines lexical, symbol, dependency, and dependent signals into compact metadata-only candidates, capped at 40.
- Add an ignore-aware repository indexer with file metadata, best-effort symbols/imports, local dependency links, BM25 retrieval, incremental refresh, tests, and synthetic benchmarks.
- Add a shared bounded System One HTTP transport and typed request/response mapping reused by Jev, Laya HTTP, and the Laya sidecar adapter.
- Implement `LayaHTTPBackend` for loopback Laya servers with optional bearer auth, health checks, checkpoint selection, deadlines, local endpoint validation, and shared response/usage validation.
- Implement authenticated OpenRouter `JevBackend` using `typesafe/jev-1.13`, with request/privacy validation, structured errors, bounded responses, and retries restricted to transient statuses, selected timeouts, and connection resets.
- Integrate `LayaLocalBackend` with the persistent sidecar, including serialized concurrency, language/model/device options, optional preload, response validation, and shutdown.
- Add the persistent Laya Python JSONL sidecar, Node process supervisor, mocked lifecycle tests, and gated real-model smoke test.
- Add provider wire and transport contracts for Laya local/HTTP and Jev, plus provider contract fixtures and API boundary documentation.
- Add shared candidate IDs, typed core decision contracts, backend-neutral orchestration, validation, cancellation, and a fake backend with contract tests.
- Add initial pnpm/TypeScript monorepo and Python sidecar scaffolding.
- Add CI checks for linting, type checking, unit tests, and builds.
