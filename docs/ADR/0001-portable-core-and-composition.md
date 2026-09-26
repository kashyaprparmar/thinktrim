# ADR 0001: Portable core with host composition

Status: Accepted for V1 architecture (2026-09-24).

## Context

ThinkTrim must serve Claude Code, Codex, Cursor, and VS Code. Making the editor extension the engine would make the other three dependent on an optional UI and leak editor APIs into decision contracts.

## Decision

`@thinktrim/core` defines backend-neutral decision types and orchestration. `host-common` composes retrieval, ranker, policies, providers, cache, and telemetry. MCP and CLI use that composition; the VS Code extension uses it directly. Host-specific integration directories contain setup assets and checks. There is no separate VS Code integration package.

## Consequences

The CLI/MCP path works without VS Code. A one-way dependency graph and contract tests can enforce neutrality. `host-common` can become too broad, so keep it a thin composition/application layer and move domain behavior to its owning package. Named package boundaries do not force immediate publication as separate npm packages.
