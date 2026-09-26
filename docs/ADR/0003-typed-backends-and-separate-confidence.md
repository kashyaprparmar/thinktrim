# ADR 0003: Typed backend contract and separate confidence policy

Status: Accepted for V1 architecture (2026-09-24).

## Context

Laya and Jev may differ in transport, output shape, and probability semantics. A shared ranking algorithm must not know their classes, and an uncalibrated maximum probability must not authorize pruning or retry.

## Decision

Backends implement `DecisionBackend` and advertise `BackendCapabilities`: decision kinds/categories, limits, locality, batching, cancellation, and version. Providers translate their outputs into validated typed predictions. `DecisionPolicy` handles exact/safety rules; `ConfidencePolicy` handles category-specific acceptance using calibrated evidence. The engine routes by capability and explicit locality policy. Raw backend signals remain distinct from published confidence.

## Consequences

A new provider does not require ranking changes. Provider adapters bear their own parsing and transport complexity. Until calibration exists, conservative bypass/expansion is the default. Category schemas and capability versions must be maintained carefully.
