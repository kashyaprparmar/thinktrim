# ADR 0005: Measure task quality before claiming savings

Status: Accepted for V1 architecture (2026-09-24).

## Context

Selected-file counts and simulated baselines can make a tool look efficient while coding success declines. MCP does not guarantee the agent calls ThinkTrim before reading files.

## Decision

Label actual frontier usage, estimates, simulated baselines, and decision-backend usage separately. Track call placement (`pre_read`, `post_read`, `unknown`) and primary outcome as frontier tokens per successful task. Compare matched host-only, deterministic retrieval, retrieval plus Laya, and retrieval plus Jev arms. Promote inference only with measured quality and efficiency gains.

## Consequences

Instrumentation and benchmarks are part of V1, not polish. Some hosts may yield little measurable pre-read savings; the product must report that rather than infer hidden savings. Decision-level recall, sufficiency errors, and unsafe retry recommendations are release gates.
