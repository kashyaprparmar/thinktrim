# ADR 0004: Persistent Laya sidecar and explicit remote egress

Status: Accepted for V1 architecture (2026-09-24).

## Context

Laya is the privacy-first local option; Jev is hosted. Starting Python for every decision would add avoidable latency. Failing from local to remote without an explicit choice could upload repository-derived content unexpectedly.

## Decision

Use a persistent, locally scoped Python sidecar for Laya through supported public APIs, with versioned health/capability/predict/batch/shutdown messages and bounded lifecycle controls. Keep Jev authentication and endpoint behavior in the Jev adapter. Local-only is the default; remote failover requires explicit configuration and request-level allowed data classes. Do not bundle multi-GB weights.

## Consequences

Sidecar crashes and model-load failures need recovery and safe bypass. Packaging must document separately installed runtime/model requirements. Exact Laya and Jev API bindings remain an implementation-time verification item; this ADR does not claim that their APIs are compatible.
