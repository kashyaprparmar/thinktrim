# Contributing

Thanks for helping build ThinkTrim. Before a change, read [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md), [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md), and the relevant architecture or ADR documents. Keep changes within the current implementation step and update the status handoff when completing a step.

## Development

Install dependencies with `pnpm install`. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before submitting TypeScript changes. For the Python sidecar, run the Ruff, mypy, and pytest commands in the README from `services/laya-sidecar`.

Keep `packages/core` independent of host SDKs and provider implementations. Prefer deterministic answers where they are exact. Do not add source content or credentials to logs or telemetry. Verify current official host/provider APIs before implementing integrations.

## Pull requests

Describe the behavior and architecture boundary affected, tests/checks run, and any privacy, compatibility, or measurement implications. Do not claim token savings without measured evidence and a comparable task baseline.
