# ADR 0002: Deterministic retrieval before bounded inference

Status: Accepted for V1 architecture (2026-09-24).

## Context

Sending an entire repository to Laya/Jev is slow, costly, and increases privacy exposure. Model-based ranking of facts that parsers or dependency graphs answer exactly is wasteful. False-negative pruning can damage coding success.

## Decision

Use ignore-aware discovery, lexical/structural retrieval, and exact rules first. Feed only a bounded candidate set (initial target about 20–40) with short features into an evaluated ranking strategy. Return a small context set (initial target about 3–8) only when confidence and category policy permit. Preserve must-include candidates and expand/bypass on uncertainty. Do not add embeddings or a vector database by default.

## Consequences

The retrieval layer is independently testable and useful without any inference backend. Benchmarks must compare deterministic retrieval with inference; if the latter has no task-level benefit, it remains optional. Index staleness, symlink handling, and retrieval recall are correctness risks requiring explicit tests.
